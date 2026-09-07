// CLI가 실제로 약속한 exit 코드를 내는지 검증한다.
// spawnSync로 프로세스를 띄우므로 셸 문법에 의존하지 않는다 (Windows CI 대응).
//
// 네트워크나 자격증명이 필요한 경로(create-draft, publish-post 등)는 여기서
// 다루지 않는다 — CI에는 .env가 없고, 실제 Blogger에 글을 만들어서도 안 된다.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'drafts');

function run(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });
}

test('lint-draft: 통과 초안은 exit 0', () => {
  const r = run('lint-draft.js', [path.join(FIXTURES, 'draft-toscano.html')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /통과/);
});

test('lint-draft: 규칙 위반은 exit 8', () => {
  const r = run('lint-draft.js', [path.join(FIXTURES, 'draft-seokchon-jbout.html')]);
  assert.equal(r.status, 8, r.stdout + r.stderr);
  assert.match(r.stdout, /h3-min-count/);
});

test('lint-draft: 본문 부족도 exit 8', () => {
  const r = run('lint-draft.js', [path.join(FIXTURES, 'draft-dongdaemun-visit.html')]);
  assert.equal(r.status, 8);
  assert.match(r.stdout, /body-min-chars/);
});

test('lint-draft: --format json은 파싱 가능한 JSON을 낸다', () => {
  const r = run('lint-draft.js', [path.join(FIXTURES, 'draft-seokchon-jbout.html'), '--format', 'json']);
  assert.equal(r.status, 8);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.errors));
  assert.equal(parsed.errors[0].rule, 'h3-min-count');
  assert.equal(parsed.stats.dimensionCheck, 'skipped');
});

test('lint-draft: 인자 오류는 exit 1 (8과 구분)', () => {
  assert.equal(run('lint-draft.js', []).status, 1);
  assert.equal(run('lint-draft.js', ['/nonexistent-draft.html']).status, 1);
  assert.equal(run('lint-draft.js', [path.join(FIXTURES, 'draft-toscano.html'), '--nope']).status, 1);
  assert.equal(run('lint-draft.js', [path.join(FIXTURES, 'draft-toscano.html'), '--format', 'xml']).status, 1);
});

test('lint-draft: 우회 플래그는 존재하지 않는다', () => {
  // --warn-only 같은 플래그가 생기면 "exit 코드 우회 금지" 규칙이 무력화된다.
  const r = run('lint-draft.js', [path.join(FIXTURES, 'draft-seokchon-jbout.html'), '--warn-only']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option/);
});

test('upload-images: 날짜 출처가 없으면 네트워크 전에 exit 5', () => {
  const r = run('upload-images.js', ['nonexistent.jpg']);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /멱등성/);
});

test('upload-images: --date 형식 오류는 exit 1', () => {
  assert.equal(run('upload-images.js', ['a.jpg', '--date', '2026-13-99']).status, 1);
  assert.equal(run('upload-images.js', ['a.jpg', '--date', '2026-2-3']).status, 1);
});

test('upload-images: 인자 없이 실행하면 usage를 낸다', () => {
  // 예전에는 이 검사가 날짜 해석 뒤에 있어서 exit 5(날짜 출처 미상)로 끝나고
  // usage가 나오지 않았다. --slug이 필수가 된 뒤로는 usage를 못 보면 무엇을
  // 넘겨야 하는지 알 방법이 없다. CLAUDE.md가 "인자 없이 실행하면 나오는
  // usage로 확인"하라고 안내하는 것도 이 때문이다.
  const r = run('upload-images.js', []);
  assert.equal(r.status, 1, `status=${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Usage: node upload-images\.js/);
  assert.match(r.stdout, /--slug/);
  assert.match(r.stderr, /at least one image path/);
  // npm run assets:upload도 같은 결과여야 한다 (인자 없는 별칭)
  assert.doesNotMatch(r.stderr, /exit 5/);
});

test('upload-images: --slug은 필수이고 정규형이어야 한다 (폴더 덮어쓰기 방지)', () => {
  const withDate = (extra) => run('upload-images.js', ['a.jpg', '--date', '2026-05-10', ...extra]);

  // 생략 → 같은 날짜의 모든 글이 같은 폴더를 쓴다
  const missing = withDate([]);
  assert.equal(missing.status, 1, `status=${missing.status}`);
  assert.match(missing.stderr, /--slug/);

  // 전부 붕괴 / **부분** 붕괴 / 비정규형 — 전부 거부
  for (const bad of ['경복궁', 'trip-경복궁', 'My_Post', '-lead', 'a--b', 'a b']) {
    const r = withDate(['--slug', bad]);
    assert.equal(r.status, 1, `--slug ${bad} 가 통과함 (status=${r.status})`);
    assert.match(r.stderr, /--slug/);
  }

  // 정규형 slug는 slug 게이트를 통과한다 (파일이 없어서 다음 단계에서 멈춘다)
  for (const good of ['seokchon-lake', '2026-05-10']) {
    const r = withDate(['--slug', good]);
    assert.match(r.stderr, /file not found/, `--slug ${good} 가 slug 게이트에서 막힘`);
  }
});

test('upload-images: exit 5의 원인을 구별해서 보고한다', (t) => {
  // 카메라 시계 오류(implausible)와 EXIF 날짜 없음은 조치가 다르다.
  // 예전에는 둘 다 "EXIF 날짜 없는 사진"으로 보고해 전자에서 엉뚱한 진단이 나갔다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-d5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name, obj) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
  };
  const clockError = write('clock.json', {
    primary_date: null,
    photos: [{ file: 'a.jpg', date: '1899-11-30T00:00:00+09:00', date_status: 'implausible' }],
  });
  const noDate = write('nodate.json', {
    primary_date: null,
    photos: [{ file: 'a.jpg', date: null, date_status: 'missing' }],
  });

  const r1 = run('upload-images.js', ['a.jpg', '--metadata', clockError, '--slug', 'x']);
  assert.equal(r1.status, 5);
  assert.match(r1.stderr, /카메라 시계 오류 의심/);
  assert.match(r1.stderr, /1899-11-30/, 'EXIF에 박힌 값을 보여주지 않음');

  const r2 = run('upload-images.js', ['a.jpg', '--metadata', noDate, '--slug', 'x']);
  assert.equal(r2.status, 5);
  assert.match(r2.stderr, /EXIF 날짜 없는 사진/);
  assert.doesNotMatch(r2.stderr, /카메라 시계/, '두 원인이 구별되지 않음');
});

test('extract-exif: 지원 이미지가 없으면 exit 3', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const txt = path.join(dir, 'note.txt');
  fs.writeFileSync(txt, 'not an image', 'utf8');

  assert.equal(run('extract-exif.js', [txt]).status, 3);
  assert.equal(run('extract-exif.js', []).status, 1);
});

test('publish-post: 슬러그 미지정은 exit 6, 빈 슬러그는 exit 1', () => {
  // 두 경우 모두 Blogger API에 닿기 전에 거부되므로 자격증명이 필요 없다.
  const noSlug = run('publish-post.js', ['--post-id', '1']);
  assert.equal(noSlug.status, 6, noSlug.stdout + noSlug.stderr);

  const empty = run('publish-post.js', ['--post-id', '1', '--slug', '']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /변수 치환 실패/);

  const badSlug = run('publish-post.js', ['--post-id', '1', '--slug', '2026-5-4']);
  assert.equal(badSlug.status, 1);
  assert.match(badSlug.stderr, /zero-padding/);
});

test('analyze-photos: --output 없으면 exit 1', () => {
  const r = run('analyze-photos.js', ['a.jpg']);
  assert.equal(r.status, 1);
});

test('analyze-photos: 이미 채워진 파일은 재분석하지 않는다 (모델 간 핸드오프)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = path.join(dir, 'x.jpg');
  fs.writeFileSync(img, 'not really a jpg', 'utf8'); // 골격 생성에는 디코드가 필요 없다
  const out = path.join(dir, 'a.json');

  assert.equal(run('analyze-photos.js', [img, '--output', out]).status, 0);

  // 비전 모델이 채운 상태를 흉내낸다
  const filled = JSON.parse(fs.readFileSync(out, 'utf8'));
  filled.analyzed_by_model_capability = 'vision';
  filled.photos[0].scene_description = '골목 끝 간판';
  fs.writeFileSync(out, JSON.stringify(filled), 'utf8');

  const again = run('analyze-photos.js', [img, '--output', out]);
  assert.equal(again.status, 0);
  assert.match(again.stderr, /Skipping/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).photos[0].scene_description, '골목 끝 간판',
    '채워진 분석 결과가 덮어써짐');
});

test('analyze-photos: 손상된 파일은 백업 후 덮어쓴다 (조용한 소실 금지)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ap2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = path.join(dir, 'x.jpg');
  fs.writeFileSync(img, 'x', 'utf8');
  const out = path.join(dir, 'c.json');
  // 비전 분석 결과가 들어 있다가 부분 쓰기로 깨진 상황
  fs.writeFileSync(out, '{"analyzed_by_model_capability":"vision","photos":[{"scene_description":"소중한 결과"', 'utf8');

  const r = run('analyze-photos.js', [img, '--output', out]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /백업/);

  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1, '백업이 만들어지지 않음');
  assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /소중한 결과/);
  // 새 골격은 정상 생성
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).analyzed_by_model_capability, null);
});

// --- 네이버 (브라우저·계정 불필요한 경로만) ---

test('naver:draft — 실물 확인 게이트 전에는 exit 12', () => {
  const r = run('naver-create-draft.js', [
    '--html', path.join(FIXTURES, 'draft-toscano.html'), '--title', '테스트',
  ]);
  // 이미지 해석(16)이 먼저 걸리거나 셀렉터 게이트(12)에 걸린다. 둘 다 정상 차단.
  assert.ok([12, 16].includes(r.status), `status=${r.status}\n${r.stdout}${r.stderr}`);
  assert.equal(r.status === 12 ? /VERIFIED_AT/.test(r.stderr) : true, true);
});

test('naver:draft — 이미지가 없으면 exit 16 (URL 폴백 금지)', () => {
  const r = run('naver-create-draft.js', [
    '--html', path.join(FIXTURES, 'draft-toscano.html'),
    '--assets-root', path.join(os.tmpdir(), 'pba-no-such-assets'), '--dry-run',
  ]);
  assert.equal(r.status, 16, r.stdout + r.stderr);
  assert.match(r.stderr, /핫링킹/);
});

test('naver:draft — 공개 발행 안전장치 exit 18', () => {
  const args = [
    '--html', path.join(FIXTURES, 'draft-toscano.html'), '--title', '테스트',
    '--visibility', 'public',
  ];
  const noEnv = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'naver-create-draft.js'), ...args], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, NAVER_ALLOW_PUBLIC: '' },
  });
  // 이미지 해석이 먼저 걸릴 수 있으므로 18 또는 16 (둘 다 차단)
  assert.ok([16, 18].includes(noEnv.status), `status=${noEnv.status}`);
});

test('naver:draft — 인자 오류는 exit 1', () => {
  assert.equal(run('naver-create-draft.js', []).status, 1);
  assert.equal(run('naver-create-draft.js', ['--html', 'a.html', '--visibility', 'secret']).status, 1);
  assert.equal(run('naver-create-draft.js', ['--nope']).status, 1);
  // 위치 인자는 받지 않는다 (--html을 써야 한다)
  assert.equal(run('naver-create-draft.js', ['draft.html']).status, 1);
});

test('naver:publish — 무인자 "현재 에디터 발행"은 폐기됐다', () => {
  const r = run('naver-publish-post.js', []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--draft-title/);
});

test('naver:publish — 재개 발행은 아직 미구현 (exit 12)', () => {
  const r = run('naver-publish-post.js', ['--draft-title', '어떤 글']);
  assert.equal(r.status, 12, r.stdout + r.stderr);
});

test('naver:doctor — 실행되고 항목별 결과를 낸다', () => {
  const r = run('naver-doctor.js', ['--headless-smoke']);
  assert.match(r.stdout, /playwright 모듈/);
  assert.match(r.stdout, /셀렉터 실물 확인/);
  // 환경에 따라 무엇이 먼저 걸리는지가 달라진다. 12는 "앞이 전부 통과했고
  // 셀렉터 실물 확인만 남았다"는 뜻이므로 반드시 허용 목록에 있어야 한다 —
  // 실물 확인 게이트를 통과하기 전 개발자 환경의 정상 결과가 바로 이것이다.
  assert.ok([0, 1, 10, 11, 12, 17].includes(r.status), `status=${r.status}\n${r.stdout}${r.stderr}`);
  // 게이트 미통과 상태에서 exit 0이 나오면 doctor가 게이트 역할을 잃은 것이다.
  const { isVerified } = require('../lib/naver-selectors');
  if (!isVerified()) assert.notEqual(r.status, 0, 'VERIFIED_AT=null인데 doctor가 통과로 끝났다');
});
