// 한국어 텍스트 계량 — 외부 의존성 0.
// lint-draft의 문장 수/글자 수/이모지 규칙이 여기에 의존한다.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', copy: '©',
  reg: '®', trade: '™', deg: '°', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

// 엔티티 디코드를 먼저 해야 &#128512; 처럼 숨은 이모지를 잡을 수 있다.
function decodeEntities(text) {
  return String(text == null ? '' : text).replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return whole;
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

// 본문 글자수 = 태그/속성 제외, figcaption·alt 제외, 엔티티 디코드,
// 연속 공백 1칸 정규화 후 공백 포함 코드포인트 수.
// 이 정의는 prompts/style-guide.md의 1,800~2,500자 기준과 실측으로 맞춰져 있다.
function normalizeWhitespace(text) {
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 서로게이트 페어(이모지 등)를 1자로 세기 위해 spread를 쓴다.
function countChars(text) {
  return [...normalizeWhitespace(text)].length;
}

const SENTENCE_MASK = ' ';

// 문장 경계 후보에서 제외할 구간을 마스킹한다.
// text-after-figure가 error 등급이라 오탐(실제로는 충분한데 차단)이 가장 비싸다.
// 따라서 애매하면 "문장으로 세는" 쪽으로 기울인다.
function maskNonBoundaries(text) {
  let s = text;
  const mask = (re) => {
    s = s.replace(re, (m) => SENTENCE_MASK.repeat(m.length));
  };
  mask(/(?:https?:\/\/|www\.)\S+/g); // URL
  mask(/[A-Za-z0-9_-]+\.(?:webp|jpe?g|png|html?|com|net|kr|org|io)\b/gi); // 파일명·도메인
  mask(/\b(?:etc|vs|Mr|Mrs|Ms|Dr|No|a\.m|p\.m)\./gi); // 영어 약어
  s = s.replace(/(?<=\d)\.(?=\d)/g, SENTENCE_MASK); // 소수점·버전

  // 줄임표(`...`, `…`)는 일부러 마스킹하지 않는다. "망설였다... 그래도 갔다."의
  // `...`은 실제 문장 끝이므로 마스킹하면 2문장이 1문장으로 과소 계산된다.
  // re1의 `(?=\s|$)` lookahead가 이미 올바르게 처리한다 — 뒤에 공백이나 끝이
  // 오는 `...`만 경계가 되고, "a...b" 같은 중간 줄임표는 경계가 아니다.
  // `…`는 `[.!?]`에 없어 애초에 경계로 잡히지 않는다.
  return s;
}

function splitSentences(plain) {
  const text = normalizeWhitespace(plain).replace(/\n+/g, ' ');
  if (!text) return [];

  const masked = maskNonBoundaries(text);
  const boundaries = [];

  // 정상 경계: 종결부호 + 닫는 따옴표/괄호 뒤에 공백이나 끝
  const re1 = /[.!?]+["'’”)\]】」』]*(?=\s|$)/g;
  // 공백이 빠진 경계: "끝났다.그리고" — 한국어 초안에 흔하다
  const re2 = /[.!?]+(?=[가-힣A-Z])/g;

  for (const re of [re1, re2]) {
    let m;
    while ((m = re.exec(masked)) !== null) {
      boundaries.push(m.index + m[0].length);
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }

  boundaries.sort((a, b) => a - b);

  const pieces = [];
  let prev = 0;
  for (const b of boundaries) {
    if (b <= prev) continue;
    pieces.push(text.slice(prev, b));
    prev = b;
  }
  // 꼬리 조각도 1문장으로 센다. 마지막 문장의 마침표 생략은 흔하고,
  // 여기서 안 세면 error 오탐이 된다.
  if (prev < text.length) pieces.push(text.slice(prev));

  // 한글/영숫자를 1자 이상 포함한 조각만 문장으로 인정 (")" 같은 잔여물 제외)
  return pieces
    .map((p) => p.trim())
    .filter((p) => /[가-힣A-Za-z0-9]/.test(p));
}

function countSentences(plain) {
  return splitSentences(plain).length;
}

// --- 이모지 ---
//
// \p{Extended_Pictographic} 단독은 부족하다. Node 20 실측 결과
// 체크표시·별·음표·손가락·도형(✓ ★ ☆ 등)을 놓치고 © ® ™ 를 잡는다.
// style-guide.md가 "체크표시, 별, 불꽃, 핀 같은 장식용"을 명시적으로
// 금지하므로 미탐이 치명적이다.
const EMOJI_ERROR_RE = new RegExp(
  '(?:'
  + '\\p{Extended_Pictographic}'
  + '|\\p{Emoji_Presentation}'
  + '|[\\u{1F1E6}-\\u{1F1FF}]' // 국기 (regional indicator)
  + '|[\\u2605\\u2606\\u2713\\u2714\\u2716\\u2717\\u2718' // 별, 체크, 가위표
  + '\\u2660-\\u2667' // 카드 무늬·하트
  + '\\u266A-\\u266D' // 음표
  + '\\u261C-\\u261F' // 손가락
  + '\\u25A0\\u25A1\\u25B2\\u25B3\\u25BC\\u25BD\\u25C6\\u25C7\\u25CB\\u25CF]' // 도형
  + '|\\uFE0F|\\u20E3' // VS16, keycap
  + ')',
  'gu',
);

// © ® ™ 는 저작권 표기로 정당하게 쓰일 수 있어 통과시킨다.
const EMOJI_ALLOW_RE = /[©®™]/;

// 화살표는 "잠실역 → 소피텔" 처럼 동선 설명에 정당하다 → warn 등급.
const DECORATIVE_ARROW_RE = /[\u2190-\u21FF\u27A1\u2794\u2B05\u2B06\u2B07]/gu;

// ↔ ↕ ↖ ↩ 등 U+2190~21FF의 일부는 유니코드가 Extended_Pictographic으로도 분류한다.
// 그대로 두면 같은 한 글자가 no-emoji(error)와 decorative-arrow(warn)에 동시에
// 걸려 error가 이기고, "→는 되는데 ↔는 안 되는" 재현 불가능한 규칙이 된다.
// 화살표는 화살표 규칙 하나만 담당한다 (두 규칙의 문자 집합은 겹치지 않는다).
const ARROW_NOT_EMOJI_RE = /[\u2190-\u21FF\u27A1\u2794\u2B05\u2B06\u2B07]/;

let segmenter;
function graphemesOf(text) {
  if (segmenter === undefined) {
    segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
      ? new Intl.Segmenter('ko', { granularity: 'grapheme' })
      : null;
  }
  if (!segmenter) return [...text];
  return [...segmenter.segment(text)].map((s) => s.segment);
}

// 이모지 매치를 grapheme 단위로 되돌려 반환한다 (피부톤·ZWJ 가족 이모지가
// 쪼개져서 보고되지 않게 한다).
function findEmoji(text) {
  const decoded = decodeEntities(text);
  const hits = new Set();
  for (const g of graphemesOf(decoded)) {
    EMOJI_ERROR_RE.lastIndex = 0;
    if (!EMOJI_ERROR_RE.test(g)) continue;
    if ([...g].length === 1 && EMOJI_ALLOW_RE.test(g)) continue;
    if ([...g].length === 1 && ARROW_NOT_EMOJI_RE.test(g)) continue;
    hits.add(g);
  }
  return [...hits];
}

function findDecorativeArrows(text) {
  const decoded = decodeEntities(text);
  DECORATIVE_ARROW_RE.lastIndex = 0;
  return [...new Set(decoded.match(DECORATIVE_ARROW_RE) || [])];
}

module.exports = {
  ARROW_NOT_EMOJI_RE,
  DECORATIVE_ARROW_RE,
  EMOJI_ALLOW_RE,
  EMOJI_ERROR_RE,
  countChars,
  countSentences,
  decodeEntities,
  findDecorativeArrows,
  findEmoji,
  graphemesOf,
  normalizeWhitespace,
  splitSentences,
};
