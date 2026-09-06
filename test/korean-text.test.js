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
  for (const c of [cp(0x2713), cp(0x2605), cp(0x2606), cp(0x266C), cp(0x261E), cp(0x25A0), cp(0x25CF)]) {
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

test('두 규칙의 문자 집합은 겹치지 않는다 — 맨 형태와 VS16 형태 모두 (불변식)', () => {
  // 1차 수정은 `[...g].length === 1` 가드를 써서 VS16이 붙은 형태를 놓쳤다.
  // ↔️ 가 no-emoji(error)와 decorative-arrow(warn)에 동시에 걸렸고, 사용자에게는
  // "↔ 는 통과하는데 ↔️ 는 막히는" (대부분 폰트에서 구별 안 되는) 규칙이 됐다.
  const VS16 = '\uFE0F';
  for (let cp = 0x2190; cp <= 0x21FF; cp += 1) {
    const bare = String.fromCodePoint(cp);
    assert.deepEqual(findEmoji(bare), [], `U+${cp.toString(16)} 맨 형태가 이모지로 잡힘`);
    assert.equal(findDecorativeArrows(bare).length, 1, `U+${cp.toString(16)} 맨 형태가 화살표로 안 잡힘`);

    const vs = bare + VS16;
    assert.equal(findEmoji(vs).length, 1, `U+${cp.toString(16)}+VS16이 이모지로 안 잡힘`);
    assert.deepEqual(findDecorativeArrows(vs), [], `U+${cp.toString(16)}+VS16이 화살표로도 잡힘`);
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

test('splitSentences — <br>이 만든 줄바꿈은 문장 경계다', () => {
  assert.equal(countSentences('첫 문장입니다\n둘째 문장입니다'), 2);
  assert.equal(countSentences('가.\n나.\n다.'), 3);
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
