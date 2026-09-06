// Intl.Segmenter가 없는 환경용 폴백 검증.
//
// 화살표 규칙의 배타성은 "두 함수가 같은 단위(grapheme)를 본다"에 기대는데,
// 그 단위가 환경에 따라 달라지면 보장이 무너진다. 예전 폴백은 `[...text]`라
// "↔ + VS16"을 두 조각으로 쪼개, 화살표는 warn에 VS16은 error에 각각 걸렸다
// (실측 448건). 이 파일은 폴백이 Segmenter와 같은 클러스터를 만드는지,
// 그리고 폴백 경로에서도 배타성이 유지되는지 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fallbackGraphemes } = require('../lib/korean-text');

const cp = (...a) => String.fromCodePoint(...a);
const VS15 = cp(0xFE0E);
const VS16 = cp(0xFE0F);
const KEYCAP = cp(0x20E3);
const ZWJ = cp(0x200D);
const SKIN = cp(0x1F3FB);

function segmenterGraphemes(text) {
  return [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)]
    .map((s) => s.segment);
}

test('fallbackGraphemes — Intl.Segmenter와 같은 클러스터를 만든다', () => {
  const cases = [
    '가나다', 'hello', '', ' ',
    cp(0x1F600) + cp(0x1F525),
    '↔', `↔${VS16}`, `↔${VS15}`, `↔${KEYCAP}`, `↔${ZWJ}❤`, `↔${SKIN}`,
    cp(0x1F1F0) + cp(0x1F1F7),                                  // 국기
    cp(0x1F1F0) + cp(0x1F1F7) + cp(0x1F1EF) + cp(0x1F1F5),      // 국기 두 개 연속
    cp(0x1F468) + ZWJ + cp(0x1F469) + ZWJ + cp(0x1F467),        // ZWJ 가족
    cp(0x1F44D) + SKIN,                                          // 피부톤
    `3${VS16}${KEYCAP}`,                                         // keycap 숫자
    `가${cp(0x0301)}`,                                           // 결합 악센트
    '잠실역 → 소피텔 ↔ 석촌호수',
  ];
  for (const t of cases) {
    assert.deepEqual(
      fallbackGraphemes(t),
      segmenterGraphemes(t),
      `클러스터 불일치: ${JSON.stringify(t)}`,
    );
  }
});

test('Segmenter가 없어도 화살표 규칙의 배타성이 유지된다', () => {
  // 모듈을 새로 로드해 폴백 경로를 강제한다. Segmenter는 즉시 복원한다.
  const saved = Intl.Segmenter;
  delete Intl.Segmenter;
  delete require.cache[require.resolve('../lib/korean-text')];
  try {
    const { findEmoji, findDecorativeArrows } = require('../lib/korean-text');
    const suffixes = ['', VS15, VS16, KEYCAP, ZWJ + '❤', SKIN];
    for (let code = 0x2190; code <= 0x21FF; code += 1) {
      const bare = String.fromCodePoint(code);
      for (const suffix of suffixes) {
        const s = bare + suffix;
        const emoji = findEmoji(s).length > 0;
        const arrow = findDecorativeArrows(s).length > 0;
        const label = `U+${code.toString(16)} + ${JSON.stringify(suffix)}`;
        assert.ok(!(emoji && arrow), `${label}: 폴백 경로에서 동시 매칭`);
        assert.ok(emoji || arrow, `${label}: 폴백 경로에서 미분류`);
      }
    }
    // 진짜 이모지 탐지도 유지되어야 한다
    for (const c of [cp(0x1F600), cp(0x2713), cp(0x2605), cp(0x260E)]) {
      assert.equal(findEmoji(c).length, 1, `폴백 경로에서 ${c} 미탐`);
    }
  } finally {
    Intl.Segmenter = saved;
    delete require.cache[require.resolve('../lib/korean-text')];
  }
});
