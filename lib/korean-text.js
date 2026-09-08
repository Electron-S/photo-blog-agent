// 한국어 텍스트 계량 — 외부 의존성 0 (같은 저장소의 html-parse 상수만 참조).
// lint-draft의 문장 수/글자 수/이모지 규칙이 여기에 의존한다.

const { BR_SENTINEL } = require('./html-parse');

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
// **계량 전에 NFC로 정규화한다.**
//
// 문장 조각 필터 `/[가-힣A-Za-z0-9]/`와 경계 lookahead `(?=[가-힣A-Z])`는
// **NFD 자모(U+1100~U+11FF)를 하나도 매칭하지 못한다.** 그래서 같은 초안이
// 정규화 형태에 따라 세 방향으로 다 깨졌다 (실측, 실제 초안):
//   NFC 2356자 / error 0  →  NFD 4681자 / text-after-figure error 4건
//   "이미지 다음에 텍스트가 0문장뿐입니다"인데 문단마다 세 문장이 보인다 —
//   진단이 원인을 전혀 가리키지 않아 작성자가 고칠 수 없다.
// 역방향도 확인: 정당하게 차단되던 1396자 초안이 NFD에서 2694자로 측정돼
// body-min-chars(error)를 통과했다 (미탐).
//
// macOS 파일 시스템·일부 편집기·클립보드가 NFD를 만든다. 계량의 입구에서 한 번
// 정규화하면 하류 전체가 안전해진다 (NFC 정규화는 멱등이라 중복 호출이 무해하다).
function toNfc(text) {
  const raw = String(text == null ? '' : text);
  try {
    return raw.normalize('NFC');
  } catch {
    return raw;   // 정규화 불가한 입력에서 계량 자체가 죽지 않게
  }
}

// 보이지 않는 문자. `\s`는 U+200B(ZWSP)·U+200C·U+2060을 매칭하지 않으므로
// 명시적으로 지운다. 그러지 않으면 **보이지 않는 문자로 분량 게이트가 뚫린다**
// (실측: 1396자 초안에 ZWSP 405개를 넣으면 bodyChars 1801로 측정돼
// body-min-chars(error)를 통과한다). 리서치 텍스트를 웹에서 복사하면 ZWSP가
// 실제로 섞여 들어온다. 같은 구멍으로 `alt="<ZWSP>"`가 img-alt-nonempty(error)를
// 통과했다 — `.trim()`은 ZWSP를 제거하지 않는다.
//
// lib/naver-content.js가 같은 판정을 카테고리로 하고 있다 (Cc + Cf). 여기도 같은
// 기준을 쓴다 — 목록이 갈리면 한쪽에서 지워지는 문자가 다른 쪽에서 살아남는다.
// \t \n \v \f \r은 Cc지만 남긴다: 아래 공백 접기가 한 칸으로 만든다.
const INVISIBLE_RE = /(?![\t\n\v\f\r])[\p{Cc}\p{Cf}]/gu;

function normalizeWhitespace(text) {
  return toNfc(decodeEntities(text))
    .replace(/ /g, ' ')
    // <br> 센티널은 공백으로 접는다 — 글자수에 NUL이 세이면 안 된다.
    .split(BR_SENTINEL).join(' ')
    .replace(INVISIBLE_RE, '')
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
  // URL. `\S+`로 잡으면 **문장 종결 마침표까지 삼킨다** — URL 직후에 끝나는
  // 문장이 다음 문장과 합쳐져 1문장으로 계산되고, text-after-figure(error,
  // 우회 플래그 없음)가 오탐한다. CLAUDE.md와 visit-research.md가 "공식 홈페이지
  // 링크는 실용 정보 근처나 마무리 단락에 배치"하라고 **지시**하므로, 규칙을
  // 지킨 초안이 exit 8로 차단되는 상황이었다 (실측 확인).
  //
  // 그래서 뒤에 공백/끝이 오는 종결부호는 URL에 포함하지 않는다. URL 안의
  // 마침표(`example.com`, `a.html`)는 뒤에 공백이 없으므로 그대로 마스킹된다.
  mask(/(?:https?:\/\/|www\.)\S*?(?=[.!?…]+(?:\s|$)|\s|$)/g);
  // 남는 과대 계산: "사이트는 www.example.com. 이다." → 2문장 (도메인 뒤 마침표를
  // 문장 끝으로 본다). **의도적으로 그대로 둔다** — 종결부호를 URL에 포함시키면
  // 위 오탐이 되살아나고, 과대 계산은 text-after-figure(error)에서 안전한 방향이다.
  // 영향은 p-sentence-count(warn)뿐이다.
  mask(/[A-Za-z0-9_-]+\.(?:webp|jpe?g|png|html?|com|net|kr|org|io)\b/gi); // 파일명·도메인
  mask(/\b(?:etc|vs|Mr|Mrs|Ms|Dr|No|a\.m|p\.m)\./gi); // 영어 약어
  s = s.replace(/(?<=\d)\.(?=\d)/g, SENTENCE_MASK); // 소수점·버전
  // 번호 목록 접두사(`1. `, `2. `)는 문장 끝이 아니다. 다만 **하나만 있으면
  // 목록이 아니라 숫자로 끝난 문장이다**:
  //   "1. 첫째 2. 둘째"      → 목록      (마스킹해야 1문장)
  //   "총 15. 다음 문장이다."  → 문장 끝   (마스킹하면 2문장이 1문장이 된다)
  // 둘은 문법적으로 구별할 수 없으므로 **개수로 판정한다** — 한 조각 안에
  // 두 개 이상이면 목록으로 본다.
  //
  // 방향이 중요하다. text-after-figure는 error 등급이고 우회 플래그가 없으므로
  // **과소 계산이 훨씬 비싸다**(정당한 초안이 발행 불가). 애매하면 마스킹하지
  // 않아 문장으로 세는 쪽으로 기운다. 마스킹의 원래 목적(번호만 붙여 요건을
  // 채우는 우회)은 두 개 이상일 때만 성립하므로 이 규칙으로 충분하다.
  //
  // `\d{1,4}`인 이유: 한국식 날짜 표기 "2026. 5. 10."의 연도까지 함께 잡아야
  // 세 조각이 한 문장으로 남는다.
  const NUMBER_PREFIX_RE = /(?<=^|[\s\u0000])\d{1,4}\.(?=\s)/g;
  if ((s.match(NUMBER_PREFIX_RE) || []).length >= 2) {
    s = s.replace(NUMBER_PREFIX_RE, (m) => SENTENCE_MASK.repeat(m.length));
  }

  // 줄임표(`...`, `…`)는 일부러 마스킹하지 않는다 — 실제 문장 끝이기 때문이다.
  // 경계 판정은 re1의 `(?=\s|$)`(뒤에 공백이나 끝) 또는 re2의 한글/대문자
  // lookahead가 담당하므로, "a...b" 같은 중간 줄임표는 경계가 되지 않는다.
  return s;
}

// html-parse의 textOf가 <br>을 BR_SENTINEL로 내보낸다. <br>은 실제 문장 경계이므로
// 먼저 조각으로 나눈 뒤 각 조각을 문장 분리한다.
//
// **센티널만** 경계로 쓴다. 생 '\n'을 경계로 쓰면 HTML 소스의 줄바꿈까지 문장
// 경계가 되어, 같은 한 문장이 소스에서 접혀 있다는 이유만으로 2문장이 되고
// text-after-figure(error)가 조용히 통과한다.
//
// 여기서 디코드하지 않는다. splitOneLine의 normalizeWhitespace가 이미 디코드하므로
// 두 번 디코드하면 `&amp;lt;`(화면에 &lt;로 보여야 하는 텍스트)가 `<`가 된다.
function splitSentences(plain) {
  const text = String(plain == null ? '' : plain);
  if (text.includes(BR_SENTINEL)) {
    return text.split(BR_SENTINEL).flatMap((seg) => splitOneLine(seg));
  }
  return splitOneLine(text);
}

function splitOneLine(plain) {
  const text = normalizeWhitespace(plain);
  if (!text) return [];

  const masked = maskNonBoundaries(text);
  const boundaries = [];

  // 정상 경계: 종결부호 + 닫는 따옴표/괄호 뒤에 공백이나 끝.
  // `…`도 포함한다 — "망설였다… 그래도 갔다."의 `…`는 `...`과 똑같이 문장 끝이고,
  // 빼면 2문장이 1문장으로 과소 계산된다 (text-after-figure가 error 등급이라
  // 과소 계산이 가장 비싼 오류다). decodeEntities가 &hellip;를 …로 바꾸므로
  // 실제 초안에서 도달 가능한 경로다.
  const re1 = /[.!?…]+["'’”)\]】」』]*(?=\s|$)/g;
  // 공백이 빠진 경계: "끝났다.그리고" — 한국어 초안에 흔하다
  const re2 = /[.!?…]+(?=[가-힣A-Z])/g;

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
  + '|[\\u2794\\u27A1\\u2B05\\u2B06\\u2B07' // 이모지 블록 화살표 (타이포그래피 화살표와 구분)
  + '\\u2605\\u2606\\u2713\\u2714\\u2716\\u2717\\u2718' // 별, 체크, 가위표
  + '\\u2660-\\u2667' // 카드 무늬·하트
  + '\\u266A-\\u266D' // 음표
  + '\\u261C-\\u261F' // 손가락
  + ']'
  // **도형(■□▲△▼▽◆◇○●)은 넣지 않는다.** 유니코드 어느 속성으로도 이모지가
  // 아니고(ExtPict/EmojiPres/Emoji 전부 false), style-guide.md:27이 금지한 목록
  // ("체크표시, 별, 불꽃, 핀")에도 없다. 손으로 추가했던 것이다.
  //
  // 그리고 `○`는 이 프로젝트가 **쓰라고 지시하는 표기**다 — blog-draft.md:60
  // ("지난 ○월 ○일"), workflow-steps.md:140 ("여기 ○○ 맞나요?"), CLAUDE.md,
  // 그리고 **lint 자신의 no-writing-date-expression error 메시지**까지.
  // 지시를 따른 초안이 `no-emoji`(error, 우회 플래그 없음)로 막혔고, `○`가 왜
  // 이모지인지 작성자가 알 방법도 없었다. `홍길○`(이름 마스킹)·`● 표시`(안내판
  // 픽토그램 서술) 같은 정상 표기도 함께 막혔다.
  + '|\\uFE0F|\\u20E3' // VS16, keycap
  + ')',
  'gu',
);

// © ® ™ 는 저작권 표기로 정당하게 쓰일 수 있어 통과시킨다.
const EMOJI_ALLOW_RE = /[©®™]/;

// --- 화살표: 두 규칙이 정확히 한쪽으로만 귀속되어야 한다 ---
//
// U+2190~21FF는 타이포그래피 화살표 블록이고, 그중 ↔ ↕ ↖ ↩ 등 일부를 유니코드가
// Extended_Pictographic으로도 분류한다. 그대로 두면 같은 글자가 no-emoji(error)와
// decorative-arrow(warn)에 동시에 걸려 error가 이기고, "→는 되는데 ↔는 안 되는"
// 재현 불가능한 규칙이 된다.
//
// **배타성은 구조로 보장한다.** 두 함수가 같은 단위(grapheme)에 같은 술어를
// 적용한다: 어떤 grapheme이 "화살표 grapheme"이면 decorative-arrow가, 아니면
// (이모지라면) no-emoji가 담당한다. 한쪽만 케이스를 늘리면 이전처럼 조합
// (VS16 → VS15 → keycap/ZWJ/skin-tone)마다 구멍이 생긴다.
//
// 화살표 grapheme의 정의:
//   ↔       맨 화살표          — 타이포그래피 문자
//   ↔︎ +VS15 텍스트 표현 선택자 — 작성자가 명시적으로 "이모지 아님"을 요청
// 그 외 모든 조합(↔️ +VS16, +keycap, +ZWJ, +skin-tone)은 이모지 표현을 의도한
// 것이므로 no-emoji가 담당한다.
//
// U+27A1(➡) U+2B05~07(⬅⬆⬇) U+2794(➔)는 화살표 모양이지만 타이포그래피 블록이
// 아니라 RGI 이모지 기저 문자다. style-guide가 금지하는 "장식용"에 가장 가까우므로
// 맨 형태도 이모지(error)로 둔다 — 아래 정의에 넣지 않는다.
const TYPOGRAPHIC_ARROW = '\\u2190-\\u21FF';

// grapheme 전체가 화살표일 때만 참. findEmoji와 findDecorativeArrows가 이 하나를
// 공유하므로 두 규칙의 문자 집합은 정의상 겹칠 수 없다.
const ARROW_GRAPHEME_RE = new RegExp(`^[${TYPOGRAPHIC_ARROW}]\\uFE0E?$`, 'u');

// grapheme 클러스터 경계에 붙는 문자들: 변이 선택자(VS15/VS16), keycap,
// ZWJ, 결합 문자, 피부톤 수식자.
const GRAPHEME_EXTEND_RE = /[\u200D\uFE0E\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]|\p{M}/u;
const REGIONAL_INDICATOR_RE = /[\u{1F1E6}-\u{1F1FF}]/u;
const ZWJ = '\u200D';

// Intl.Segmenter가 없는 환경용 폴백.
//
// 예전에는 `[...text]`(코드포인트 분해)였는데, 그러면 "↔ + VS16"이 두 조각으로
// 쪼개져 화살표는 decorative-arrow(warn)에, VS16은 no-emoji(error)에 각각
// 걸린다 — findEmoji/findDecorativeArrows의 배타성이 이 경로에서만 깨진다
// (실측: 화살표 112자 × 4조합 = 448건). 배타성을 "정의상 보장"하려면 두
// 함수가 보는 단위가 환경에 따라 달라지면 안 되므로, 폴백도 클러스터를 만든다.
function fallbackGraphemes(text) {
  const clusters = [];
  let cur = '';
  let prevWasZwj = false;
  let riRun = 0;

  for (const cp of text) {
    const isExtend = GRAPHEME_EXTEND_RE.test(cp);
    const isRi = REGIONAL_INDICATOR_RE.test(cp);

    if (cur === '') {
      cur = cp;
    } else if (isExtend || prevWasZwj || (isRi && riRun === 1)) {
      // 수식자·ZWJ 다음 문자·국기의 두 번째 절반은 앞 클러스터에 붙인다.
      cur += cp;
    } else {
      clusters.push(cur);
      cur = cp;
    }

    prevWasZwj = cp === ZWJ;
    riRun = isRi ? (riRun === 1 ? 0 : 1) : 0;
  }

  if (cur !== '') clusters.push(cur);
  return clusters;
}

let segmenter;
function graphemesOf(text) {
  if (segmenter === undefined) {
    segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
      ? new Intl.Segmenter('ko', { granularity: 'grapheme' })
      : null;
  }
  if (!segmenter) return fallbackGraphemes(text);
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
    // 화살표 grapheme은 decorative-arrow(warn)가 담당한다.
    if (ARROW_GRAPHEME_RE.test(g)) continue;
    hits.add(g);
  }
  return [...hits];
}

// findEmoji와 **같은 단위·같은 술어**로 판정한다. 예전에는 여기만 문자 단위
// 정규식이라, 화살표가 섞인 이모지 시퀀스(↔+keycap 등)에서 findEmoji는 시퀀스
// 전체를 이모지로 잡고 여기는 그 안의 맨 화살표를 잡아 동시 매칭이 났다.
function findDecorativeArrows(text) {
  const decoded = decodeEntities(text);
  const hits = new Set();
  for (const g of graphemesOf(decoded)) {
    if (ARROW_GRAPHEME_RE.test(g)) hits.add(g);
  }
  return [...hits];
}

module.exports = {
  ARROW_GRAPHEME_RE,
  fallbackGraphemes,
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
