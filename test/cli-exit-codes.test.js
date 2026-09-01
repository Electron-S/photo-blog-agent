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
