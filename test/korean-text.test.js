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
