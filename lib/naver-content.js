// 초안 HTML → 네이버 에디터 블록 배열.
//
// 예전 구현은 `--blocks` 수동 JSON을 받았고, 없으면 HTML 전문을 문단 텍스트로
// 타이핑했다. `<figure style=...>` 태그가 본문에 그대로 찍히는 구조였다.
//
// Phase 3의 lib/html-parse.js를 재사용한다. 새 의존성을 넣지 않고, 관대한
// 파서가 조용히 복구하는 문제도 피한다. 그 위에 **화이트리스트 + throw**를
// 얹어 허용 밖 요소를 조용히 버리지 않는다.
//
// ## 출력 계약 — 에디터 조작 레이어(lib/naver-editor.js)가 지켜야 할 것
//
// - `paragraph.text` / `heading.text`의 `'\n'`은 **하드 개행**이다 (소스의 `<br>`).
//   같은 블록 안의 줄바꿈이므로 새 문단이 아니라 Shift+Enter로 넣어야 한다.
//   Enter로 넣으면 문단 수가 달라지고, 그대로 `type()`에 넘기면 Playwright가
//   Enter로 해석해 역시 문단이 쪼개진다. 소스의 줄바꿈은 이 단계에서 이미 공백으로
//   접혔으므로, 남아 있는 `'\n'`은 **전부** 의도된 것이다.
// - `image.alt` / `image.caption` / `image.src`에는 `'\n'`이 없다 (singleLine).
//   에디터의 한 줄 입력 필드에 그대로 넣을 수 있다.
// - 모든 텍스트에 보이지 않는 문자(Cc/Cf)가 없고, 엔티티는 정확히 한 번 디코드됐다.
//   에디터에 넣기 전에 다시 디코드하거나 정규화하면 안 된다.

const fs = require('fs');
const path = require('path');
const {
  parseHtml, findAll, getAttr, elementChildren,
} = require('./html-parse');
const { decodeEntities } = require('./korean-text');
const { NAVER_EXIT, NaverError } = require('./naver-errors');

// prompts/blog-draft.md가 생성하는 요소만 허용한다.
const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'figure', 'ul', 'ol']);
// 순수 컨테이너. 자기 자신은 블록이 아니고 자식을 블록으로 펼친다.
const CONTAINER_TAGS = new Set(['div', 'section', 'article']);
const INLINE_TAGS = new Set(['a', 'strong', 'b', 'em', 'i', 'br', 'span', 'code', 'u']);
const LIST_ITEM_TAGS = new Set(['li']);
const FIGURE_CHILD_TAGS = new Set(['img', 'figcaption']);

// 인라인 조각을 최종 문자열로 정리한다.
//
// **raw와 최종본을 한 버퍼에 섞지 않는다.** 예전에는 재귀가 문자열 하나를
// 누적하면서 일부 조각(<a> 라벨, href)만 따로 최종화했고, 그 때문에 같은
// 텍스트가 위치에 따라 다르게 디코드되는 버그가 라운드마다 되살아났다.
// 이제 재귀는 **조각 배열**을 돌려준다:
//   {t:'raw', v}      소스 문자열. 디코드·제어문자 제거·공백 접기 대상.
//   {t:'br'}          하드 개행. 소스 줄바꿈과 구별되는 유일한 줄바꿈.
//   {t:'literal', v}  이미 최종 형태. **다시 디코드하지 않는다.**
// 'literal'이 있어야 href를 본문과 links[]에 같은 값으로 넣으면서도
// 이중 디코드를 피할 수 있다.

// 눈에 보이지 않는 문자를 **코드포인트 구간이 아니라 유니코드 카테고리로** 지운다.
//
// 구간 열거(`\u0000-\u0008` …)로 두면 근거는 "보이지 않는다 + 에디터 페이로드에
// 실린다"인데 판정은 "내가 적어둔 구간에 있나"가 되어, 같은 근거가 그대로 적용되는
// 문자가 계속 새로 발견된다 (NUL만 → C0 전체 → 이제 Cf). 실제로 새던 것들:
//   ZWSP U+200B · ZWNJ/ZWJ U+200C-D · WJ U+2060 · SHY U+00AD · BOM U+FEFF ·
//   LRM/RLM/LRO/RLO U+200E-F,U+202A-E · isolate U+2066-9 · tag U+E0001
// 그중 U+202E(RLO)는 이후 문단 전체를 시각적으로 역전시키는 bidi 스푸핑 문자이고,
// 발행된 글에서 그대로 작동한다. BOM은 \s에 걸려 공백이 되어 처리가 또 달랐다.
//
// Cc(제어) + Cf(포맷) = "그래픽 표현이 없는 문자"가 정확한 대상이다.
// \t \n \v \f \r은 Cc지만 남긴다 — 아래 공백 접기가 한 칸으로 만든다.
// (BR_SENTINEL은 이 함수보다 먼저 쪼개지므로 여기 오는 NUL은 `&#0;` 디코드 산물뿐이다.)
const CONTROL_CHARS_RE = /(?![\t\n\v\f\r])[\p{Cc}\p{Cf}]/gu;

// 소스 조각 하나. 디코드는 **정확히 한 번**이다.
function finalizeRaw(raw) {
  return decodeEntities(raw)
    .replace(CONTROL_CHARS_RE, '')
    .replace(/\u00a0/g, ' ');
}

// <br> 사이의 한 줄. 조각을 먼저 붙인 뒤 공백을 접어야 조각 경계의 공백이
// 사라지지 않는다.
//
// 'literal'은 **구분자를 자기 문자열 안의 공백에 의존하지 않는다.** 예전에는
// ` (url)`처럼 선행 공백을 박아뒀는데, 그 조각이 줄의 첫 조각이 되면 마지막
// `.trim()`이 그 공백을 먹었다. 조각 안의 공백은 trim의 사정권 안에 있으니
// 구분자로 쓸 수 없다 — **결합 시점에** 넣는다. 주석이 "이미 trim된 상태라
// 재적용이 무해하다"고 선언했던 불변식이 바로 이 지점에서 거짓이었다.
//
// 구분자는 **앞쪽에만** 넣는다. URL은 자기 라벨과 떨어져 있어야 하지만,
// `</a>` 뒤에 오는 글자는 붙는 것이 맞다 — 한국어 조사가 그렇게 온다
// (`공식 홈페이지 (url)를 참고하자`). 뒤쪽에도 공백을 넣으면 `(url) 를`이 된다.
function finalizeLine(parts) {
  let out = '';
  for (const p of parts) {
    const isLiteral = p.t === 'literal';
    const v = isLiteral ? p.v : finalizeRaw(p.v);
    if (!v) continue;
    const needGap = isLiteral && out !== '' && !/\s$/.test(out);
    out += (needGap ? ' ' : '') + v;
  }
  return out
    .replace(/\s+/g, ' ')          // 소스 개행 포함 공백류를 한 칸으로
    .trim();
}

// 앞뒤의 빈 줄은 버린다. `<p><br></p>`는 블로그 HTML에서 빈 줄 스페이서의
// 표준 관용구인데, 이걸 남기면 에디터에 빈 문단이 타이핑된다. 같은 목적의
// `<p>&nbsp;</p>`가 버려지는 것과 결과가 같아야 한다.
// 중간의 빈 줄(`가<br><br>나`)은 의도된 간격이므로 보존한다.
function finalizeParts(parts) {
  const lines = [[]];
  for (const p of parts) {
    if (p.t === 'br') lines.push([]);
    else lines[lines.length - 1].push(p);
  }
  return lines.map(finalizeLine).join('\n').replace(/^\n+|\n+$/g, '');
}

function finalizeSource(raw) {
  return finalizeParts([{ t: 'raw', v: raw }]);
}

// alt·caption은 에디터의 **한 줄 입력 필드**에 들어간다. <br>이 만든 개행을
// 그대로 넣으면 필드가 깨지므로 공백으로 접는다.
function singleLine(text) {
  return text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 이 노드의 자식 중 **아무도 소비하지 않는 것**을 모은다.
//
// 판정 기준이 "허용 안 된 **태그**"였다. 그래서 elementChildren()만 보고
// 텍스트 노드는 아예 검사 대상이 아니었다 — `<ul>중요한 안내문<li>가</li></ul>`의
// 안내문과 `<figure><img>여기 캡션이 사라진다</figure>`의 문장이 조용히 소멸했다.
// lint-draft에도 이걸 막는 규칙이 없다. "조용히 버리지 않는다"가 성립하려면
// 기준이 태그가 아니라 **소비되지 않은 모든 비공백 내용**이어야 한다.
// (pretty-print가 만든 공백 전용 텍스트는 내용이 아니므로 통과시킨다.)
function unconsumedChildren(node, allowedTags) {
  const out = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      const text = finalizeSource(child.value);
      if (text) out.push(`텍스트 ${JSON.stringify(text.slice(0, 30))}`);
    } else if (child.type === 'element' && !allowedTags.has(child.tag)) {
      out.push(`<${child.tag}>`);
    }
  }
  return out;
}

function inlineTextOf(node, links) {
  // 조각 배열을 반환하는 재귀. 예전에는 클로저 변수에 문자열을 누적하면서
  // <a> 라벨만 textOf+normalizeWhitespace로 따로 뽑았는데, 그래서 <a> 안에서만
  // (1) 화이트리스트가 우회되고 (2) 엔티티가 두 번 디코드되고
  // (3) <br>이 공백이 되는 세 갈래 불일치가 생겼다.
  const rec = (n, isRoot, inAnchor = false) => {
    if (n.type === 'text') return [{ t: 'raw', v: n.value }];
    if (n.type !== 'element') return [];

    // 루트는 블록 태그(p/h3/li/figcaption)라 인라인 화이트리스트 검사 대상이 아니다.
    if (isRoot) return n.children.flatMap((c) => rec(c, false, inAnchor));

    if (n.tag === 'br') return [{ t: 'br' }];

    if (n.tag === 'a') {
      // 중첩 <a>는 HTML에서 불법이고 브라우저마다 다르게 복구한다. 평문화하면
      // href가 본문에 두 번 박히고(`x (안쪽) (바깥쪽)`) links[]에도 두 줄이 쌓여
      // 사용자가 어느 링크를 걸어야 하는지 알 수 없다. html-parse도 lint도
      // 중첩을 검사하지 않으므로 여기서 막는다.
      if (inAnchor) {
        throw new NaverError(
          NAVER_EXIT.CONTENT,
          '<a> 안에 <a>가 중첩되어 있습니다 (HTML에서 불법입니다). '
          + '평문화하면 URL이 두 번 박히므로 중단합니다 — 초안에서 중첩을 푸세요.',
        );
      }
      const href = getAttr(n, 'href');
      // 라벨도 **같은 재귀**를 탄다 — <a> 안에서도 화이트리스트가 적용되고
      // <br>·엔티티가 바깥과 똑같이 처리된다.
      const labelParts = n.children.flatMap((c) => rec(c, false, true));
      // 네이버 에디터의 링크 삽입은 별도 UI다. v1에서는 평문화하되,
      // 무엇이 평문화됐는지 반드시 호출자에게 보고한다 (조용히 버리지 않는다).
      if (!href) return labelParts;
      // href를 먼저 최종화해 'literal'로 넣는다. 그래야 본문에 박히는 문자열과
      // links[].href가 **글자 단위로 같고**, 바깥 공백 접기가 href 안의 개행·
      // 여분 공백을 본문에서만 바꿔치는 일이 없다.
      const hrefText = finalizeSource(href);
      if (!hrefText) return labelParts;
      // links[]는 "무엇이 평문화됐는지"를 표 한 줄로 보고하는 용도다. 라벨에
      // <br>이 있으면 개행을 접는다 — 접지 않으면 dry-run 표가 두 줄로 쪼개져
      // 번호 없는 유령 행이 생긴다. 본문의 해당 위치에는 개행이 그대로 남는다.
      links.push({ text: singleLine(finalizeParts(labelParts)), href: hrefText });
      return [...labelParts, { t: 'literal', v: `(${hrefText})` }];
    }

    if (!INLINE_TAGS.has(n.tag)) {
      throw new NaverError(
        NAVER_EXIT.CONTENT,
        `블록 안에 허용되지 않은 요소가 있습니다: <${n.tag}>. `
        + `허용: ${[...INLINE_TAGS].join(', ')}`,
      );
    }
    return n.children.flatMap((c) => rec(c, false, inAnchor));
  };

  return finalizeParts(rec(node, true));
}

/**
 * @param {string} html 초안 HTML
 * @returns {{blocks: Array, links: Array<{text:string, href:string}>}}
 */
function htmlToBlocks(html) {
  const { root, errors } = parseHtml(html);
  if (errors.length) {
    throw new NaverError(
      NAVER_EXIT.CONTENT,
      `초안 HTML 구조 오류로 블록 변환을 중단합니다:\n  + ${errors.map((e) => e.message).join('\n  + ')}`,
      { errors },
    );
  }

  const blocks = [];
  const links = [];

  const walkBlocks = (children) => {
    for (const node of children) {
      if (node.type === 'text') {
        // <div> 직속 텍스트도 <p> 안의 텍스트와 **같은 파이프라인**을 탄다.
        // 예전에는 normalizeWhitespace(이미 디코드함) 위에 decodeEntities를
        // 한 번 더 얹어서, `&amp;lt;`가 <div> 안에서만 `<`가 됐다
        // (a1f6bbf가 splitSentences에서 고친 것과 같은 이중 디코드 버그).
        const t = finalizeSource(node.value);
        if (t) blocks.push({ type: 'paragraph', text: t });
        continue;
      }
      if (node.type !== 'element') continue;

      if (CONTAINER_TAGS.has(node.tag)) {
        walkBlocks(node.children);
        continue;
      }

      if (!BLOCK_TAGS.has(node.tag)) {
        // 인라인 요소가 블록 위치에 있으면 조치가 다르다 — 제거가 아니라 <p>로
        // 감싸는 것이다. 블록 목록만 나열하면 "<br>은 허용 태그인데 왜 안 되나"로
        // 막히므로, 인라인이면 그렇게 안내한다.
        const isInline = INLINE_TAGS.has(node.tag);
        throw new NaverError(
          NAVER_EXIT.CONTENT,
          isInline
            ? `<${node.tag}>이 블록 위치(문단 밖)에 있습니다. 인라인 요소이므로 `
              + `<p><${node.tag}>…</${node.tag}></p>처럼 <p>로 감싸세요. 조용히 버리지 않고 중단합니다.`
            : `허용되지 않은 블록 요소가 있습니다: <${node.tag}>. `
              + `허용: ${[...BLOCK_TAGS, ...CONTAINER_TAGS].join(', ')}. 조용히 버리지 않고 중단합니다.`,
        );
      }

      if (node.tag === 'figure') {
        const imgs = findAll(node, 'img');
        const caps = elementChildren(node).filter((c) => c.tag === 'figcaption');
        // figure 안에 img/figcaption 외의 요소가 있으면 조용히 버리지 않고 중단한다.
        // (다른 위치에서는 같은 상황을 exit 19로 막는데 여기만 통과시켜, 규칙이
        //  위치에 따라 달라지고 있었다.)
        const strayInFigure = unconsumedChildren(node, FIGURE_CHILD_TAGS);
        if (strayInFigure.length) {
          throw new NaverError(
            NAVER_EXIT.CONTENT,
            `<figure> 안에 아무도 소비하지 않는 내용이 있습니다: ${strayInFigure.join(', ')}. `
            + '허용: <img>, <figcaption>. 캡션이라면 <figcaption>으로 감싸세요 — '
            + '조용히 버리지 않고 중단합니다.',
          );
        }
        if (caps.length > 1) {
          throw new NaverError(
            NAVER_EXIT.CONTENT,
            `<figure>에 <figcaption>이 ${caps.length}개입니다 (1개여야 합니다). 나머지가 조용히 버려집니다.`,
          );
        }
        if (imgs.length !== 1) {
          throw new NaverError(
            NAVER_EXIT.CONTENT,
            `<figure> 안에 <img>가 ${imgs.length}개입니다 (1개여야 합니다).`,
          );
        }
        // src도 alt·caption과 **같은 파이프라인**을 탄다. 예전에는 여기만 원문
        // 그대로여서 `&amp;`가 디코드되지 않고 `&#0;`가 경로에 남았다. URL은
        // localPathFor → existsSync에서 exit 16으로 걸리므로 조용하지는 않았지만,
        // "같은 텍스트가 위치에 따라 다르게 처리되지 않는다"의 예외였다.
        const src = singleLine(finalizeSource(getAttr(imgs[0], 'src') || ''));
        if (!src) {
          throw new NaverError(NAVER_EXIT.CONTENT, '<figure>의 <img>에 src가 없습니다.');
        }
        blocks.push({
          type: 'image',
          src,
          // alt와 caption은 같은 파이프라인을 탄다. 예전에는 alt가 디코드만,
          // caption이 textOf+normalizeWhitespace라서 (1) figcaption 안에서만
          // 화이트리스트가 우회되고 (2) NUL이 alt로만 새고 (3) <br> 처리가
          // 달랐다 — <a>에서 고친 세 갈래 불일치가 여기 그대로 남아 있었다.
          alt: singleLine(finalizeSource(getAttr(imgs[0], 'alt') || '')),
          caption: caps.length ? singleLine(inlineTextOf(caps[0], links)) : '',
          localPath: null,
        });
        continue;
      }

      if (node.tag === 'ul' || node.tag === 'ol') {
        const strayInList = unconsumedChildren(node, LIST_ITEM_TAGS);
        if (strayInList.length) {
          throw new NaverError(
            NAVER_EXIT.CONTENT,
            `<${node.tag}> 안에 아무도 소비하지 않는 내용이 있습니다: ${strayInList.join(', ')}. `
            + '허용: <li>. 항목이라면 <li>로, 목록 밖 문장이라면 <p>로 감싸세요 — '
            + '조용히 버리지 않고 중단합니다.',
          );
        }
        // <ol>의 순번과 start 속성은 평문화로 소실된다. **조용히 버리지 않는다** —
        // 이 파일의 원칙이 그렇고, 순서가 의미를 갖는 목록(레시피·경로 안내)에서
        // 번호가 사라지면 내용이 달라진다. 번호를 직접 붙여 정보를 보존한다.
        const ordered = node.tag === 'ol';
        const startAttr = ordered ? getAttr(node, 'start') : null;
        let n = Number.parseInt(startAttr || '1', 10);
        if (!Number.isFinite(n)) n = 1;

        const items = elementChildren(node).filter((c) => LIST_ITEM_TAGS.has(c.tag));
        for (const li of items) {
          const t = inlineTextOf(li, links);
          // 빈 <li>는 소멸한다 — 번호가 있으면 그 자리가 비어 이후 번호가 어긋나므로
          // 무엇이 사라졌는지 알려준다.
          if (!t) {
            throw new NaverError(
              NAVER_EXIT.CONTENT,
              `<${node.tag}> 안에 내용이 없는 <li>가 있습니다. 평문화하면 그 항목이 `
              + '조용히 사라지므로 중단합니다 — 초안에서 빈 항목을 지우세요.',
            );
          }
          // 네이버 에디터의 목록 서식은 별도 UI다. v1에서는 접두사로 평문화한다.
          // <li> 안의 <br>은 이어지는 줄이라 접두사를 붙이지 않는다 (목록이 반쪽이
          // 되지 않도록 들여쓰기로 소속을 표시한다).
          const prefix = ordered ? `${n}. ` : '- ';
          n += 1;
          const [head, ...rest] = t.split('\n');
          const body = [prefix + head, ...rest.map((line) => ' '.repeat(prefix.length) + line)].join('\n');
          blocks.push({ type: 'paragraph', text: body });
        }
        continue;
      }

      const text = inlineTextOf(node, links);
      if (!text) continue;
      if (node.tag === 'h2' || node.tag === 'h3') {
        blocks.push({ type: 'heading', level: node.tag === 'h2' ? 2 : 3, text });
      } else {
        blocks.push({ type: 'paragraph', text });
      }
    }
  };

  walkBlocks(root.children);
  return { blocks, links };
}

function basenameOf(src) {
  return String(src || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
}

// GitHub Pages URL → 로컬 압축본 경로.
// 규약: .../posts/{date}-{hash12}/photo-NN.webp → {assetsRoot}/{date}-{hash12}/photo-NN.webp
function localPathFor(src, { assetsRoot, imageDir }) {
  const clean = String(src || '').split(/[?#]/)[0];
  if (imageDir) return path.join(imageDir, basenameOf(clean));

  const m = /\/posts\/([^/]+)\/([^/]+)$/.exec(clean);
  if (m) return path.join(assetsRoot, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

  // 이미 로컬 경로인 경우
  if (!/^https?:/i.test(clean)) return clean;
  return null;
}

/**
 * 이미지 블록의 src를 로컬 webp 경로로 해석한다.
 *
 * 파일이 하나라도 없으면 exit 16으로 중단하고 **절대 URL로 폴백하지 않는다** —
 * 폴백하면 네이버가 외부 이미지를 링크로 박아 핫링킹/깨짐 사고가 난다.
 */
function resolveImagePaths(blocks, { assetsRoot = path.join('tmp', 'assets'), imageDir = null } = {}) {
  const missing = [];
  for (const b of blocks) {
    if (b.type !== 'image') continue;
    const p = localPathFor(b.src, { assetsRoot, imageDir });
    if (!p || !fs.existsSync(p)) {
      missing.push({ src: b.src, tried: p });
      continue;
    }
    b.localPath = path.resolve(p);
  }

  if (missing.length) {
    throw new NaverError(
      NAVER_EXIT.IMAGE,
      `로컬 이미지 파일을 찾지 못했습니다 (${missing.length}건). 네이버는 외부 URL이 아니라 `
      + '로컬 파일을 에디터에 직접 올립니다 — URL로 폴백하면 핫링킹/깨짐 사고가 납니다.\n'
      + missing.map((m) => `  + ${m.src}\n    → 찾은 경로: ${m.tried || '(해석 실패)'}`).join('\n')
      + '\n  + upload-images.js를 --local-only 또는 --output과 함께 다시 실행했는지 확인하세요.\n'
      + '  + 또는 --image-dir로 압축본 디렉터리를 직접 지정하세요.',
      { missing },
    );
  }
  return blocks;
}

function summarizeBlocks(blocks) {
  const chars = blocks
    .filter((b) => b.type !== 'image')
    .reduce((n, b) => n + [...b.text].length, 0);
  return {
    total: blocks.length,
    headings: blocks.filter((b) => b.type === 'heading').length,
    paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
    images: blocks.filter((b) => b.type === 'image').length,
    chars,
    // 하드 개행 수를 노출한다. 파일 헤더의 출력 계약("'\n'은 Shift+Enter로 넣는다")이
    // 실제로 몇 번 적용되는지 dry-run에서 보이지 않으면, 에디터 레이어가 이걸
    // Enter로 처리해 문단 수가 달라져도 아무도 눈치채지 못한다.
    hardBreaks: blocks
      .filter((b) => b.type !== 'image')
      .reduce((n, b) => n + (b.text.match(/\n/g) || []).length, 0),
  };
}

module.exports = {
  BLOCK_TAGS,
  CONTAINER_TAGS,
  INLINE_TAGS,
  htmlToBlocks,
  localPathFor,
  resolveImagePaths,
  summarizeBlocks,
};
