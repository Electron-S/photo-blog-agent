const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractSlugFromUrl,
  loadSlugFromMetadata,
  parsePrimaryDate,
  slugMatchesWithAutoSuffix,
  validateSlugArg,
} = require('../lib/slug');

test('slugMatchesWithAutoSuffix — Blogger 자동 suffix만 통과', () => {
  assert.equal(slugMatchesWithAutoSuffix('2026-05-10', '2026-05-10'), true);
  assert.equal(slugMatchesWithAutoSuffix('2026-05-10-1', '2026-05-10'), true);
  assert.equal(slugMatchesWithAutoSuffix('2026-05-10-12', '2026-05-10'), true);

  // 자동 suffix는 숫자만이다. 알파벳 suffix는 다른 글이므로 거부해야 한다.
  assert.equal(slugMatchesWithAutoSuffix('2026-05-10-a', '2026-05-10'), false);
  assert.equal(slugMatchesWithAutoSuffix('2026-05-11', '2026-05-10'), false);
  assert.equal(slugMatchesWithAutoSuffix('prefix-2026-05-10', '2026-05-10'), false);
  assert.equal(slugMatchesWithAutoSuffix('', '2026-05-10'), false);
});

test('slugMatchesWithAutoSuffix — 짧은 prefix false positive (알려진 한계)', () => {
  // requested가 너무 짧으면 다른 날짜의 글이 "자동 suffix"로 오인된다.
  // 자동화 경로는 --slug-from-date로 항상 YYYY-MM-DD를 강제하므로 발생하지 않지만,
  // 수동 --slug로 짧은 prefix를 넣으면 안 된다는 사실을 테스트로 고정한다.
  assert.equal(slugMatchesWithAutoSuffix('2026-05-10', '2026-05'), true);
});

test('extractSlugFromUrl', () => {
  assert.equal(
    extractSlugFromUrl('https://electronian-review.blogspot.com/2026/05/2026-05-10.html'),
    '2026-05-10',
  );
  assert.equal(extractSlugFromUrl('https://x.com/a/b/2026-05-10-1.html'), '2026-05-10-1');
  assert.equal(extractSlugFromUrl('https://x.com/no-extension'), null);
  assert.equal(extractSlugFromUrl(null), null);
  assert.equal(extractSlugFromUrl(undefined), null);
});

test('validateSlugArg — 문자 집합', () => {
  assert.equal(validateSlugArg('2026-05-10').ok, true);
  assert.equal(validateSlugArg('seokchon-lake-spring').ok, true);
  assert.equal(validateSlugArg('abc123').ok, true);

  assert.equal(validateSlugArg('한글').ok, false);
  assert.equal(validateSlugArg('has space').ok, false);
  assert.equal(validateSlugArg('under_score').ok, false);
  assert.equal(validateSlugArg('').ok, false);
  assert.equal(validateSlugArg('   ').ok, false);
  assert.equal(validateSlugArg(null).ok, false);
});

test('validateSlugArg — 날짜 슬러그는 zero-padding 강제', () => {
  // URL이 영구 고정되므로 "2026-5-4"와 "2026-05-04"가 섞이면 색인에 악영향.
  const r = validateSlugArg('2026-5-4');
  assert.equal(r.ok, false);
  assert.match(r.error, /zero-padding/);
  assert.match(r.error, /2026-05-04/);

  assert.equal(validateSlugArg('2026-05-04').ok, true);
});

test('validateSlugArg — 달력에 없는 날짜 거부', () => {
  assert.equal(validateSlugArg('2026-13-99').ok, false);
  assert.equal(validateSlugArg('2026-02-30').ok, false);
  assert.equal(validateSlugArg('2026-00-10').ok, false);
  // 2024는 윤년, 2026은 아님
  assert.equal(validateSlugArg('2024-02-29').ok, true);
  assert.equal(validateSlugArg('2026-02-29').ok, false);
});

test('validateSlugArg — 날짜처럼 안 보이는 슬러그는 달력 검증 대상 아님', () => {
  assert.equal(validateSlugArg('99999-99-99-cafe').ok, true);
});

test('parsePrimaryDate', () => {
  assert.equal(parsePrimaryDate({ primary_date: '2026-05-10' }), '2026-05-10');

  assert.throws(() => parsePrimaryDate({ primary_date: null }), /null이거나 문자열이 아닙니다/);
  assert.throws(() => parsePrimaryDate({}), /null이거나 문자열이 아닙니다/);
  assert.throws(() => parsePrimaryDate({ primary_date: '2026-5-10' }), /YYYY-MM-DD 형식이 아닙니다/);
  assert.throws(() => parsePrimaryDate({ primary_date: '2026-02-30' }), /유효한 달력 날짜가 아닙니다/);
  assert.throws(() => parsePrimaryDate(null), /최상위 타입이 객체가 아닙니다/);
  assert.throws(() => parsePrimaryDate([]), /최상위 타입이 객체가 아닙니다/);
  assert.throws(() => parsePrimaryDate('str'), /최상위 타입이 객체가 아닙니다/);
});

test('loadSlugFromMetadata — 파일에서 읽기', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-slug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const good = path.join(dir, 'meta.json');
  fs.writeFileSync(good, JSON.stringify({ primary_date: '2026-05-10' }), 'utf8');
  assert.equal(loadSlugFromMetadata(good), '2026-05-10');

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json', 'utf8');
  assert.throws(() => loadSlugFromMetadata(broken));

  assert.throws(() => loadSlugFromMetadata(path.join(dir, 'missing.json')));
});
