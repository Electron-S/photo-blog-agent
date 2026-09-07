const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STEPS, SessionStateError, assertSlug, defaultState, listStates, markCompleted,
  normalizeState, nowKst, readState, remainingFrom, statePath, touch, writeStateAtomic,
} = require('../lib/session-state');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('nowKst — 고정 Date로 결정적, 실행 머신 타임존 무관', () => {
  // 2026-05-10T00:00:00Z → KST 09:00
  assert.equal(nowKst(new Date('2026-05-10T00:00:00Z')), '2026-05-10T09:00:00+09:00');
  // 날짜 경계를 넘는 경우
  assert.equal(nowKst(new Date('2026-05-10T20:00:00Z')), '2026-05-11T05:00:00+09:00');
  assert.match(nowKst(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
});

test('assertSlug — 경로 traversal과 대문자 거부', () => {
  assert.equal(assertSlug('jamsil-cafe'), 'jamsil-cafe');
  assert.equal(assertSlug('a1'), 'a1');

  for (const bad of ['../../etc/passwd', 'a/b', 'UPPER', '-lead', '', null, undefined, '한글', 'a b', 'a_b']) {
    assert.throws(() => assertSlug(bad), SessionStateError, `${JSON.stringify(bad)}를 통과시킴`);
  }
});

test('statePath — slug 검증을 거친다', () => {
  assert.equal(statePath('x', 'tmp'), path.join('tmp', 'session-state-x.json'));
  assert.throws(() => statePath('../x', 'tmp'), SessionStateError);
});

test('remainingFrom — 두 배열은 항상 완전한 분할', () => {
  assert.deepEqual(remainingFrom([]), STEPS);
  assert.deepEqual(remainingFrom(STEPS), []);
  assert.deepEqual(remainingFrom(['exif', 'upload']), ['photo_analysis', 'research', 'draft', 'publish']);
});

test('markCompleted — STEPS 순서로 정렬, 중복 무시, 미지 단계 거부', () => {
  const s = defaultState('x');
  const a = markCompleted(s, ['upload', 'exif']);
  assert.deepEqual(a.steps_completed, ['exif', 'upload']);
  assert.deepEqual(a.steps_remaining, ['photo_analysis', 'research', 'draft', 'publish']);

  const b = markCompleted(a, ['exif', 'research']);
  assert.deepEqual(b.steps_completed, ['exif', 'upload', 'research']);

  assert.throws(() => markCompleted(s, ['bogus']), SessionStateError);
});

test('touch — last_updated만 바꾼다', () => {
  const s = defaultState('x');
  const t = touch(s, new Date('2026-05-10T00:00:00Z'));
  assert.equal(t.last_updated, '2026-05-10T09:00:00+09:00');
  assert.deepEqual(t.steps_completed, s.steps_completed);
});

test('normalizeState — schema_version 없는 옛 파일', () => {
  const { state, warnings } = normalizeState(
    { slug: 'x', steps_completed: ['exif'] },
    { slug: 'x' },
  );
  assert.equal(state.schema_version, 1);
  assert.ok(warnings.some((w) => w.includes('schema_version')));
});

test('normalizeState — steps_remaining 불일치는 재계산 + 경고', () => {
  const { state, warnings } = normalizeState(
    { slug: 'x', steps_completed: ['exif', 'upload'], steps_remaining: ['publish'] },
    { slug: 'x' },
  );
  assert.deepEqual(state.steps_remaining, ['photo_analysis', 'research', 'draft', 'publish']);
  assert.ok(warnings.some((w) => w.includes('어긋나')));
});

test('normalizeState — 알 수 없는 최상위 키를 보존한다 (데이터 손실 금지)', () => {
  const { state } = normalizeState(
    { slug: 'x', steps_completed: [], custom: '보존', post_id: '123' },
    { slug: 'x' },
  );
  assert.equal(state.custom, '보존');
  assert.equal(state.post_id, '123');
});

test('normalizeState — 미지 단계: read는 격리, update는 거부', () => {
  const lenient = normalizeState(
    { slug: 'x', steps_completed: ['exif', 'bogus'] },
    { slug: 'x' },
  );
  assert.deepEqual(lenient.state.steps_completed, ['exif']);
  assert.deepEqual(lenient.state.unknown_steps, ['bogus']);
  assert.ok(lenient.warnings.some((w) => w.includes('bogus')));

  assert.throws(
    () => normalizeState({ slug: 'x', steps_completed: ['bogus'] }, { slug: 'x', strict: true }),
    SessionStateError,
  );
});

test('normalizeState — 구조 오류는 거부', () => {
  assert.throws(() => normalizeState(null, { slug: 'x' }), SessionStateError);
  assert.throws(() => normalizeState([], { slug: 'x' }), SessionStateError);
  assert.throws(() => normalizeState({}, { slug: 'x' }), SessionStateError);
  // 파일명 slug와 내용 slug 불일치 = 파일이 뒤섞였다는 신호
  assert.throws(() => normalizeState({ slug: 'other' }, { slug: 'x' }), SessionStateError);
});

test('writeStateAtomic / readState 왕복', (t) => {
  const dir = tmpDir(t);
  const s = touch(markCompleted(defaultState('x', { primary_date: '2026-05-10' }), ['exif']));
  const p = writeStateAtomic('x', dir, s);

  assert.ok(fs.existsSync(p));
  assert.ok(!fs.existsSync(`${p}.tmp`), '.tmp 잔여물이 남았습니다');

  const back = readState('x', dir);
  assert.deepEqual(back.state, s);
  assert.deepEqual(back.warnings, []);
});

test('writeStateAtomic — UTF-8, LF 개행, 끝 개행', (t) => {
  const dir = tmpDir(t);
  const p = writeStateAtomic('x', dir, defaultState('x', { draft_path: 'tmp/한글-경로.html' }));
  const bytes = fs.readFileSync(p);
  assert.ok(!bytes.includes(0x0D), 'CRLF가 섞였습니다');
  assert.ok(bytes.toString('utf8').includes('한글-경로'));
  assert.ok(bytes.toString('utf8').endsWith('\n'));
});

test('readState — 없으면 null, 깨진 JSON은 원본을 보존하며 exit 9 에러', (t) => {
  const dir = tmpDir(t);
  assert.equal(readState('missing', dir), null);

  const broken = path.join(dir, 'session-state-broken.json');
  fs.writeFileSync(broken, '{bad json', 'utf8');
  let thrown;
  try { readState('broken', dir); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof SessionStateError);
  assert.equal(thrown.exitCode, 9);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{bad json', '원본이 변경됨');
});

test('listStates — 정상과 손상을 함께 보고', (t) => {
  const dir = tmpDir(t);
  writeStateAtomic('aaa', dir, touch(defaultState('aaa')));
  fs.writeFileSync(path.join(dir, 'session-state-zzz.json'), '{bad', 'utf8');
  fs.writeFileSync(path.join(dir, 'metadata-2026-05-10.json'), '{}', 'utf8');

  const all = listStates(dir);
  assert.equal(all.length, 2, 'session-state-*.json만 대상이어야 함');
  assert.equal(all[0].slug, 'aaa');
  assert.ok(all[0].state);
  assert.equal(all[1].slug, 'zzz');
  assert.ok(all[1].error);
});

test('listStates — 디렉터리가 없으면 빈 배열', () => {
  assert.deepEqual(listStates(path.join(os.tmpdir(), 'pba-does-not-exist-xyz')), []);
});

test('전체 워크플로우 시나리오', (t) => {
  const dir = tmpDir(t);
  let s = touch(defaultState('jamsil-cafe', { primary_date: '2026-05-10' }));
  writeStateAtomic('jamsil-cafe', dir, s);

  // Step 3 종료
  s = touch(markCompleted(readState('jamsil-cafe', dir).state, ['exif', 'photo_analysis', 'upload']));
  writeStateAtomic('jamsil-cafe', dir, s);
  assert.deepEqual(s.steps_remaining, ['research', 'draft', 'publish']);

  // Step 5 종료
  s = readState('jamsil-cafe', dir).state;
  s = touch({ ...markCompleted(s, ['research', 'draft']), draft_path: 'tmp/draft-jamsil-cafe.html', post_id: '123' });
  writeStateAtomic('jamsil-cafe', dir, s);
  assert.deepEqual(s.steps_remaining, ['publish']);

  // Step 7 종료
  s = readState('jamsil-cafe', dir).state;
  s = touch({ ...markCompleted(s, ['publish']), post_url: 'https://x/2026-05-10.html' });
  writeStateAtomic('jamsil-cafe', dir, s);
  assert.deepEqual(s.steps_remaining, []);
  assert.equal(s.post_id, '123');
  assert.equal(s.post_url, 'https://x/2026-05-10.html');
});

// --- 7차 리뷰 회귀 ---

test('post_id가 있는데 draft가 완료가 아니면 잡는다 (prefix 검사만으로는 못 잡음)', () => {
  // `completed=[]`는 유효한 prefix라서 `completed=[] && post_id != null`이
  // 통과했다. 그 상태는 steps_completed가 문자열로 손상됐을 때 정확히
  // 만들어지고(빈 배열로 강등), 재개 규칙은 remaining[0]='exif'로 점프한다 —
  // Blogger에 글이 이미 있는데 처음부터 다시 돌려 두 번째 글을 만든다.
  const warnOf = (raw) => normalizeState(raw, { slug: raw.slug }).warnings
    .filter((w) => !/schema_version/.test(w));

  assert.match(warnOf({ slug: 'a', steps_completed: [], post_id: '555' })[0], /draft가 완료로 표시돼 있지 않/);
  assert.match(warnOf({ slug: 'b', steps_completed: 'exif,upload,draft', post_id: '555' }).join('\n'),
    /draft가 완료로 표시돼 있지 않/);
  // 정상 상태는 조용하다
  assert.deepEqual(warnOf({
    slug: 'c',
    steps_completed: ['exif', 'photo_analysis', 'upload', 'research', 'draft'],
    post_id: '555',
  }), []);
  assert.deepEqual(warnOf({ slug: 'd', steps_completed: ['exif'] }), []);

  // 쓰기 경로는 거부한다
  assert.throws(
    () => normalizeState({ slug: 'e', steps_completed: [], post_id: '1' }, { slug: 'e', strict: true }),
    (err) => err.exitCode === 9,
  );
});

test('workflow-steps.md가 지시하는 호출 순서가 전부 통과한다', () => {
  // 불변식이 정상 워크플로우를 막으면 그것도 결함이다. Step 3 → 5 → 7의
  // 실제 인자 조합을 그대로 재현한다 (--post-id 포함).
  const seq = [
    { steps_completed: ['exif', 'photo_analysis', 'upload'] },
    { steps_completed: ['exif', 'photo_analysis', 'upload', 'research', 'draft'], post_id: '999' },
    {
      steps_completed: ['exif', 'photo_analysis', 'upload', 'research', 'draft', 'publish'],
      post_id: '999',
      post_url: 'https://x/2026-05-10.html',
    },
  ];
  for (const fields of seq) {
    const raw = { schema_version: 1, slug: 'flow', ...fields };
    const { warnings } = normalizeState(raw, { slug: 'flow', strict: true });
    assert.deepEqual(warnings, [], `정상 단계를 막음: ${JSON.stringify(fields)}`);
  }
});

test('schema_version — 미래 버전 파일을 옛 의미로 덮어쓰지 않는다', () => {
  // 예전에는 undefined만 검사해서 2·99·null·"1"이 경고 없이 통과하고 그대로
  // 재기록됐다 — v1 코드가 v2 파일에 v1 의미를 적용하면서 파일은 계속 v2를 주장한다.
  assert.throws(() => normalizeState({ slug: 'a', schema_version: 2 }, { slug: 'a' }),
    /더 새 버전이 만든 파일/);
  assert.throws(() => normalizeState({ slug: 'a', schema_version: 99 }, { slug: 'a' }),
    /더 새 버전이 만든 파일/);
  // 손상된 값은 경고 후 1로 간주 (읽기는 관대하게)
  for (const bad of [null, '1', {}, 0, -1]) {
    const { state, warnings } = normalizeState({ slug: 'a', schema_version: bad }, { slug: 'a' });
    assert.equal(state.schema_version, 1, JSON.stringify(bad));
    assert.ok(warnings.some((w) => /schema_version/.test(w)), JSON.stringify(bad));
    // 쓰기는 거부
    assert.throws(
      () => normalizeState({ slug: 'a', schema_version: bad }, { slug: 'a', strict: true }),
      /덮어쓰지 않고 중단/,
      JSON.stringify(bad),
    );
  }
});

test('steps_remaining 비배열이 틀린 배열보다 조용하지 않다 (심각도 역전 방지)', () => {
  const warnOf = (raw) => normalizeState(raw, { slug: raw.slug }).warnings
    .filter((w) => /steps_remaining/.test(w));
  assert.equal(warnOf({ slug: 'a', steps_completed: ['exif'], steps_remaining: '손상' }).length, 1);
  assert.equal(warnOf({ slug: 'a', steps_completed: ['exif'], steps_remaining: ['틀림'] }).length, 1);
  assert.equal(warnOf({ slug: 'a', steps_completed: ['exif'] }).length, 0);
});
