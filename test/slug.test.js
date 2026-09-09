const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkDatePlausible,
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
  // **now를 주입한다.** 기본값 `new Date()`에 의존하면 시스템 시계가 2026-05-10보다
  // 이전인 머신(또는 CI)에서 이 테스트가 "미래 날짜"로 실패한다 — 실측으로
  // 시계를 1년 뒤로 돌리면 2건이 깨졌다. 타당성 자체는 별 테스트에서 확인한다.
  const NOW = { now: new Date('2026-09-07T00:00:00Z') };
  assert.equal(parsePrimaryDate({ primary_date: '2026-05-10' }, null, NOW), '2026-05-10');

  assert.throws(() => parsePrimaryDate({ primary_date: null }, null, NOW), /null이거나 문자열이 아닙니다/);
  assert.throws(() => parsePrimaryDate({}, null, NOW), /null이거나 문자열이 아닙니다/);
  assert.throws(() => parsePrimaryDate({ primary_date: '2026-5-10' }, null, NOW), /YYYY-MM-DD 형식이 아닙니다/);
  assert.throws(() => parsePrimaryDate({ primary_date: '2026-02-30' }, null, NOW), /유효한 달력 날짜가 아닙니다/);
  assert.throws(() => parsePrimaryDate(null, null, NOW), /최상위 타입이 객체가 아닙니다/);
  assert.throws(() => parsePrimaryDate([], null, NOW), /최상위 타입이 객체가 아닙니다/);
  assert.throws(() => parsePrimaryDate('str', null, NOW), /최상위 타입이 객체가 아닙니다/);
});

test('loadSlugFromMetadata — 파일에서 읽기', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-slug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  const good = path.join(dir, 'meta.json');
  fs.writeFileSync(good, JSON.stringify({ primary_date: '2026-05-10' }), 'utf8');
  // 시계 종속을 없애려고 now를 주입한다 (위 parsePrimaryDate 테스트와 같은 이유).
  assert.equal(loadSlugFromMetadata(good, { now: new Date('2026-09-07T00:00:00Z') }), '2026-05-10');

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json', 'utf8');
  assert.throws(() => loadSlugFromMetadata(broken));

  assert.throws(() => loadSlugFromMetadata(path.join(dir, 'missing.json')));
});

// --- 7차 리뷰 회귀 ---

test('사진 날짜의 타당성 — 카메라 시계 센티널이 URL로 고정되지 않는다', () => {
  // exif-reader는 `0000:00:00 00:00:00`을 Date.UTC(0,-1,0) = **1899-11-30**으로
  // 준다. 달력상 유효하므로 date_status "ok" → primary_date → --slug-from-date로
  // **Blogger URL이 1899-11-30으로 영구 고정**됐다. CLAUDE.md "URL 슬러그 —
  // 절대 규칙"상 삭제·재발행 없이는 복구 불가다.
  for (const bad of ['1899-11-30', '1970-01-01', '1989-12-31', '1900-01-01']) {
    assert.throws(() => parsePrimaryDate({ primary_date: bad }), /타당하지 않습니다/, bad);
    assert.ok(checkDatePlausible(bad), `${bad}가 타당하다고 판정됨`);
  }
  // 미래 날짜도 시계 오류다 (사진은 미래에 찍힐 수 없다)
  const now = new Date('2026-09-07T00:00:00Z');
  assert.ok(checkDatePlausible('2027-01-01', { now }));
  assert.ok(checkDatePlausible('2400-01-01', { now }));
  // 하루 여유 — 촬영 기기와 실행 머신의 타임존 차이
  assert.equal(checkDatePlausible('2026-09-08', { now }), null);
  assert.equal(checkDatePlausible('2026-09-09', { now }) !== null, true);
  // 정상 범위는 통과
  for (const ok of ['1990-01-01', '2020-02-29', '2026-05-10']) {
    assert.equal(checkDatePlausible(ok, { now }), null, ok);
    assert.equal(parsePrimaryDate({ primary_date: ok }, null, { now }), ok);
  }
});

test('슬러그 규칙은 한 곳뿐 — 발행이 통과한 슬러그는 session-state도 받는다', () => {
  // 예전에는 publish-post가 `^[a-zA-Z0-9-]+$`, session-state가
  // `^[a-z0-9][a-z0-9-]*$`였다. `--slug MyPost`가 발행을 통과해 **URL이 영구
  // 고정된 뒤** session-state가 exit 9로 죽었다 — 되돌릴 수 없는 작업 다음에
  // 세션이 깨지는 순서다.
  const { statePath } = require('../lib/session-state');
  const accepted = (slug) => { try { statePath(slug, 'tmp'); return true; } catch { return false; } };

  for (const slug of ['seokchon-lake', '2026-05-10', 'a', 'x1-2-3']) {
    assert.equal(validateSlugArg(slug).ok, true, `발행이 ${slug}를 거부`);
    assert.equal(accepted(slug), true, `발행은 통과했는데 session-state가 ${slug}를 거부`);
  }
  for (const slug of ['MyPost', '-leading', 'abc_def', 'Abc', '가나다']) {
    assert.equal(validateSlugArg(slug).ok, false, `발행이 ${slug}를 통과`);
  }
  // 발행이 통과하는 슬러그는 예외 없이 session-state도 받아야 한다 (반대는 허용)
  for (const slug of ['MyPost', '-2026-05-10', 'seokchon-lake', '2026-05-10']) {
    if (validateSlugArg(slug).ok) {
      assert.equal(accepted(slug), true, `${slug}: 발행 통과 후 session-state 거부 — 순서 사고`);
    }
  }
});

test('checkDatePlausible — 형식이 틀린 값을 "타당하다"고 통과시키지 않는다', () => {
  // `NaN < 1990`과 `NaN > limit`이 둘 다 false라서 'abc'·'2026'이 통과했다.
  // 지금은 모든 호출자가 먼저 정규식 검사를 하므로 도달하지 않지만, 형식이
  // 보장됐다고 가정하는 검증기는 호출자가 하나 늘면 조용히 뚫린다.
  const NOW = { now: new Date('2026-09-07T00:00:00Z') };
  for (const bad of ['abc', '2026', '2026-05', 'NaN-NaN-NaN', '', null, undefined, 123, {}]) {
    assert.ok(checkDatePlausible(bad, NOW), `${JSON.stringify(bad)}를 타당하다고 통과시킴`);
  }
  assert.equal(checkDatePlausible('2026-05-10', NOW), null);
});
