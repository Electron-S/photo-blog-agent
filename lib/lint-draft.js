/**
 * 초안 HTML 정적 검증 — 외부 의존성 0, I/O 없음, process.exit 없음.
 *
 * prompts/{style-guide,system-rules,blog-draft}.md 와 CLAUDE.md에만 존재하던
 * 규칙을 실행되는 계약으로 승격한다. lib/verify-images.js와 같은 모양이다:
 * 여기는 순수 함수, scripts/lint-draft.js가 CLI 껍데기.
 *
 * ## 본문 글자수의 정본 정의
 *
 *   bodyChars = figcaption 서브트리 제외
 *             + alt/속성 제외 (애초에 텍스트가 아님)
 *             + 태그 제외
 *             + HTML 엔티티 디코드
 *             + 연속 공백 1칸으로 정규화
 *             후, **공백을 포함한** 코드포인트 수
 *
 * 이 정의로 실제 초안 6건이 1396 / 2018 / 2148 / 2356 / 2372 / 2992 가 되어
 * style-guide.md의 1,800~2,500 기준선과 맞는다. figcaption을 포함하면
 * "캡션만 길게 써서 1,800자 채우기"가 가능해지는데, 그건 AdSense가 요구하는
 * "페이지 주제를 판별할 수 있는 본문"이 아니다.
 *
 * 투명성을 위해 stats에 bodyChars와 charsIncludingCaptions를 둘 다 내보낸다.
 */

const {
  ancestors, elementChildren, findAll, getAttr, lineOf,
  nextElementSibling, parseHtml, textOf, walk,
} = require('./html-parse');
const {
  countChars, countSentences, decodeEntities, findDecorativeArrows, findEmoji,
  normalizeWhitespace,
} = require('./korean-text');

const MIN_BODY_CHARS = 1800;
const MAX_BODY_CHARS = 2500;
const H3_THRESHOLD_CHARS = 1500;
const MIN_H3_WHEN_LONG = 3;
const MIN_SENTENCES_AFTER_FIGURE = 2;
const MAX_P_CHARS = 250;
const MIN_P_SENTENCES = 2;
const MAX_P_SENTENCES = 4;

// 정확 문자열만 차단한다. `확인 필요`는 system-rules.md가 *권장*하는 표기라
// 부분 매치로 잡으면 프롬프트가 요구한 올바른 동작을 lint가 막는 정면 충돌이 난다.
const PLACEHOLDERS = ['확인 필요: AI 초안 생성 결과', '사진 리뷰 초안'];

// "방금"을 그대로 금칙어로 두면 "방금 튀겨낸 치킨텐더" 같은 정당한 표현을 막는다.
// 잡으려는 건 작성 시점을 방문 시점으로 혼동한 표현이지 부사가 아니다.
const WRITING_DATE_RES = [
  /오늘\s*(다녀|방문|갔|들렀)/,
  /방금\s*(다녀|방문|갔|들렀)/,
  /방금\s*전에\s*(다녀|방문)/,
];

const GENERIC_CAPTION_RE = /^\s*(사진|photo|이미지|image)\s*\d+\s*[.。]?\s*$/i;
const MECHANICAL_H3 = ['총평', '메뉴 정보', '가격 정보', '주차 안내', '방문 팁'];
const OVERCLAIM = ['강력 추천', '완벽한', '최고의', '무조건 가야'];
const AI_TELLS = ['총평하자면', '개인적으로는', '방문해보시는 걸 추천드립니다', '깔끔한 분위기', '만족스러운 경험', '가성비가 좋다'];
const AD_MENTIONS = ['애드센스', 'adsense', '광고 클릭', '클릭해 주시면', '수익'];

const REQUIRED_IMG_STYLE = { 'max-width': '100%', height: 'auto' };
const CANONICAL_IMG_STYLE = 'max-width:100%;height:auto;';
const REQUIRED_FIGURE_STYLE = { margin: '1.5em 0', 'text-align': 'center', position: 'relative' };
const CANONICAL_FIGURE_STYLE = 'margin:1.5em 0;text-align:center;position:relative;';

// style="a: 1; b: 2" → { a: '1', b: '2' }.
// 공백 차이는 브라우저 관점에서 동일하므로 선언 집합으로 비교한다.
function parseStyle(value) {
  const out = Object.create(null);
  for (const decl of String(value || '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).trim().toLowerCase().replace(/\s+/g, ' ');
    if (k) out[k] = v;
  }
  return out;
}

function missingStyleDecls(value, required) {
  const got = parseStyle(value);
  return Object.entries(required)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${k}:${v}`);
}

function srcExtension(src) {
  return String(src || '').split(/[?#]/)[0].toLowerCase();
}

function photoIndexOf(src) {
  const m = /photo-(\d+)\.webp$/i.exec(srcExtension(src));
  return m ? Number(m[1]) : null;
}

function basenameOf(src) {
  const clean = String(src || '').split(/[?#]/)[0];
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

// figure 다음부터 다음 figure/h3 전까지의 텍스트를 모은다.
// (형제 순회 — 텍스트 노드와 인라인 요소 모두 포함)
function textAfterFigure(fig) {
  let acc = '';
  const sibs = fig.parent ? fig.parent.children : [];
  for (let i = sibs.indexOf(fig) + 1; i < sibs.length; i++) {
    const n = sibs[i];
    if (n.type === 'element' && (n.tag === 'figure' || n.tag === 'h3' || n.tag === 'h2')) break;
    acc += n.type === 'text' ? n.value : textOf(n, ['figcaption']);
  }
  return acc;
}

function buildContext(html, options) {
  const { root, errors: parseErrors, source } = parseHtml(html);

  const images = findAll(root, 'img');
  const figures = findAll(root, 'figure');
  const h3s = findAll(root, 'h3');
  const paragraphs = findAll(root, 'p');

  const bodyRaw = textOf(root, ['figcaption']);
  const bodyChars = countChars(bodyRaw);
  const charsIncludingCaptions = countChars(textOf(root));

  // figure 직후 형제가 h3이면 no-h3-after-figure가 잡는다. 같은 figure를
  // text-after-figure에서 또 잡으면 같은 결함이 두 번 보고된다.
  const h3AfterFigure = new Set(
    figures.filter((f) => {
      const next = nextElementSibling(f);
      return next && (next.tag === 'h3' || next.tag === 'h2');
    }),
  );

  const uploadIndex = buildUploadIndex(options.uploadResult);

  return {
    source,
    root,
    parseErrors,
    images,
    figures,
    h3s,
    paragraphs,
    bodyChars,
    charsIncludingCaptions,
    bodyText: normalizeWhitespace(bodyRaw),
    h3AfterFigure,
    uploadIndex,
    hasUploadResult: uploadIndex !== null,
    line: (node) => lineOf(source, node && node.start),
  };
}

// 업로드 결과 JSON → src 매칭용 인덱스. 3단 폴백: 완전 일치 → decodeURIComponent
// → basename. uploadAsset이 경로에 encodeURIComponent를 적용하기 때문에 필요하다.
function buildUploadIndex(uploadResult) {
  if (!uploadResult || !Array.isArray(uploadResult.images)) return null;
  const exact = new Map();
  const decoded = new Map();
  const byBase = new Map();
  for (const im of uploadResult.images) {
    for (const u of [im.url, im.webpUrl, im.webpPath]) {
      if (typeof u !== 'string' || !u) continue;
      if (!exact.has(u)) exact.set(u, im);
      let dec = u;
      try { dec = decodeURIComponent(u); } catch { /* 잘못된 이스케이프는 원본 유지 */ }
      if (!decoded.has(dec)) decoded.set(dec, im);
      const b = basenameOf(u);
      if (b && !byBase.has(b)) byBase.set(b, im);
    }
  }
  return {
    lookup(src) {
      if (exact.has(src)) return exact.get(src);
      let dec = src;
      try { dec = decodeURIComponent(src); } catch { /* noop */ }
      if (decoded.has(dec)) return decoded.get(dec);
      return byBase.get(basenameOf(src)) || null;
    },
  };
}

// --- 규칙 정의 ---
// 각 규칙은 ctx를 받아 finding 배열을 반환한다. 새 규칙 추가 = 항목 하나 추가.

const RULES = [
  {
    id: 'html-structure',
    severity: 'error',
    check: (ctx) => ctx.parseErrors.map((e) => ({
      line: lineOf(ctx.source, e.offset),
      message: `HTML 구조 오류: ${e.message}`,
      detail: e.code,
    })),
  },
  {
    id: 'no-picture-source',
    severity: 'error',
    check: (ctx) => [...findAll(ctx.root, 'picture'), ...findAll(ctx.root, 'source')].map((n) => ({
      line: ctx.line(n),
      message: `<${n.tag}> 금지 — WebP 전용이라 폴백 래퍼를 쓰지 않는다. <img src="...webp">를 직접 쓸 것.`,
    })),
  },
  {
    id: 'img-loading-lazy',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => getAttr(n, 'loading') !== 'lazy')
      .map((n) => ({ line: ctx.line(n), message: '<img>에 loading="lazy"가 없습니다.', detail: getAttr(n, 'src') })),
  },
  {
    id: 'img-width-height',
    severity: 'error',
    check: (ctx) => ctx.images.flatMap((n) => {
      const bad = ['width', 'height'].filter((a) => !/^\d+$/.test(String(getAttr(n, a) || '')));
      return bad.length
        ? [{ line: ctx.line(n), message: `<img>의 ${bad.join('/')} 속성이 없거나 양의 정수가 아닙니다 (CLS 방지에 필수).`, detail: getAttr(n, 'src') }]
        : [];
    }),
  },
  {
    id: 'img-style-required',
    severity: 'error',
    check: (ctx) => ctx.images.flatMap((n) => {
      const missing = missingStyleDecls(getAttr(n, 'style'), REQUIRED_IMG_STYLE);
      return missing.length
        ? [{ line: ctx.line(n), message: `<img> style에 ${missing.join(', ')} 선언이 없습니다.`, detail: getAttr(n, 'src') }]
        : [];
    }),
  },
  {
    id: 'img-alt-nonempty',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => !String(getAttr(n, 'alt') || '').trim())
      .map((n) => ({ line: ctx.line(n), message: '<img>에 비어있지 않은 alt가 필요합니다.', detail: getAttr(n, 'src') })),
  },
  {
    id: 'img-src-webp',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => !srcExtension(getAttr(n, 'src')).endsWith('.webp'))
      .map((n) => ({ line: ctx.line(n), message: '이미지 src는 .webp여야 합니다 (JPEG 폴백 없음).', detail: getAttr(n, 'src') })),
  },
  {
    id: 'img-in-figure',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => !ancestors(n).some((a) => a.tag === 'figure'))
      .map((n) => ({ line: ctx.line(n), message: '<img>가 <figure> 밖에 있습니다.', detail: getAttr(n, 'src') })),
  },
  {
    id: 'figure-style-required',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((n) => {
      const missing = missingStyleDecls(getAttr(n, 'style'), REQUIRED_FIGURE_STYLE);
      return missing.length
        ? [{ line: ctx.line(n), message: `<figure> style에 ${missing.join(', ')} 선언이 없습니다. position:relative는 이미지 보호 오버레이에 필요합니다.` }]
        : [];
    }),
  },
  {
    id: 'figure-figcaption-once',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((n) => {
      const caps = elementChildren(n).filter((c) => c.tag === 'figcaption');
      if (caps.length === 1) return [];
      return [{
        line: ctx.line(n),
        message: caps.length === 0
          ? '<figure>에 <figcaption>이 없습니다.'
          : `<figure>에 <figcaption>이 ${caps.length}개입니다 (1개여야 함).`,
      }];
    }),
  },
  {
    id: 'figcaption-generic',
    severity: 'error',
    check: (ctx) => findAll(ctx.root, 'figcaption')
      .filter((n) => GENERIC_CAPTION_RE.test(decodeEntities(textOf(n))))
      .map((n) => ({ line: ctx.line(n), message: `제네릭 캡션 금지: "${textOf(n).trim()}" — 장면을 설명하는 문장으로 바꾸세요.` })),
  },
  {
    id: 'no-h3-after-figure',
    severity: 'error',
    check: (ctx) => [...ctx.h3AfterFigure].map((f) => ({
      line: ctx.line(f),
      message: '이미지 직후 <h3> 금지 — AdSense의 "이미지와 광고 사이 2문장 이상" 분리 규칙을 깹니다.',
    })),
  },
  {
    id: 'text-after-figure',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((f) => {
      if (ctx.h3AfterFigure.has(f)) return []; // no-h3-after-figure가 이미 보고함
      const n = countSentences(textAfterFigure(f));
      return n >= MIN_SENTENCES_AFTER_FIGURE ? [] : [{
        line: ctx.line(f),
        message: `이미지 다음에 텍스트가 ${n}문장뿐입니다 (${MIN_SENTENCES_AFTER_FIGURE}문장 이상 필요 — AdSense 이미지/광고 분리).`,
      }];
    }),
  },
  {
    id: 'body-min-chars',
    severity: 'error',
    check: (ctx) => (ctx.bodyChars >= MIN_BODY_CHARS ? [] : [{
      message: `본문이 ${ctx.bodyChars}자입니다 (${MIN_BODY_CHARS}자 이상 필요). figcaption 제외·공백 포함 기준.`,
      detail: `charsIncludingCaptions=${ctx.charsIncludingCaptions}`,
    }]),
  },
  {
    id: 'h3-min-count',
    severity: 'error',
    check: (ctx) => (ctx.bodyChars < H3_THRESHOLD_CHARS || ctx.h3s.length >= MIN_H3_WHEN_LONG ? [] : [{
      message: `본문이 ${ctx.bodyChars}자인데 <h3>가 ${ctx.h3s.length}개입니다 (${H3_THRESHOLD_CHARS}자 이상이면 ${MIN_H3_WHEN_LONG}개 이상).`,
    }]),
  },
  {
    id: 'no-emoji',
    severity: 'error',
    check: (ctx) => {
      // 본문뿐 아니라 캡션·alt까지 본다 (style-guide: 제목·소제목·본문·메타 전부 금지).
      const alts = ctx.images.map((n) => getAttr(n, 'alt') || '').join(' ');
      const hits = findEmoji(`${textOf(ctx.root)} ${alts}`);
      return hits.length ? [{ message: `이모지 금지: ${hits.join(' ')}`, detail: `${hits.length}종` }] : [];
    },
  },
  {
    id: 'no-placeholder',
    severity: 'error',
    check: (ctx) => PLACEHOLDERS
      .filter((p) => ctx.bodyText.includes(p))
      .map((p) => ({ message: `플레이스홀더가 본문에 남아 있습니다: "${p}"` })),
  },
  {
    id: 'no-writing-date-expression',
    severity: 'error',
    check: (ctx) => WRITING_DATE_RES.flatMap((re) => {
      const m = re.exec(ctx.bodyText);
      return m ? [{
        message: `작성 시점 표현 금지: "${m[0]}" — 방문 날짜는 EXIF primary_date다. "지난 ○월 ○일" 등으로 쓸 것.`,
      }] : [];
    }),
  },
  {
    id: 'img-dimensions-match',
    severity: 'error',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images.flatMap((n) => {
        const src = getAttr(n, 'src');
        const up = ctx.uploadIndex.lookup(src);
        if (!up || !Number.isInteger(up.width) || !Number.isInteger(up.height)) return [];
        const w = Number(getAttr(n, 'width'));
        const h = Number(getAttr(n, 'height'));
        if (w === up.width && h === up.height) return [];
        return [{
          line: ctx.line(n),
          message: `<img> 치수가 실제와 다릅니다: 본문 ${w}x${h}, 실제 ${up.width}x${up.height} (CLS 유발).`,
          detail: src,
        }];
      });
    },
  },
  {
    id: 'img-dimensions-unknown',
    severity: 'error',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images.flatMap((n) => {
        const src = getAttr(n, 'src');
        const up = ctx.uploadIndex.lookup(src);
        if (!up) return [];
        if (Number.isInteger(up.width) && Number.isInteger(up.height)) return [];
        return [{
          line: ctx.line(n),
          message: '업로드 결과의 width/height가 null입니다 — 본문 치수는 추측한 값입니다. 이미지를 빼거나 재업로드하세요.',
          detail: src,
        }];
      });
    },
  },

  // --- warn ---
  {
    id: 'body-max-chars',
    severity: 'warn',
    check: (ctx) => (ctx.bodyChars <= MAX_BODY_CHARS ? [] : [{
      message: `본문이 ${ctx.bodyChars}자입니다 (권장 상한 ${MAX_BODY_CHARS}자).`,
    }]),
  },
  {
    id: 'style-canonical-form',
    severity: 'warn',
    check: (ctx) => {
      const out = [];
      for (const n of ctx.images) {
        const s = String(getAttr(n, 'style') || '');
        if (s && s.replace(/\s/g, '') !== CANONICAL_IMG_STYLE.replace(/\s/g, '')
            && missingStyleDecls(s, REQUIRED_IMG_STYLE).length === 0) {
          out.push({ line: ctx.line(n), message: `<img> style 표기가 정규형과 다릅니다 (동작은 동일): "${s}" → "${CANONICAL_IMG_STYLE}"` });
        }
      }
      for (const n of ctx.figures) {
        const s = String(getAttr(n, 'style') || '');
        if (s && s.replace(/\s/g, '') !== CANONICAL_FIGURE_STYLE.replace(/\s/g, '')
            && missingStyleDecls(s, REQUIRED_FIGURE_STYLE).length === 0) {
          out.push({ line: ctx.line(n), message: `<figure> style 표기가 정규형과 다릅니다 (동작은 동일): "${s}"` });
        }
      }
      return out;
    },
  },
  {
    id: 'p-sentence-count',
    severity: 'warn',
    check: (ctx) => ctx.paragraphs.flatMap((n) => {
      const c = countSentences(textOf(n, ['figcaption']));
      if (c === 0 || (c >= MIN_P_SENTENCES && c <= MAX_P_SENTENCES)) return [];
      return [{ line: ctx.line(n), message: `단락이 ${c}문장입니다 (권장 ${MIN_P_SENTENCES}~${MAX_P_SENTENCES}문장).` }];
    }),
  },
  {
    id: 'p-max-chars',
    severity: 'warn',
    check: (ctx) => ctx.paragraphs.flatMap((n) => {
      const c = countChars(textOf(n, ['figcaption']));
      return c <= MAX_P_CHARS ? [] : [{ line: ctx.line(n), message: `단락이 ${c}자입니다 (권장 ${MAX_P_CHARS}자 이하 — 의미 단위로 분리).` }];
    }),
  },
  {
    id: 'h3-placement',
    severity: 'warn',
    check: (ctx) => {
      if (ctx.h3s.length === 0) return [];
      const out = [];
      const blocks = elementChildren(ctx.root);
      const firstP = blocks.findIndex((n) => n.tag === 'p');
      const lastContent = blocks.map((n) => n.tag).lastIndexOf('p');
      for (const h of ctx.h3s) {
        const i = blocks.indexOf(h);
        if (i === -1) continue;
        if (firstP !== -1 && i < firstP) {
          out.push({ line: ctx.line(h), message: '<h3>가 도입 단락보다 앞에 있습니다 (부제목은 도입과 마무리 사이).' });
        } else if (lastContent !== -1 && i > lastContent) {
          out.push({ line: ctx.line(h), message: '<h3>가 마지막 단락보다 뒤에 있습니다 (부제목은 도입과 마무리 사이).' });
        }
      }
      return out;
    },
  },
  {
    id: 'h3-mechanical-label',
    severity: 'warn',
    check: (ctx) => ctx.h3s.flatMap((n) => {
      const t = normalizeWhitespace(textOf(n));
      return MECHANICAL_H3.includes(t)
        ? [{ line: ctx.line(n), message: `기계적인 부제목 라벨: "${t}" — 자연스러운 묘사형으로 바꾸세요.` }]
        : [];
    }),
  },
  {
    id: 'overclaim-phrase',
    severity: 'warn',
    check: (ctx) => OVERCLAIM.filter((p) => ctx.bodyText.includes(p))
      .map((p) => ({ message: `과장 표현: "${p}"` })),
  },
  {
    id: 'ai-tell-phrase',
    severity: 'warn',
    check: (ctx) => AI_TELLS.filter((p) => ctx.bodyText.includes(p))
      .map((p) => ({ message: `AI 티 나는 표현: "${p}"` })),
  },
  {
    id: 'spouse-wording',
    severity: 'warn',
    check: (ctx) => (ctx.bodyText.includes('부인') ? [{ message: '"부인" 대신 "와이프"를 사용합니다.' }] : []),
  },
  {
    id: 'no-ad-encouragement',
    severity: 'warn',
    check: (ctx) => AD_MENTIONS
      .filter((p) => ctx.bodyText.toLowerCase().includes(p.toLowerCase()))
      .map((p) => ({ message: `광고/수익 언급 금지: "${p}"` })),
  },
  {
    id: 'link-target-rel',
    severity: 'warn',
    check: (ctx) => findAll(ctx.root, 'a').flatMap((n) => {
      if (!getAttr(n, 'href')) return [];
      const rel = String(getAttr(n, 'rel') || '');
      const missing = [];
      if (getAttr(n, 'target') !== '_blank') missing.push('target="_blank"');
      if (!rel.includes('noopener') || !rel.includes('noreferrer')) missing.push('rel="noopener noreferrer"');
      return missing.length ? [{ line: ctx.line(n), message: `<a>에 ${missing.join(', ')}가 없습니다.`, detail: getAttr(n, 'href') }] : [];
    }),
  },
  {
    id: 'decorative-arrow',
    severity: 'warn',
    check: (ctx) => {
      const hits = findDecorativeArrows(ctx.bodyText);
      return hits.length ? [{ message: `장식용 화살표로 보이는 문자: ${hits.join(' ')} (동선 설명이면 무시 가능).` }] : [];
    },
  },
  {
    id: 'image-order',
    severity: 'warn',
    check: (ctx) => {
      const nums = ctx.images.map((n) => photoIndexOf(getAttr(n, 'src'))).filter((x) => x !== null);
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] <= nums[i - 1]) {
          return [{ message: `이미지 순서가 오름차순이 아닙니다: photo-${nums[i - 1]} 다음에 photo-${nums[i]}.` }];
        }
      }
      return [];
    },
  },
  {
    id: 'img-not-in-upload-result',
    severity: 'warn',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images
        .filter((n) => !ctx.uploadIndex.lookup(getAttr(n, 'src')))
        .map((n) => ({ line: ctx.line(n), message: '이 이미지가 업로드 결과에 없습니다 (이전 세션 이미지 재사용일 수 있음).', detail: getAttr(n, 'src') }));
    },
  },
];

/**
 * @param {string} html 초안 HTML
 * @param {{uploadResult?: object, strict?: boolean}} [options]
 */
function lintDraftHtml(html, options = {}) {
  const ctx = buildContext(html, options);

  const errors = [];
  const warnings = [];

  for (const rule of RULES) {
    let findings;
    try {
      findings = rule.check(ctx) || [];
    } catch (err) {
      // 규칙 하나가 터져서 전체 검증이 조용히 통과하는 일이 없어야 한다.
      errors.push({ rule: rule.id, severity: 'error', line: null, message: `규칙 실행 실패: ${err.message}`, detail: null });
      continue;
    }
    for (const f of findings) {
      const entry = {
        rule: rule.id,
        severity: rule.severity,
        line: f.line ?? null,
        message: f.message,
        detail: f.detail ?? null,
      };
      // --strict는 warn을 error로 승격한다. 규칙을 강화하는 방향이라 우회가 아니다.
      if (rule.severity === 'error' || options.strict) {
        errors.push({ ...entry, severity: 'error' });
      } else {
        warnings.push(entry);
      }
    }
  }

  const sentencesAfterFigure = ctx.figures.map((f) => countSentences(textAfterFigure(f)));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      bodyChars: ctx.bodyChars,
      charsIncludingCaptions: ctx.charsIncludingCaptions,
      figures: ctx.figures.length,
      images: ctx.images.length,
      h3: ctx.h3s.length,
      paragraphs: ctx.paragraphs.length,
      sentencesAfterFigure,
      // 검증이 안 됐다는 사실 자체를 표면화한다 (조용히 통과 금지).
      dimensionCheck: ctx.hasUploadResult ? 'ok' : 'skipped',
    },
  };
}

function formatLintReport(result, { only = 'all' } = {}) {
  const lines = [];
  const show = (list, tag) => {
    for (const f of list) {
      const at = f.line ? ` (line ${f.line})` : '';
      const detail = f.detail ? `\n      ${f.detail}` : '';
      lines.push(`  ${tag} [${f.rule}]${at} ${f.message}${detail}`);
    }
  };
  if (only !== 'warn' && result.errors.length) {
    lines.push(`초안 lint 실패 — error ${result.errors.length}건:`);
    show(result.errors, 'ERROR');
  }
  if (only !== 'error' && result.warnings.length) {
    lines.push(`초안 lint 경고 ${result.warnings.length}건 (차단하지 않음):`);
    show(result.warnings, 'WARN ');
  }
  return lines.join('\n');
}

module.exports = {
  H3_THRESHOLD_CHARS,
  MAX_BODY_CHARS,
  MIN_BODY_CHARS,
  MIN_SENTENCES_AFTER_FIGURE,
  PLACEHOLDERS,
  RULES,
  formatLintReport,
  lintDraftHtml,
  parseStyle,
};
