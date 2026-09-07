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
  // slug은 순수 검증이라 날짜 해석보다 먼저 온다 — 정상 slug를 주고 날짜만 없앤다.
  const r = run('upload-images.js', ['nonexistent.jpg', '--slug', 'ok-slug']);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /멱등성/);
});

test('upload-images: 값싼 순수 검증(slug)이 날짜 해석보다 먼저 온다', () => {
  // 둘 다 업로드 전이라 되돌릴 수 없는 작업은 없지만, 인자 하나가 잘못됐을 때
  // 그 인자를 가리켜야 한다. 예전에는 slug 오류가 exit 5(날짜 출처 미상)로 보고됐다.
  const r = run('upload-images.js', ['a.jpg', '--slug', 'My_Post']);
  assert.equal(r.status, 1, `status=${r.status}`);
  assert.match(r.stderr, /--slug/);
  assert.doesNotMatch(r.stderr, /멱등성/, 'slug 오류가 날짜 진단으로 보고됨');
});

test('upload-images: --date 형식 오류는 exit 1', () => {
  const withSlug = (extra) => run('upload-images.js', ['a.jpg', '--slug', 'ok-slug', ...extra]);
  assert.equal(withSlug(['--date', '2026-13-99']).status, 1);
  assert.equal(withSlug(['--date', '2026-2-3']).status, 1);
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

test('analyze-photos: 진행 중인 분석을 덮어쓰지 않는다 (핸드오프 보호)', (t) => {
  // 워크플로우는 photos[]를 먼저 채우고 **그 다음** capability를 세팅하라고
  // 지시한다. 그래서 가장 흔한 중단 상태가 "capability는 null인데
  // scene_description은 채워짐"이고, 예전 판정(capability가 문자열인가)은
  // 그걸 빈 골격으로 보고 백업도 경고도 없이 덮어썼다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ap3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = path.join(dir, 'x.jpg');
  fs.writeFileSync(img, 'x', 'utf8');
  const out = path.join(dir, 'pa.json');

  assert.equal(run('analyze-photos.js', [img, '--output', out]).status, 0);

  // 진행 중 상태를 만든다 (capability는 아직 null)
  const partial = JSON.parse(fs.readFileSync(out, 'utf8'));
  partial.photos[0].analysis_status = 'completed';
  partial.photos[0].scene_description = '석촌호수 벚꽃길, 해질녘';
  partial.photos[0].people_count = 12;
  partial.overall_impression = '봄 산책';
  fs.writeFileSync(out, JSON.stringify(partial), 'utf8');

  const again = run('analyze-photos.js', [img, '--output', out]);
  assert.equal(again.status, 0);
  assert.match(again.stderr, /in progress|Skipping/);
  const after = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(after.photos[0].scene_description, '석촌호수 벚꽃길, 해질녘',
    '진행 중인 비전 분석이 덮어써짐');
  assert.equal(after.photos[0].people_count, 12);
  assert.equal(after.overall_impression, '봄 산책');

  // 빈 골격은 그대로 덮어쓸 수 있어야 한다 (재실행이 막히면 안 된다)
  fs.writeFileSync(out, JSON.stringify({
    schema_version: 1,
    analyzed_at: null,
    analyzed_by_model_capability: null,
    photos: [{
      file: 'x.jpg', path: img, analysis_status: 'pending', scene_description: null,
      text_visible: null, people_count: null, dominant_colors: null, notable_objects: null,
    }],
    overall_impression: null,
  }), 'utf8');
  const fresh = run('analyze-photos.js', [img, '--output', out]);
  assert.equal(fresh.status, 0);
  assert.match(fresh.stderr, /skeleton saved/);
});

test('analyze-photos: 사진을 추가해 재실행하면 병합한다 (새 사진이 빠지지 않는다)', (t) => {
  // skip만 하면 사진을 추가해 재실행하는 정상 시나리오에서 **새 사진이 조용히
  // 분석 대상에서 빠진다**. 덮어쓰면 채워진 분석이 사라진다. 둘 다 조용한
  // 손실이므로 병합이 답이다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ap4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = (n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'x', 'utf8');
    return p;
  };
  const [a, b, c] = [img('a.jpg'), img('b.jpg'), img('c.jpg')];
  const out = path.join(dir, 'pa.json');
  const read = () => JSON.parse(fs.readFileSync(out, 'utf8'));
  const files = () => read().photos.map((ph) => ph.file);

  assert.equal(run('analyze-photos.js', [a, '--output', out]).status, 0);

  // 비전 모델이 a를 채운다 (capability는 아직 null — 가장 흔한 중단 지점)
  const filled = read();
  filled.photos[0].analysis_status = 'completed';
  filled.photos[0].scene_description = '첫 사진';
  fs.writeFileSync(out, JSON.stringify(filled), 'utf8');

  // 사진 추가 → 기존 보존 + 새 항목 추가
  const grow = run('analyze-photos.js', [a, b, '--output', out]);
  assert.equal(grow.status, 0);
  assert.deepEqual(files(), ['a.jpg', 'b.jpg'], '새 사진이 빠짐');
  assert.equal(read().photos[0].scene_description, '첫 사진', '기존 분석이 덮어써짐');
  assert.equal(read().photos[1].scene_description, null);

  // 같은 목록으로 재실행 → 아무것도 바꾸지 않는다
  const same = run('analyze-photos.js', [a, b, '--output', out]);
  assert.equal(same.status, 0);
  assert.match(same.stderr, /Skipping/);
  assert.deepEqual(files(), ['a.jpg', 'b.jpg']);

  // capability가 찍힌 뒤에도 사진 추가는 병합된다
  const done = read();
  done.analyzed_by_model_capability = 'vision';
  done.overall_impression = '봄 산책';
  done.photos[1].scene_description = '둘째 사진';
  fs.writeFileSync(out, JSON.stringify(done), 'utf8');

  assert.equal(run('analyze-photos.js', [a, b, c, '--output', out]).status, 0);
  assert.deepEqual(files(), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.equal(read().analyzed_by_model_capability, 'vision', 'capability가 초기화됨');
  assert.equal(read().overall_impression, '봄 산책');
  assert.equal(read().photos[1].scene_description, '둘째 사진');

  // 사진을 빼고 재실행해도 기존 항목을 지우지 않는다 (조용한 손실 금지)
  assert.equal(run('analyze-photos.js', [a, '--output', out]).status, 0);
  assert.deepEqual(files(), ['a.jpg', 'b.jpg', 'c.jpg']);

  // **새 사진 추가 + 기존 사진 일부 제외**를 동시에 — 병합이 실제로 도는 경로다.
  // (위 케이스는 추가할 것이 없어 skip으로 빠지므로 보존 로직을 타지 않는다.)
  const d = img('d.jpg');
  const mix = run('analyze-photos.js', [b, c, d, '--output', out]);
  assert.equal(mix.status, 0);
  assert.deepEqual(files().sort(), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
    '이번 호출에 없던 a.jpg의 분석이 사라짐');
  assert.equal(read().photos.find((ph) => ph.file === 'a.jpg').scene_description, '첫 사진');
  assert.match(mix.stderr, /그대로 남겼습니다/);
});
