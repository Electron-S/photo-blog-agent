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
  // 세션이 없는 것이 정상 상태이므로 0이 아닐 수 있다
  assert.ok([0, 1, 10, 11, 17].includes(r.status), `status=${r.status}`);
});
