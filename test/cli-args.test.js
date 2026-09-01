const test = require('node:test');
const assert = require('node:assert/strict');
const { createCliArgs } = require('../lib/cli-args');

function throwing(argv) {
  return createCliArgs(argv, (msg) => { throw new Error(msg); });
}

test('getArg — 값 조회', () => {
  const c = throwing(['--title', '안녕하세요', '--post-id', '123']);
  assert.equal(c.getArg('--title'), '안녕하세요');
  assert.equal(c.getArg('--post-id'), '123');
  assert.equal(c.getArg('--missing'), null);
});

test('getArg — 값 누락과 플래그가 값 자리에 온 경우 거부', () => {
  assert.throws(() => throwing(['--title']).getArg('--title'), /값이 필요합니다/);
  assert.throws(
    () => throwing(['--title', '--content', 'x']).getArg('--title'),
    /또 다른 플래그/,
  );
});

test('getArg — 빈 문자열은 값으로 통과시킨다', () => {
  // 빈 값의 의미 판단은 호출자 몫이다 (publish-post.js는 변수 치환 실패로 보고 거부).
  assert.equal(throwing(['--slug', '']).getArg('--slug'), '');
});

test('validateKnownFlags — 미지 플래그와 중복 거부', () => {
  assert.equal(throwing(['--title', 'x']).validateKnownFlags(['--title']), undefined);
  assert.throws(
    () => throwing(['--nope']).validateKnownFlags(['--title']),
    /알 수 없는 플래그/,
  );
  assert.throws(
    () => throwing(['--title', 'a', '--title', 'b']).validateKnownFlags(['--title']),
    /중복 지정/,
  );
});

test('validateKnownFlags — 위치 인자는 통과', () => {
  assert.equal(
    throwing(['a.jpg', 'b.jpg', '--output', 'o.json']).validateKnownFlags(['--output']),
    undefined,
  );
});

test('모듈 기본 export는 process.argv 기반 (require만으로 죽지 않음)', () => {
  const m = require('../lib/cli-args');
  assert.equal(typeof m.getArg, 'function');
  assert.equal(typeof m.validateKnownFlags, 'function');
  assert.equal(typeof m.createCliArgs, 'function');
});
