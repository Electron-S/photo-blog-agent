// 초안 HTML 토크나이저 + 얕은 트리 빌더 — 외부 의존성 0.
//
// 왜 직접 쓰는가: 관대한 파서(node-html-parser 등)는 미닫힘 <figure>를 조용히
// 복구한다. 그러면 "구조가 깨진 초안"이 lint를 통과해 Blogger에 올라간다 —
// 이 프로젝트가 가장 싫어하는 silent failure다. 여기서는 미닫힘·고아 닫는 태그를
// errors[]로 표면화해서 발행을 막는다.
//
// 입력 도메인은 임의의 웹 HTML이 아니라 prompts/blog-draft.md가 생성하는
// flat block 시퀀스(p/h3/figure/img/figcaption/a/strong/br/ul)뿐이다.

// <br>이 만든 줄바꿈 전용 센티널. 그냥 '\n'을 쓰면 **HTML 소스의 줄바꿈**과
// 구별되지 않는다. 텍스트 노드의 값을 그대로 누적하므로, 초안이 소스에서
// 여러 줄로 접혀 있기만 해도 문장 수가 부풀려져 text-after-figure(error)가
// 조용히 통과한다 — AdSense 이미지/광고 분리 규칙이 무력화된다.
// NUL은 실제 초안 텍스트에 나타나지 않는다.
const BR_SENTINEL = '\u0000';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// 이 안의 내용은 마크업으로 파싱하지 않는다.
const RAW_TEXT_TAGS = new Set(['script', 'style']);

// 열린 <p>를 암묵적으로 닫는 태그 (HTML 스펙 "in body" 규칙).
const P_CLOSING_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

function makeElement(tag, attrs, start) {
  return { type: 'element', tag, attrs, children: [], parent: null, start, end: null };
}

function appendChild(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

// 태그 안의 속성을 읽는다. 따옴표 안의 '>'와 '/'를 태그 종료로 오인하지 않는 것이 핵심.
// 반환: { attrs, selfClosing, next, malformed } — next는 '>' 다음 위치.
//
// `<`는 속성명 안에 올 수 없다. 종료 문자 집합에 없으면 `>`를 빠뜨린 태그가
// **다음 요소를 자기 속성으로 삼켜 버린다**:
//   `<figure style="..." <img src="..." alt="..."></figure>`
//     → figure.attrs['<img']='' 이고 <img> 요소는 사라지며 errors는 **빈 배열**
// 이 저장소에서 그건 조용한 실패의 최악 사례였다 — lint의 img 규칙 6개가 전부
// "img가 없으니 위반도 없음"으로 통과해 **사진이 빠진 글이 exit 0으로 발행된다**
// (figure에 img가 필수라는 규칙은 없다). verify-images도 줄어든 목록만 검증한다.
function readAttributes(html, i) {
  const attrs = Object.create(null);
  let selfClosing = false;
  let malformed = null;
  // `>`를 실제로 만났는가. 입력이 태그 중간에서 끝나면 거짓으로 남는다 —
  // 예전에는 그 경우 malformed=null로 반환해서, `<p>가.</p><img src=` 같은
  // 잘린 파일이 **오류 0건**으로 통과하고 유령 <img>가 하나 생겼다.
  // void 태그는 스택에 안 올라가 미닫힘 검사도 못 받으므로 여기가 유일한 방어선이다.
  // (브라우저는 이 태그를 통째로 버린다. lint는 img 규칙 6건을 내는데 그중
  //  "파일이 잘렸다"를 가리키는 것은 하나도 없었다.)
  let closed = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) break;

    if (html[i] === '>') { closed = true; i += 1; break; }
    if (html[i] === '/' && html[i + 1] === '>') { selfClosing = true; closed = true; i += 2; break; }
    if (html[i] === '/') { i += 1; continue; }

    // `<`를 만나면 앞 태그의 '>'가 빠진 것이다. 여기서 태그를 끝내고 malformed로
    // 보고해야 다음 `<`부터 정상 파싱이 재개된다 (관대한 복구가 아니라 표면화).
    if (html[i] === '<') {
      malformed = i;
      break;
    }
    // (아래 루프 종료 후 closed 판정)

    const nameStart = i;
    while (i < html.length && !/[\s=/><]/.test(html[i])) i += 1;
    if (i === nameStart) { i += 1; continue; }
    const name = html.slice(nameStart, i).toLowerCase();

    while (i < html.length && /\s/.test(html[i])) i += 1;

    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const q = html[i];
      if (q === '"' || q === "'") {
        i += 1;
        const vs = i;
        while (i < html.length && html[i] !== q) i += 1;
        value = html.slice(vs, i);
        i += 1; // 닫는 따옴표
      } else {
        // 따옴표 없는 값에서도 `<`는 종료 문자다. 속성 **이름** 쪽만 고치고
        // 여기를 빼두면 헤드라인 버그가 이 한 위치에서 그대로 살아남는다:
        //   `<figure class=foo<img src="b.webp">` → <img> 소멸, errors 빈 배열.
        // 실제 초안은 값을 따옴표로 감싸므로 도달하기 어렵지만, 판정 기준이
        // 위치에 따라 달라지는 것 자체가 이 저장소가 반복해 온 결함 형태다.
        const vs = i;
        while (i < html.length && !/[\s><]/.test(html[i])) i += 1;
        value = html.slice(vs, i);
        if (html[i] === '<') {
          malformed = i;
          break;
        }
      }
    } else {
      // 값 없는 속성 (예: <img loading>) — 빈 문자열로 둔다.
      value = '';
    }

    if (!(name in attrs)) attrs[name] = value;
  }

  // `<`도 `>`도 못 만나고 입력이 끝났다 = 태그가 잘렸다.
  return { attrs, selfClosing, next: i, malformed, truncated: !closed && malformed === null };
}

// UTF-8이 아닌 인코딩으로 저장된 초안을 감지한다.
//
// 모든 읽기가 `readFileSync(path, 'utf8')`이므로 cp949 문제는 없지만,
// **UTF-16LE 파일을 감지하는 지점이 없었다.** PowerShell 5.1의 `>` 리다이렉션과
// `Out-File` 기본값이 UTF-16LE다. 그 파일을 utf8로 읽으면 mojibake가 되는데
// lint가 통과했다 (실측: errors 0, images 5, exit 0) — parseHtml이 BOM과 리터럴
// NUL을 파싱 **전에** 지우므로 mojibake의 흔적을 볼 수 없고, ASCII 태그와 `.`만
// 보고 정상 문서로 판정한다. 결과: 본문이 U+FFFD로 채워진 글이 Blogger에 생성된다.
//
// 그래서 **제거하기 전에** 신호를 본다. 조용히 복구하지 않는 것이 이 파서의 원칙이다.
function detectBadEncoding(source) {
  const lead = source.slice(0, 2);
  if (lead === '\uFFFE' || lead === '\uFEFF\u0000' || source[0] === '\u0000') {
    return 'UTF-16 BOM 또는 선행 NUL이 있습니다 (UTF-16LE/BE로 저장된 파일일 수 있습니다)';
  }
  // 본문에 NUL이 촘촘히 섞여 있으면 UTF-16을 utf8로 읽은 것이다.
  // (정상 초안의 NUL은 0개다 — BR_SENTINEL은 파싱 **후에** 생긴다.)
  const nulls = source.split('\u0000').length - 1;
  if (nulls > 0 && nulls * 4 > source.length) {
    return `본문에 NUL이 ${nulls}개 있습니다 (UTF-16LE를 UTF-8로 읽은 것으로 보입니다)`;
  }
  // 치환 문자가 많으면 이미 디코드가 깨진 것이다.
  const replaced = source.split('\uFFFD').length - 1;
  if (replaced > 3 && replaced * 20 > source.length) {
    return `치환 문자(U+FFFD)가 ${replaced}개 있습니다 (인코딩이 맞지 않습니다)`;
  }
  return null;
}

function parseHtml(html) {
  const errors = [];
  const badEncoding = detectBadEncoding(String(html == null ? '' : html));
  if (badEncoding) {
    errors.push({
      code: 'bad-encoding',
      tag: null,
      offset: 0,
      message: `초안 파일의 인코딩이 UTF-8이 아닌 것으로 보입니다 — ${badEncoding}. `
        + 'UTF-8(BOM 없이)로 다시 저장하세요. 이대로 진행하면 본문이 깨진 채 발행됩니다.',
    });
  }
  const src = String(html == null ? '' : html)
    .replace(/^﻿/, '')   // BOM
    .replace(/\r\n/g, '\n')   // Windows 개행
    .replace(/\r/g, '\n')
    // 원본의 리터럴 NUL을 제거한다. 남겨두면 <br>이 만든 BR_SENTINEL과 구별되지
    // 않아 가짜 문장 경계가 되고, text-after-figure(error)가 조용히 통과한다.
    // 정상적인 HTML 초안에 NUL이 들어갈 이유는 없다.
    .split(BR_SENTINEL).join('');

  const root = makeElement('#root', Object.create(null), 0);
  const stack = [root];
  const top = () => stack[stack.length - 1];

  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) {
      appendChild(top(), { type: 'text', value: src.slice(textStart, end), start: textStart, end });
    }
  };

  while (i < src.length) {
    if (src[i] !== '<') { i += 1; continue; }

    // 주석
    if (src.startsWith('<!--', i)) {
      flushText(i);
      // `<!-->`와 `<!--->`는 스펙상 유효한 **빈 주석**이다. `indexOf('-->', i+4)`로만
      // 찾으면 이 둘을 닫히지 않은 주석으로 보고 문서 나머지를 통째로 버린다
      // (거짓 빨강 → exit 8). 실제 초안 도구가 만드는 형태이므로 먼저 처리한다.
      const empty = /^<!---?>/.exec(src.slice(i));
      if (empty) {
        i += empty[0].length;
        textStart = i;
        continue;
      }
      const close = src.indexOf('-->', i + 4);
      if (close === -1) {
        errors.push({ code: 'unterminated-comment', tag: null, offset: i, message: '닫히지 않은 주석 (<!--)' });
        i = src.length;
      } else {
        i = close + 3;
      }
      textStart = i;
      continue;
    }

    // <!DOCTYPE ...> 등 선언.
    //
    // `<!-`(주석 오타)나 `<!foo` 같은 것도 여기로 온다. 예전에는 첫 '>'까지
    // **오류 없이** 삼켰다. `<p>a</p><!- note <img src="x.webp"><p>b</p>`에서
    // <img>가 소멸하고 errors는 빈 배열이었다 — 브라우저도 이걸 버리므로
    // lint가 유일한 방어선인데 통과했다. DOCTYPE만 조용히 넘기고 나머지는 보고한다.
    if (src.startsWith('<!', i)) {
      flushText(i);
      const close = src.indexOf('>', i);
      const swallowed = src.slice(i, close === -1 ? src.length : close + 1);
      if (!/^<!doctype/i.test(swallowed)) {
        errors.push({
          code: 'bogus-declaration',
          tag: null,
          offset: i,
          message: `'<!'로 시작하는 선언이 아닌 것이 있습니다 (줄 ${lineOf(src, i)}): `
            + `${JSON.stringify(swallowed.slice(0, 40))}. 주석은 <!-- -->로 써야 합니다 — `
            + '이 상태로는 다음 \'>\'까지의 마크업이 통째로 버려집니다.',
        });
      }
      i = close === -1 ? src.length : close + 1;
      textStart = i;
      continue;
    }

    // `<?`는 처리 명령처럼 보이지만 HTML에는 없다 — 브라우저는 bogus comment로
    // 보고 다음 '>'까지 버린다. 예전에는 이 파서가 그것을 **본문 텍스트로** 남겨,
    // `<?xml version="1.0" encoding="UTF-8"?>` 한 줄이 bodyChars를 38자 부풀렸다
    // (실측). body-min-chars는 하한이라 과대 계산은 안전하지 않은 쪽이다.
    // `<!` 경로가 같은 브라우저 동작을 bogus-declaration으로 보고하는 것과 맞춘다.
    if (src.startsWith('<?', i)) {
      flushText(i);
      const close = src.indexOf('>', i);
      const swallowed = src.slice(i, close === -1 ? src.length : close + 1);
      errors.push({
        code: 'bogus-declaration',
        tag: null,
        offset: i,
        message: `'<?'로 시작하는 처리 명령은 HTML에 없습니다 (줄 ${lineOf(src, i)}): `
          + `${JSON.stringify(swallowed.slice(0, 40))}. 다음 '>'까지가 통째로 버려집니다.`,
      });
      i = close === -1 ? src.length : close + 1;
      textStart = i;
      continue;
    }

    // 닫는 태그
    if (src.startsWith('</', i)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(src.slice(i));
      if (!m) {
        // `</ 3`처럼 태그명이 아닌 것. 브라우저는 bogus comment로 '>'까지 버리는데
        // 예전에는 한 글자씩 넘겨 본문 텍스트로 남겼다 (bodyChars 과대 계산).
        flushText(i);
        const close = src.indexOf('>', i);
        const swallowed = src.slice(i, close === -1 ? src.length : close + 1);
        errors.push({
          code: 'bogus-declaration',
          tag: null,
          offset: i,
          message: `'</'로 시작하지만 태그 이름이 아닙니다 (줄 ${lineOf(src, i)}): `
            + `${JSON.stringify(swallowed.slice(0, 40))}. 다음 '>'까지가 통째로 버려집니다.`,
        });
        i = close === -1 ? src.length : close + 1;
        textStart = i;
        continue;
      }
      flushText(i);
      const tag = m[1].toLowerCase();

      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx <= 0) {
        // 스택에 없는 태그를 닫으려 함 — 짝 없는 닫는 태그.
        errors.push({ code: 'orphan-closing-tag', tag, offset: i, message: `짝이 없는 닫는 태그 </${tag}>` });
      } else {
        // 사이에 열려 있던 태그들은 닫히지 않은 것이다.
        for (let k = stack.length - 1; k > idx; k--) {
          errors.push({
            code: 'unclosed-tag', tag: stack[k].tag, offset: stack[k].start,
            message: `<${stack[k].tag}>가 </${tag}> 전에 닫히지 않았습니다`,
          });
        }
        for (let k = stack.length - 1; k >= idx; k--) {
          stack[k].end = i + m[0].length;
          stack.pop();
        }
      }
      i += m[0].length;
      textStart = i;
      continue;
    }

    // 여는 태그
    const om = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i));
    if (!om) { i += 1; continue; }
    flushText(i);

    const tag = om[1].toLowerCase();
    const { attrs, selfClosing, next, malformed, truncated } = readAttributes(src, i + om[0].length);
    if (truncated) {
      errors.push({
        code: 'malformed-tag',
        tag,
        offset: i,
        message: `<${tag}> 태그가 '>' 없이 입력 끝에서 잘렸습니다 (줄 ${lineOf(src, i)}). `
          + '파일이 온전히 저장됐는지 확인하세요 — 브라우저는 이 태그를 통째로 버립니다.',
      });
    }
    if (malformed !== null) {
      // 조용히 복구하지 않는다 — 이게 통과하면 사진이 빠진 글이 lint를 통과한다.
      errors.push({
        code: 'malformed-tag',
        tag,
        offset: i,
        message: `<${tag}> 태그가 '>'로 닫히지 않은 채 다음 '<'를 만났습니다 `
          + `(줄 ${lineOf(src, malformed)}). '>'가 빠졌는지 확인하세요 — `
          + '이 상태로는 뒤따르는 요소가 이 태그의 속성으로 삼켜집니다.',
      });
    }
    // **열린 <p> 안에서 블록 요소가 시작되면 브라우저는 <p>를 먼저 닫는다** (스펙
    // "in body"). 예전에는 이 파서가 중첩시키고 errors는 빈 배열이었다. 그러면
    // followingSiblings가 </p>에서 멈춰서, 이미지 뒤에 문단이 두 개 보이는 초안에
    // `text-after-figure: 0문장뿐입니다`(error)가 났다 — 진단이 능동적으로 오도하고
    // 원인을 가리키는 오류는 하나도 없었다. 같은 중첩에서 no-h3-after-figure도
    // 무력화된다.
    //
    // 조용히 복구하지 않는다: 브라우저와 같은 트리를 만들되(그래야 다른 규칙이
    // 정확해진다) 구조 문제 자체를 error로 표면화한다.
    if (P_CLOSING_TAGS.has(tag)) {
      const openP = stack.length - 1;
      if (openP > 0 && stack[openP].tag === 'p') {
        errors.push({
          code: 'block-in-paragraph',
          tag,
          offset: i,
          message: `<p> 안에서 <${tag}>가 시작됩니다 (줄 ${lineOf(src, i)}). `
            + `브라우저는 여기서 <p>를 먼저 닫으므로 </p>는 짝을 잃습니다 — `
            + `<${tag}>를 <p> 밖으로 빼세요.`,
        });
        stack[openP].end = i;
        stack.pop();
      }
    }

    const el = makeElement(tag, attrs, i);
    appendChild(top(), el);

    if (VOID_TAGS.has(tag) || selfClosing) {
      el.end = next;
      i = next;
    } else if (RAW_TEXT_TAGS.has(tag)) {
      // `</script foo>`처럼 닫는 태그에 잡다한 것이 붙어도 브라우저는 요소를 닫는다.
      // `</script\s*>`만 보면 닫히지 않은 것으로 판정해 문서 나머지를 raw text로
      // 삼키고 unclosed-tag를 낸다 (거짓 빨강).
      const closeRe = new RegExp(`</${tag}(?:\\s[^>]*)?>`, 'i');
      const rest = src.slice(next);
      const cm = closeRe.exec(rest);
      if (cm) {
        appendChild(el, { type: 'text', value: rest.slice(0, cm.index), start: next, end: next + cm.index });
        el.end = next + cm.index + cm[0].length;
        i = el.end;
      } else {
        errors.push({ code: 'unclosed-tag', tag, offset: i, message: `<${tag}>가 닫히지 않았습니다` });
        appendChild(el, { type: 'text', value: rest, start: next, end: src.length });
        el.end = src.length;
        i = src.length;
      }
    } else {
      stack.push(el);
      i = next;
    }
    textStart = i;
  }

  flushText(src.length);

  for (let k = stack.length - 1; k > 0; k--) {
    errors.push({
      code: 'unclosed-tag', tag: stack[k].tag, offset: stack[k].start,
      message: `<${stack[k].tag}>가 닫히지 않았습니다`,
    });
    stack[k].end = src.length;
  }

  return { root, errors, source: src };
}

function walk(node, visit) {
  visit(node);
  if (node.children) {
    for (const c of node.children) walk(c, visit);
  }
}

function findAll(node, tagName) {
  const tag = tagName.toLowerCase();
  const out = [];
  walk(node, (n) => {
    if (n !== node && n.type === 'element' && n.tag === tag) out.push(n);
  });
  return out;
}

// 하위 텍스트 노드를 이어붙인다 (엔티티 디코드는 하지 않음 — 호출자 책임).
// skipTags에 든 태그의 서브트리는 건너뛴다 (예: 본문 글자수에서 figcaption 제외).
function textOf(node, skipTags = []) {
  const skip = new Set(skipTags.map((t) => t.toLowerCase()));
  let out = '';
  const rec = (n) => {
    if (n.type === 'text') { out += n.value; return; }
    if (n.type === 'element') {
      if (n !== node && skip.has(n.tag)) return;
      // <br>만 문장 경계다 (korean-text의 splitSentences가 이 센티널로 나눈다).
      if (n.tag === 'br') { out += BR_SENTINEL; return; }
      for (const c of n.children) rec(c);
    }
  };
  rec(node);
  return out;
}

function getAttr(node, name) {
  if (!node || node.type !== 'element') return undefined;
  return node.attrs[name.toLowerCase()];
}

function hasAttr(node, name) {
  return getAttr(node, name) !== undefined;
}

// 요소 형제만 (텍스트 노드 무시). "figure 직후 형제가 h3인가" 판정에 쓴다.
function elementChildren(node) {
  return node.children.filter((c) => c.type === 'element');
}

// 순수 래퍼(div/section/article)를 넘어 **문서 순서상 다음 형제들**을 돌려준다.
//
// `parent.children`만 훑으면 래퍼 하나에 판정이 무너진다. Blogger 웹 에디터는
// 이미지를 `<div class="separator">`로 감싸는 것이 기본 동작이라, 사용자가 에디터를
// 한 번 거치면 바로 도달한다. 그때 `text-after-figure`(error, 우회 플래그 없음)가
// "이미지 다음에 텍스트가 0문장뿐입니다"라고 하는데 초안을 열면 문장이 보인다 —
// 메시지가 능동적으로 오도한다.
const PASSTHROUGH_TAGS = new Set(['div', 'section', 'article']);

// **래퍼를 넘어갈 뿐 아니라 평탄화한다.**
//
// 넘어가기만 하고 래퍼 노드를 그대로 내보내면, 호출자가 `n.tag === 'figure'`로
// 경계를 판정할 때 `<div class="separator"><figure/></div>`의 tag가 `div`라서
// **break가 걸리지 않는다.** 그러면 스캔이 다음 이미지·그다음 이미지를 넘어
// 문서 끝까지 계속돼, `text-after-figure`(error)가 진짜 위반을 놓친다 (실측:
// 같은 본문이 래핑 유무에 따라 1문장 vs 4문장). Blogger 웹 에디터가 **모든**
// 이미지를 래핑하므로, 그 경우 이 규칙이 마지막 figure를 빼고 사실상 무력해진다.
// 오탐을 미탐으로 바꾸는 것은 더 나쁘다.
// 순수 래퍼를 평탄화한 **블록 목록**. followingSiblings와 같은 이유로 필요하다 —
// `elementChildren(root)`만 보면 래퍼 하나에 규칙이 0개를 검사하게 된다
// (indexOf가 -1이 되어 조용히 continue). 12차에 followingSiblings에만 평탄화를
// 넣고 이쪽은 빠뜨렸다.
function flatElementChildren(node) {
  const out = [];
  const visit = (n) => {
    if (n.type !== 'element') return;
    if (PASSTHROUGH_TAGS.has(n.tag)) {
      for (const c of n.children) visit(c);
    } else {
      out.push(n);
    }
  };
  for (const c of node.children) visit(c);
  return out;
}

function followingSiblings(node) {
  const out = [];
  const flatten = (n) => {
    if (n.type === 'element' && PASSTHROUGH_TAGS.has(n.tag)) {
      for (const c of n.children) flatten(c);
    } else {
      out.push(n);
    }
  };

  let cur = node;
  while (cur && cur.parent) {
    const sibs = cur.parent.children;
    for (let i = sibs.indexOf(cur) + 1; i < sibs.length; i += 1) flatten(sibs[i]);
    // 래퍼의 마지막 자식이었다면 래퍼 밖으로 이어서 본다.
    const parentIsWrapper = cur.parent.type === 'element'
      && PASSTHROUGH_TAGS.has(cur.parent.tag);
    if (!parentIsWrapper) break;
    cur = cur.parent;
  }
  return out;
}

function nextElementSibling(node) {
  const p = node.parent;
  if (!p) return null;
  const sibs = p.children;
  for (let i = sibs.indexOf(node) + 1; i < sibs.length; i++) {
    if (sibs[i].type === 'element') return sibs[i];
    // 사이의 공백만 있는 텍스트는 무시하고, 실제 내용이 있으면 형제 아님.
    if (sibs[i].type === 'text' && sibs[i].value.trim() !== '') return null;
  }
  return null;
}

function ancestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

// 문자 오프셋 → 1-기반 줄 번호 (에러 메시지용).
function lineOf(source, offset) {
  if (typeof offset !== 'number' || offset < 0) return null;
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

module.exports = {
  BR_SENTINEL,
  VOID_TAGS,
  ancestors,
  elementChildren,
  findAll,
  getAttr,
  hasAttr,
  lineOf,
  flatElementChildren,
  followingSiblings,
  nextElementSibling,
  parseHtml,
  textOf,
  walk,
};
