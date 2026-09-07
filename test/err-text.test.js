// lib/err-text.js — "예외에서 문구를 뽑다가 예외가 나면 원래 예외가 사라진다"를 막는다.
//
// 이 저장소에서 그 실패가 만든 사고: naver-dom이 NaverError(exit 12)를 만들기
// 전에 dumpFailure를 await하는데 그쪽에서 TypeError가 나면 exit 12가 exit 1이
// 됐고, naver-doctor는 세션 행에서 죽어 **셀렉터 게이트를 통째로 건너뛰었다.**

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { errCodeTag, errFull, errText } = require('../lib/err-text');

const THROWN = [
  ['Error', new Error('첫 줄\n둘째 줄'), '첫 줄', '첫 줄\n둘째 줄'],
  ['문자열 throw', '보스', '보스', '보스'],
  ['여러 줄 문자열', 'a\nb', 'a', 'a\nb'],
  ['undefined reject', undefined, '', ''],
  ['null reject', null, '', ''],
  ['숫자', 42, '42', '42'],
  ['message 없는 객체', {}, '[object Object]', '[object Object]'],
  ['message가 빈 문자열', Object.assign(new Error(''), {}), 'Error', 'Error'],
  ['message가 숫자', { message: 7 }, '[object Object]', '[object Object]'],
];

test('errText/errFull — 어떤 값이 던져져도 던지지 않는다', () => {
  for (const [label, thrown, expectedText, expectedFull] of THROWN) {
    assert.equal(errText(thrown), expectedText, `errText(${label})`);
    assert.equal(errFull(thrown), expectedFull, `errFull(${label})`);
  }
});

test('errFull — toString이 던지는 객체에서도 살아남는다', () => {
  const hostile = { get message() { throw new Error('trap'); } };
  // getter가 던지면 errFull 자체가 죽어 원래 예외를 가린다
  assert.doesNotThrow(() => errFull(hostile));
});

test('errCodeTag — 진단 코드를 삼키지 않는다', () => {
  assert.equal(errCodeTag(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), ' (EAI_AGAIN)');
  assert.equal(errCodeTag(new Error('x')), '');
  assert.equal(errCodeTag(null), '');
  assert.equal(errCodeTag('문자열'), '');
});

test('err.message를 직접 만지는 코드가 새로 늘지 않는다 (구조적 강제)', () => {
  // 라운드 1~6에서 같은 결함이 반복된 이유는 "이 catch에도 가드를 넣는다"를
  // 매번 손으로 했기 때문이다. 남아 있어도 되는 예외는 명시적으로 열거한다.
  const ALLOWED = new Set([
    // 대입(감싸기)이므로 읽기가 아니다
    'scripts/publish-post.js',
  ]);
  const READ_RE = /(?<![.\w])(err|[A-Za-z_$][\w$]*(?:Err|Error|error))\.message\b(?!\s*=[^=])/;
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of ['lib', 'scripts']) {
    for (const f of fs.readdirSync(path.join(root, rel)).filter((n) => n.endsWith('.js'))) {
      const p = `${rel}/${f}`;
      if (p === 'lib/err-text.js' || ALLOWED.has(p)) continue;
      const src = fs.readFileSync(path.join(root, p), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//')) return;      // 주석은 설명이다
        if (READ_RE.test(line)) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [],
    `err.message를 직접 읽는 곳이 있습니다. lib/err-text.js의 errText/errFull을 쓰세요:\n${offenders.join('\n')}`);
});
