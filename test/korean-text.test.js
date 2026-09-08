const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countChars, countSentences, decodeEntities, findDecorativeArrows, findEmoji,
  normalizeWhitespace, splitSentences,
} = require('../lib/korean-text');

const cp = (...a) => String.fromCodePoint(...a);
const ZWJ = cp(0x200D);

test('decodeEntities — named / decimal / hex', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&lt;p&gt;'), '<p>');
  assert.equal(decodeEntities('&quot;x&quot;'), '"x"');
  assert.equal(decodeEntities('&#65;&#66;'), 'AB');
  assert.equal(decodeEntities('&#x41;'), 'A');
  assert.equal(decodeEntities('&#128512;'), cp(0x1F600));
  // 알 수 없는 엔티티는 그대로 둔다
  assert.equal(decodeEntities('&bogus;'), '&bogus;');
  assert.equal(decodeEntities('&#999999999;'), '&#999999999;');
  assert.equal(decodeEntities(null), '');
});

test('normalizeWhitespace — nbsp와 연속 공백', () => {
  assert.equal(normalizeWhitespace('a&nbsp;b'), 'a b');
  assert.equal(normalizeWhitespace('  a \n\n  b  '), 'a b');
});

test('countChars — 공백 포함, 서로게이트 1자', () => {
  assert.equal(countChars('가나다'), 3);
  assert.equal(countChars('가 나'), 3);
  assert.equal(countChars('  가   나  '), 3);
  // 이모지는 코드포인트 1개
  assert.equal(countChars(cp(0x1F600)), 1);
  assert.equal(countChars(''), 0);
});

test('splitSentences — 기본 경계', () => {
  assert.equal(countSentences('첫 문장이다. 둘째 문장이다.'), 2);
  assert.equal(countSentences('질문인가? 감탄이다! 평서문이다.'), 3);
});

test('splitSentences — 마침표 없는 꼬리 조각도 1문장', () => {
  // 마지막 문장의 마침표 생략은 흔하다. 안 세면 error 오탐이 된다.
  assert.equal(countSentences('첫 문장이다. 마침표 없는 마지막 조각'), 2);
  assert.equal(countSentences('마침표가 아예 없는 한 줄'), 1);
});

test('splitSentences — 공백 없는 경계도 잡는다', () => {
  // 한국어 초안에 흔한 "끝났다.그리고"
  assert.equal(countSentences('끝났다.그리고 다시 시작했다.'), 2);
});

test('splitSentences — 줄임표/소수점/URL/파일명은 경계가 아니다', () => {
  assert.equal(countSentences('망설였다... 그래도 갔다.'), 2);
  assert.equal(countSentences('가격은 12.5만원이었다.'), 1);
  assert.equal(countSentences('링크는 https://example.com/a.html 였다.'), 1);
  assert.equal(countSentences('파일은 photo-01.webp 이다.'), 1);
  assert.equal(countSentences('커피 vs. 차 중에 골랐다.'), 1);
  assert.equal(countSentences('한 줄 요약…'), 1);
});

test('splitSentences — 닫는 따옴표/괄호 뒤 경계', () => {
  assert.equal(countSentences('그는 "가자."라고 했다. 우리는 갔다.'), 2);
  assert.equal(countSentences('설명이었다(주차 무료). 다음 문장이다.'), 2);
});

test('splitSentences — 빈 입력과 구두점만', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences('...'), []);
  assert.deepEqual(splitSentences(')'), []);
});

test('findEmoji — 장식용 기호를 놓치지 않는다', () => {
  // \p{Extended_Pictographic} 단독으로는 전부 미탐이던 것들
  for (const c of [cp(0x2713), cp(0x2605), cp(0x2606), cp(0x266C), cp(0x261E)]) {
    assert.equal(findEmoji(c).length, 1, `U+${c.codePointAt(0).toString(16)} 미탐`);
  }
  for (const c of [cp(0x1F600), cp(0x1F525), cp(0x1F4CD), cp(0x2705), cp(0x2B50), cp(0x2764), cp(0x260E)]) {
    assert.equal(findEmoji(c).length, 1, `U+${c.codePointAt(0).toString(16)} 미탐`);
  }
});

test('findEmoji — 한글·한자·기호는 오탐하지 않는다', () => {
  for (const c of ['가', '한', '漢', '·', '※', '℃', '—', '…', 'a', '1', '(', ')']) {
    assert.deepEqual(findEmoji(c), [], `${c} 오탐`);
  }
});

test('findEmoji — © ® ™ 는 통과 (저작권 표기)', () => {
  assert.deepEqual(findEmoji('©'), []);
  assert.deepEqual(findEmoji('®'), []);
  assert.deepEqual(findEmoji('™'), []);
});

test('findEmoji — 국기와 ZWJ 시퀀스는 통째로 보고', () => {
  const flag = cp(0x1F1F0) + cp(0x1F1F7);
  assert.deepEqual(findEmoji(flag), [flag]);

  const family = cp(0x1F468) + ZWJ + cp(0x1F469) + ZWJ + cp(0x1F467);
  assert.deepEqual(findEmoji(`가족 ${family} 사진`), [family]);

  const thumbTone = cp(0x1F44D) + cp(0x1F3FB);
  assert.deepEqual(findEmoji(thumbTone), [thumbTone]);
});

test('findEmoji — 엔티티로 숨긴 이모지도 잡는다', () => {
  assert.deepEqual(findEmoji('&#128512; 안녕'), [cp(0x1F600)]);
});

test('findDecorativeArrows — 화살표는 별도 (warn 등급)', () => {
  assert.deepEqual(findDecorativeArrows('잠실역 → 소피텔'), ['→']);
  assert.deepEqual(findDecorativeArrows('화살표 없음'), []);
});

test('findEmoji — 화살표는 이모지가 아니다 (decorative-arrow가 담당)', () => {
  // ↔ ↕ ↖ ↩ 등은 유니코드가 Extended_Pictographic으로도 분류한다. 그대로 두면
  // 같은 글자가 no-emoji(error)와 decorative-arrow(warn)에 동시에 걸려
  // error가 이기고, "→는 되는데 ↔는 안 되는" 재현 불가능한 규칙이 된다.
  for (const c of ['\u2194', '\u2195', '\u2196', '\u21A9', '\u2192', '\u2190']) {
    assert.deepEqual(findEmoji(c), [], `U+${c.codePointAt(0).toString(16)} 가 이모지로 잡힘`);
    assert.deepEqual(findDecorativeArrows(c), [c], `U+${c.codePointAt(0).toString(16)} 가 화살표로 안 잡힘`);
  }
});

test('화살표: 두 규칙이 모든 조합에서 배타적이고 빠짐이 없다 (구조적 불변식)', () => {
  // 이 불변식은 세 라운드 연속으로 깨졌다 — VS16 → VS15 → keycap/ZWJ/skin-tone.
  // 매번 "한 케이스"만 패치했기 때문이다. 이제 두 함수가 같은 단위(grapheme)에
  // 같은 술어(ARROW_GRAPHEME_RE)를 적용하므로 배타성이 정의상 보장된다.
  // 테스트도 케이스가 아니라 조합 전수로 확인한다.
  const ZWJ = '\u200D';
  const VS15 = '\uFE0E';
  const VS16 = '\uFE0F';
  const KEYCAP = '\u20E3';
  const SKIN = '\u{1F3FB}';
  const HEART = '\u2764';

  // [접미사, 화살표 규칙이 담당해야 하는가]
  const suffixes = [
    ['', true],              // 맨 화살표 = 타이포그래피 문자
    [VS15, true],            // 텍스트 표현 선택자 = 명시적으로 "이모지 아님"
    [VS16, false],           // 이모지 표현 선택자
    [KEYCAP, false],
    [ZWJ + HEART, false],
    [SKIN, false],
    [VS16 + KEYCAP, false],
    [VS15 + KEYCAP, false],
  ];

  for (let code = 0x2190; code <= 0x21FF; code += 1) {
    const bare = String.fromCodePoint(code);
    for (const [suffix, isArrowRule] of suffixes) {
      const s = bare + suffix;
      const label = `U+${code.toString(16)} + ${JSON.stringify(suffix)}`;
      const emoji = findEmoji(s).length > 0;
      const arrow = findDecorativeArrows(s).length > 0;

      assert.ok(!(emoji && arrow), `${label}: 두 규칙에 동시 매칭`);
      assert.ok(emoji || arrow, `${label}: 어느 규칙도 담당하지 않음`);
      assert.equal(arrow, isArrowRule, `${label}: 담당 규칙이 기대와 다름`);
    }
  }
});

test('이모지 블록 화살표(➡ ⬅ ⬆ ⬇ ➔)는 맨 형태도 이모지', () => {
  // U+2190 블록의 타이포그래피 화살표와 달리 RGI 이모지 기저 문자다.
  // style-guide가 금지하는 "장식용"에 가장 가까우므로 error로 둔다.
  for (const c of ['\u27A1', '\u2B05', '\u2B06', '\u2B07', '\u2794']) {
    assert.equal(findEmoji(c).length, 1, `U+${c.codePointAt(0).toString(16)} 가 이모지로 안 잡힘`);
    assert.deepEqual(findDecorativeArrows(c), [], `U+${c.codePointAt(0).toString(16)} 가 화살표로도 잡힘`);
  }
});

test('splitSentences — <br>만 문장 경계이고 소스 줄바꿈은 아니다', () => {
  const { parseHtml, textOf, BR_SENTINEL } = require('../lib/html-parse');

  // <br>: 경계 O
  assert.equal(countSentences(textOf(parseHtml('<p>첫 문장입니다<br>둘째 문장입니다</p>').root)), 2);
  assert.equal(countSentences(`가${BR_SENTINEL}나${BR_SENTINEL}다`), 3);

  // HTML 소스 줄바꿈: 경계 X. 같은 한 문장이 소스에서 접혀 있다는 이유만으로
  // 2문장이 되면 text-after-figure(error)가 조용히 통과한다.
  assert.equal(countSentences(textOf(parseHtml('<p>사진 속 간판이\n인상적이었다</p>').root)), 1);
  assert.equal(countSentences('첫 문장입니다\n둘째 문장입니다'), 1);

  // 센티널이 글자수를 오염시키지 않는다
  assert.equal(
    countChars(textOf(parseHtml('<p>가나다<br>라마바</p>').root)),
    countChars('가나다 라마바'),
  );
});

test('splitSentences — …도 문장 끝이다 (…만 빼면 과소 계산)', () => {
  assert.equal(countSentences('망설였다… 그래도 갔다.'), 2);
  assert.equal(countSentences('망설였다&hellip; 그래도 갔다.'), 2);
  // 중간 줄임표는 여전히 경계가 아니다
  assert.equal(countSentences('a…b 하나뿐'), 1);
});

test('splitSentences — 엔티티를 두 번 디코드하지 않는다', () => {
  // splitSentences가 자체 decodeEntities를 호출하고 splitOneLine의
  // normalizeWhitespace가 또 호출하면, 화면에 `&lt;`로 보여야 하는
  // `&amp;lt;`가 `<`가 된다.
  assert.deepEqual(splitSentences('a &amp;lt; b 하나.'), ['a &lt; b 하나.']);
  assert.deepEqual(splitSentences('a &amp;amp; b 하나.'), ['a &amp; b 하나.']);
  // 한 번 디코드는 정상
  assert.deepEqual(splitSentences('a &amp; b 하나.'), ['a & b 하나.']);
});

// --- 9차 리뷰 회귀 ---

test('URL 마스킹이 문장 종결 마침표를 삼키지 않는다', () => {
  // `\S+`로 URL을 잡으면 종결 마침표까지 마스킹돼 두 문장이 하나로 합쳐진다.
  // text-after-figure는 error 등급이고 **우회 플래그가 없으므로**, CLAUDE.md와
  // visit-research.md가 지시한 "공식 홈페이지 링크는 마무리 단락에 배치"를
  // 지킨 초안이 exit 8로 차단됐다.
  assert.equal(countSentences('공식 홈페이지는 https://www.example.com/info. 주차는 무료였다.'), 2);
  assert.equal(countSentences('자세한 메뉴는 www.example.co.kr/menu. 가격은 착한 편이었다.'), 2);
  assert.equal(countSentences('https://x.com/a?b=1&c=2 를 참고. 끝.'), 2);
  assert.deepEqual(
    splitSentences('공식 홈페이지는 https://www.example.com/info. 주차는 무료였다.'),
    ['공식 홈페이지는 https://www.example.com/info.', '주차는 무료였다.'],
  );

  // URL 안의 마침표는 여전히 경계가 아니다 (뒤에 공백이 없다)
  assert.equal(countSentences('링크는 https://example.com/a.html 였다.'), 1);
  assert.equal(countSentences('파일은 photo-01.webp 이다.'), 1);
  assert.equal(countSentences('사이트는 www.example.co.kr 이다.'), 1);
});

test('번호 목록 접두사는 문장 경계가 아니다', () => {
  // 마스킹하지 않으면 번호만 붙여도 "이미지 다음 2문장" 요건이 충족돼
  // text-after-figure가 우회된다 (위 URL 오탐과 같은 결함의 반대쪽).
  assert.equal(countSentences('1. 첫째 2. 둘째'), 1);
  assert.equal(countSentences('메뉴는 이렇다. 1. 파스타 2. 리조또'), 2);
  // 소수점·버전은 원래대로
  assert.equal(countSentences('가격은 12.5만원이었다.'), 1);
  // 문장 끝의 숫자+마침표는 여전히 경계다 (뒤에 공백+내용)
  assert.equal(countSentences('가격은 12000. 비싸지 않았다.'), 2);
});

test('번호 목록 마스킹은 과소 계산을 만들지 않는다 (개수로 판정)', () => {
  // 목록 접두사와 "숫자로 끝난 문장"은 문법적으로 같다. 무조건 마스킹하면
  // 진짜 문장 경계를 먹어 **과소 계산**이 되고, text-after-figure(error,
  // 우회 불가)가 정당한 초안을 막는다. 한 조각에 두 개 이상일 때만 목록으로 본다.
  assert.equal(countSentences('총 15. 다음 문장이다.'), 2, '진짜 문장 경계를 먹음');
  assert.equal(countSentences('1. 첫째 2. 둘째'), 1, '목록이 문장으로 셈됨');
  assert.equal(countSentences('메뉴는 이렇다. 1. 파스타 2. 리조또'), 2);
  assert.equal(countSentences('방문일은 2026. 5. 10. 이었다.'), 1, '한국식 날짜 표기');
  assert.equal(countSentences('가격은 12.5만원이었다.'), 1);
});

// --- 19차 리뷰 회귀 ---

test('도형 문자는 이모지가 아니다 (프로젝트가 쓰라고 지시하는 표기)', () => {
  // ■□▲△▼▽◆◇○●는 유니코드 어느 속성으로도 이모지가 아니고(ExtPict/EmojiPres/
  // Emoji 전부 false), style-guide가 금지한 목록("체크표시, 별, 불꽃, 핀")에도
  // 없다. 손으로 추가한 것이었다.
  //
  // 그리고 `○`는 이 프로젝트가 **쓰라고 지시하는 표기**다 — blog-draft.md의
  // "지난 ○월 ○일", workflow-steps.md의 "여기 ○○ 맞나요?", 그리고 lint 자신의
  // no-writing-date-expression error 메시지까지. 지시를 따른 초안이
  // no-emoji(error, 우회 플래그 없음)로 막혔고 원인도 알 수 없었다.
  for (const c of ['○', '●', '■', '□', '▲', '△', '▼', '▽', '◆', '◇']) {
    assert.deepEqual(findEmoji(c), [], `${c} 가 이모지로 잡힘`);
  }
  assert.deepEqual(findEmoji('지난 ○월 ○일 다녀왔다'), []);
  assert.deepEqual(findEmoji('홍길○ 사장님'), []);

  // style-guide가 명시적으로 금지한 것은 계속 잡는다
  for (const c of ['★', '☆', '✓', '☞', '♬', '🔥', '📍']) {
    assert.equal(findEmoji(c).length, 1, `${c} 미탐`);
  }
});

test('계량이 유니코드 정규화에 안정적이다 (NFD)', () => {
  // 문장 조각 필터 `/[가-힣A-Za-z0-9]/`와 경계 lookahead `(?=[가-힣A-Z])`는
  // NFD 자모(U+1100~U+11FF)를 하나도 매칭하지 못한다. 같은 초안이 정규화 형태에
  // 따라 세 방향으로 다 깨졌다 (실측: 2356자/error 0 → 4681자/error 4건,
  // "0문장뿐입니다"인데 문단마다 세 문장이 보인다). macOS 파일 시스템·일부
  // 편집기·클립보드가 NFD를 만든다.
  const text = '첫 문장이 보였다. 문을 열자 향이 났다. 자리에 앉았다.';
  const nfd = text.normalize('NFD');
  assert.notEqual(text, nfd, '전제: 두 형태가 다르다');

  assert.equal(countChars(nfd), countChars(text));
  assert.equal(countSentences(nfd), countSentences(text));
  assert.deepEqual(splitSentences(nfd), splitSentences(text));
  assert.equal(normalizeWhitespace(nfd), normalizeWhitespace(text));
});

test('보이지 않는 문자로 분량 게이트를 뚫을 수 없다', () => {
  // `\s`는 U+200B(ZWSP)·U+200C·U+2060을 매칭하지 않는다. 실측: 1396자 초안에
  // ZWSP 405개를 넣으면 bodyChars 1801로 측정돼 body-min-chars(error)를 통과했다.
  // 리서치 텍스트를 웹에서 복사하면 ZWSP가 실제로 섞여 들어온다.
  const cpOf = (n) => String.fromCodePoint(n);
  for (const cp of [0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x00AD, 0x180E]) {
    const padded = `가나다${cpOf(cp).repeat(500)}`;
    assert.equal(countChars(padded), 3,
      `U+${cp.toString(16).toUpperCase()} 500개가 글자수로 셈됨: ${countChars(padded)}`);
  }
  // 보이지 않는 문자만 있으면 빈 문자열이다 (alt 검사가 이것을 쓴다)
  assert.equal(normalizeWhitespace(cpOf(0x200B)), '');
  // <br> 센티널은 공백으로 남는다 (문장 경계 역할)
  assert.equal(normalizeWhitespace(`가${cpOf(0)}나`), '가 나');
  // 보이는 문자는 그대로
  assert.equal(countChars('가나다'), 3);
});
