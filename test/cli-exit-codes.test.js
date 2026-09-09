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
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'drafts');

// 자식이 끝나지 않으면 `spawnSync`는 **영원히 기다린다.** CI에서 그것을 실제로
// 봤다 — Windows leg의 `npm test`가 20분 넘게 멈춰 있었고(같은 커밋의 ubuntu는 1분
// 48초에 통과), 어느 테스트에서 멈췄는지 알 방법이 없었다. GitHub의 기본 job
// 타임아웃은 6시간이다.
//
// 타임아웃을 두면 멈춤이 **이름 있는 실패**가 된다. 이 프로젝트가 다른 곳에서
// silent failure를 없앤 것과 같은 이유다 — 멈춘 CI는 결과가 없는 것이 아니라
// 잘못된 결과다(초록도 빨강도 아닌 상태로 남는다).
const SPAWN_TIMEOUT_MS = 60000;

function runWith(script, args, extraEnv) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: SPAWN_TIMEOUT_MS,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  // 타임아웃이면 status는 null이고 signal이 채워진다. 이 상태를 그대로 반환하면
  // `r.status === 1`류 단언이 "0이 아니니 실패했다"로 통과해 버린다.
  if (r.signal || (r.error && r.error.code === 'ETIMEDOUT')) {
    throw new Error(
      `${script} ${args.join(' ')} 가 ${SPAWN_TIMEOUT_MS}ms 안에 끝나지 않았습니다 `
      + `(signal=${r.signal}). 끝나지 않는 자식은 CI를 멈춘 상태로 남긴다.`,
    );
  }
  return r;
}

function run(script, args) {
  return runWith(script, args, null);
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
    encoding: 'utf8', cwd: ROOT,
      timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, NAVER_ALLOW_PUBLIC: '' },
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

test('session-state read --field: 손상은 exit 9, 프로토타입 필드는 exit 1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ss2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (slug, obj) => fs.writeFileSync(
    path.join(dir, `session-state-${slug}.json`), JSON.stringify(obj), 'utf8',
  );
  write('broken', { schema_version: 1, slug: 'broken', steps_completed: 'exif,upload', post_id: '9' });
  write('ok', {
    schema_version: 1,
    slug: 'ok',
    steps_completed: ['exif'],
    steps_remaining: ['photo_analysis', 'upload', 'research', 'draft', 'publish'],
  });
  const run2 = (args) => run('session-state.js', [...args, '--dir', dir]);

  // 손상 상태에서 값을 내보내면 새 세션과 구별할 수 없다
  const broken = run2(['read', '--slug', 'broken', '--field', 'steps_completed']);
  assert.equal(broken.status, 9, `status=${broken.status} stdout=${broken.stdout}`);
  assert.equal(broken.stdout.trim(), '', '손상인데 값을 출력함');

  // 정상 상태는 셸에서 쓰기 좋은 평문
  const okRun = run2(['read', '--slug', 'ok', '--field', 'steps_remaining']);
  assert.equal(okRun.status, 0);
  assert.equal(okRun.stdout.trim(), 'photo_analysis,upload,research,draft,publish');

  // --format json을 명시하면 배열을 뭉개지 않는다
  const asJson = run2(['read', '--slug', 'ok', '--field', 'steps_remaining', '--format', 'json']);
  assert.equal(asJson.status, 0);
  assert.deepEqual(JSON.parse(asJson.stdout), ['photo_analysis', 'upload', 'research', 'draft', 'publish']);

  // 프로토타입 체인을 타지 않는다
  assert.equal(run2(['read', '--slug', 'ok', '--field', 'toString']).status, 1);
  assert.equal(run2(['read', '--slug', 'ok', '--field', 'constructor']).status, 1);

  // --field가 --format 검증을 건너뛰지 않는다
  assert.equal(run2(['read', '--slug', 'ok', '--field', 'slug', '--format', 'bogus']).status, 1);
});

test('session-state list: 마커는 stdout에 고정, 경로 주석은 stderr', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ss3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // .claude/commands/blog.md의 진입 프로브가 이 마커로 분기한다. 갓 클론한
  // 저장소에는 tmp/가 없으므로(gitignore), 그 경우에도 마커가 나와야 한다 —
  // 아니면 존재하지 않는 세션에 대해 "이어서 진행할까요?"를 묻게 된다.
  const empty = run('session-state.js', ['list', '--dir', dir]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /\(진행 중 세션 없음\)/);

  const missing = run('session-state.js', ['list', '--dir', path.join(dir, 'nope')]);
  assert.equal(missing.status, 0, `status=${missing.status}`);
  assert.match(missing.stdout, /\(진행 중 세션 없음\)/, '마커가 stdout에 없음');
  // 어디를 봤는지는 남긴다 — 경로 오타를 조용히 "세션 없음"으로 읽지 않도록
  assert.match(missing.stderr, /상태 디렉터리가 아직 없습니다/);
});

test('session-state read --slug: 손상 상태는 exit 9 + degraded 표시', (t) => {
  // --field만 막는 것으로는 부족했다. blog.md의 재개 경로는 `read --slug`이고
  // --field는 저장소에 호출자가 없다. 경고가 stderr이라 steps_remaining[0]으로
  // 점프하는 재개 규칙이 이미 발행된 글을 처음부터 다시 만들 수 있었다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ss4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'session-state-hole.json'), JSON.stringify({
    schema_version: 1,
    slug: 'hole',
    steps_completed: ['draft', 'publish'],
    steps_remaining: [],
    post_id: '123',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'session-state-ok.json'), JSON.stringify({
    schema_version: 1,
    slug: 'ok',
    steps_completed: ['exif'],
    steps_remaining: ['photo_analysis', 'upload', 'research', 'draft', 'publish'],
  }), 'utf8');

  const hole = run('session-state.js', ['read', '--slug', 'hole', '--dir', dir]);
  assert.equal(hole.status, 9, `status=${hole.status}`);
  // 상태는 그대로 출력한다 — 사람이 무엇이 깨졌는지 봐야 한다
  assert.equal(JSON.parse(hole.stdout).degraded, true);
  assert.match(hole.stderr, /재개하면/);

  const ok = run('session-state.js', ['read', '--slug', 'ok', '--dir', dir]);
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).degraded, undefined, '정상 상태에 degraded가 붙음');
});

test('naver:draft — --dry-run이 공개 발행 게이트를 우회하지 않는다', () => {
  // dry-run은 "유일하게 동작하는 검증 경로"인데, 실제 실행이면 exit 18로 막힐
  // 조합에 초록불을 주면 검증의 의미가 없다.
  const args = ['--html', path.join(FIXTURES, 'draft-toscano.html'), '--dry-run', '--visibility', 'public'];
  const blocked = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'naver-create-draft.js'), ...args], {
    encoding: 'utf8', cwd: ROOT,
      timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, NAVER_ALLOW_PUBLIC: '' },
  });
  assert.equal(blocked.status, 18, `status=${blocked.status}\n${blocked.stdout}${blocked.stderr}`);
  assert.match(blocked.stderr, /NAVER_ALLOW_PUBLIC/);
});

test('naver:publish — 알 수 없는 플래그를 조용히 무시하지 않는다', () => {
  // 발행 스크립트에서 오타가 무시되면 의도와 다른 글이 공개될 수 있다.
  const r = run('naver-publish-post.js', ['--bogus', 'zzz', '--draft-title', 't']);
  assert.equal(r.status, 1, `status=${r.status}`);
  assert.match(r.stderr, /unknown option --bogus/);
  // 정상 인자는 그대로 동작 (미구현이므로 exit 12)
  assert.equal(run('naver-publish-post.js', ['--draft-title', 't']).status, 12);
  // 값에 하이픈이 들어가도 플래그로 오인하지 않는다
  assert.equal(run('naver-publish-post.js', ['--draft-title', '제목 --아님']).status, 12);
});

test('update-post: --labels가 조용히 라벨을 전량 삭제하지 않는다', () => {
  // `if (labelsArg)`는 "플래그가 왔는가"만 보는데 `filter(Boolean)`이 빈 배열을
  // 낼 수 있고, 그것이 PATCH에 실리면 **라벨이 전량 삭제**된다 (실측: exit 0,
  // 경고 0건). `--labels ""`(보존)과 `--labels " "`(삭제)가 정반대 의미였다.
  // 워크플로우가 `--labels "$LABELS"`로 호출하고 join 결과가 비면 SEO 라벨
  // 5~10개가 아무 표시 없이 사라진다.
  for (const bad of [',', ' ', ',,', ' , ']) {
    const r = run('update-post.js', ['--post-id', '1', '--labels', bad]);
    assert.equal(r.status, 1, `--labels ${JSON.stringify(bad)} status=${r.status}`);
    assert.match(r.stderr, /유효한 라벨이 없습니다/);
    assert.match(r.stderr, /생략하세요/, '보존 방법을 안내하지 않음');
  }
  // 플래그 자체를 생략하면 "수정할 것이 없다"로 끝난다 (라벨은 보존된다)
  const none = run('update-post.js', ['--post-id', '1']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /at least one of/);
});

test('session-state: primary_date를 무검증으로 저장하지 않는다', (t) => {
  // 스키마가 `^\d{4}-\d{2}-\d{2}$`를 선언하는데 무검증 대입이었다 —
  // `--primary-date "2026/05/10"`이 exit 0으로 디스크에 남았고, 재개하는 다른
  // 세션·모델이 그 값을 **방문 날짜**로 읽는다. slug은 SLUG_RE로 강제되는데
  // 패턴 제약이 있는 필드 중 이것만 빠져 있었다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-pd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const bad of ['2026/05/10', 'not-a-date', '2026-5-10', '2026-02-30', '20260510']) {
    const r = run('session-state.js', ['init', '--slug', 'pd', '--dir', dir, '--primary-date', bad]);
    assert.equal(r.status, 9, `--primary-date ${bad} status=${r.status}`);
    assert.equal(fs.existsSync(path.join(dir, 'session-state-pd.json')), false,
      `${bad}: 잘못된 값이 디스크에 남음`);
  }
  // 정상 값은 통과한다
  assert.equal(run('session-state.js',
    ['init', '--slug', 'pd', '--dir', dir, '--primary-date', '2026-05-10']).status, 0);
});

// --- 20차 리뷰 회귀 ---

test('create-draft: --labels가 조용히 라벨 0개로 초안을 만들지 않는다', () => {
  // update-post.js에서 exit 1로 막은 것과 **완전히 같은 패턴**이 주 진입점에 남아
  // 있었다 (실측: `--labels ","` -> 라벨 0개로 초안 생성, exit 0, 경고 0건).
  //
  // 그리고 **SEO 라벨이 실제로 정해지는 곳이 create-draft다** —
  // prompts/workflow-steps.md의 Step 6은 `--labels`를 생략해 기존 라벨을 보존하므로,
  // 라벨 5~10개(같은 파일 161행)를 넘기는 유일한 지점이 여기다.
  for (const bad of [',', ' ', ',,', ' , ']) {
    const r = run('create-draft.js', ['--title', 't', '--content', '<p>x</p>', '--labels', bad]);
    assert.equal(r.status, 1, `--labels ${JSON.stringify(bad)} status=${r.status}`);
    assert.match(r.stderr, /유효한 라벨이 없습니다/);
    assert.match(r.stderr, /생략하세요/);
  }
});

test('create-draft: --labels 생략은 차단하지 않되 표면화한다', () => {
  // 차단하면 빠른 초안 확인용 호출이 막힌다. 다만 워크플로우가 요구하는 라벨이
  // 비었다는 사실은 알려야 한다 — lint가 먼저 죽는 초안이어도 이 경고는 그 전에 나온다.
  const r = run('create-draft.js', ['--title', 't', '--content', '<p>x</p>']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--labels 미지정/);
  assert.match(r.stderr, /5~10개/, '워크플로우 요구 수치를 안내하지 않음');
});

test('get-blogger-token: 포트가 올바르지 않으면 raw 스택 없이 안내한다', () => {
  // 예전에는 `Number('abc')`가 NaN이 되어도 REDIRECT_URI를 만들어 authUrl에 실었고,
  // 실패는 한참 뒤 server.listen의 ERR_SOCKET_BAD_PORT raw 스택으로 나왔다.
  for (const bad of ['abc', '0', '70000', '-1', '3000.5']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'get-blogger-token.js')], {
      encoding: 'utf8',
      cwd: ROOT,
    timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        BLOGGER_OAUTH_PORT: bad,
        BLOGGER_CLIENT_ID: 'x',
        BLOGGER_CLIENT_SECRET: 'y',
      },
    });
    assert.equal(r.status, 1, `PORT=${bad} status=${r.status}`);
    assert.match(r.stderr, /BLOGGER_OAUTH_PORT/, `PORT=${bad}: 환경변수를 안내하지 않음`);
    assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|at Server\.listen/,
      `PORT=${bad}: raw 스택이 노출됨`);
  }
});

test('get-blogger-token: 포트가 점유돼 있으면 대안을 안내한다', async (t) => {
  // 3000은 개발 기본 포트라 EADDRINUSE는 첫 실행 실패로 매우 흔한데, 예전에는
  // Unhandled 'error' event 스택만 나오고 BLOGGER_OAUTH_PORT의 존재조차 알려주지 않았다.
  const http = require('node:http');
  const srv = http.createServer(() => {});
  // **스크립트와 같은 주소에 bind해야 한다.** `get-blogger-token.js`는 호스트 없이
  // `server.listen(PORT)`를 부르므로 0.0.0.0/:: 에 bind한다. 여기서 127.0.0.1에만
  // bind하면 Linux는 충돌하지만 **Windows는 다른 주소로 보아 두 번째 bind가
  // 성공한다** — 그러면 스크립트가 EADDRINUSE로 죽지 않고 OAuth 콜백을 영원히
  // 기다리고, spawnSync가 그걸 그대로 기다려 CI가 멈춘다 (첫 CI 실행에서 Windows
  // leg가 20분 넘게 멈춰 있었다. 같은 커밋의 ubuntu는 1분 48초에 통과했다).
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  t.after(() => srv.close());

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'get-blogger-token.js')], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...process.env,
      BLOGGER_OAUTH_PORT: String(port),
      BLOGGER_CLIENT_ID: 'x',
      BLOGGER_CLIENT_SECRET: 'y',
    },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /이미 사용 중/);
  assert.match(r.stderr, /BLOGGER_OAUTH_PORT=/, '대안 포트 지정 방법을 안내하지 않음');
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event/, 'raw 스택이 노출됨');
});

test('create-draft/update-post: 깨진 이미지의 실패 이유를 버리지 않는다', async (t) => {
  // 예전에는 `for (const { url, status } of imageCheck.broken)`가 reason을
  // 구조분해에서 빼먹어, 오프라인·DNS 실패·TLS 오류·타임아웃·연결 거부가 전부
  // `  0: https://...` 한 줄로 붕괴했다. 사용자는 "GitHub Pages 전파 지연"인지
  // "내 인터넷이 끊겼는지"를 구별할 수 없는데 exit 1이라 발행은 막힌 상태다.
  //
  // 404를 쓰는 이유: 재시도 대상이 아니라 대기 없이 같은 출력 경로를 지난다.
  const http = require('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  t.after(() => srv.close());

  const src = fs.readFileSync(path.join(FIXTURES, 'draft-toscano.html'), 'utf8');
  const dead = src.replace(/https:\/\/[^"]*?\/(photo-\d+\.webp)/g, `http://127.0.0.1:${port}/$1`);
  assert.match(dead, /127\.0\.0\.1/, '전제: fixture의 이미지 URL을 치환했다');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-brk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dead.html');
  fs.writeFileSync(file, dead, 'utf8');

  // **spawnSync를 쓸 수 없다.** 검증 서버가 이 테스트 프로세스 안에 있는데
  // spawnSync는 이벤트 루프를 막아 서버가 응답하지 못한다 — 실제로 404 대신
  // "timeout of 10000ms exceeded"가 나왔다 (테스트를 실행해 확인). 비동기로 띄운다.
  const runAsync = (script, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  for (const [script, args] of [
    ['create-draft.js', ['--title', 't', '--content', file, '--labels', 'a,b']],
    ['update-post.js', ['--post-id', '1', '--content', file]],
  ]) {
    const r = await runAsync(script, args);
    assert.equal(r.status, 1, `${script} status=${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Broken image URLs found/, script);
    // 이유가 실제로 찍혀야 한다 — status 하나로 붕괴하면 안 된다
    assert.match(r.stderr, /status code 404/, `${script}: 실패 이유가 출력되지 않음`);
    // Blogger API에 도달하기 전에 죽는다 (자격증명 없이도 이 테스트가 성립하는 근거)
    assert.doesNotMatch(r.stderr, /refresh token|invalid_grant/i, `${script}: API를 호출함`);
  }
});

test('upload-images: --metadata의 primary_date를 무검증으로 쓰지 않는다', (t) => {
  // `--date`는 형식·달력을 검사하는데 이 경로는 아무 검사도 없었다 — 실측:
  // `primary_date: "2026-02-30"`이 "날짜=2026-02-30 (EXIF primary_date)"를 찍고
  // 그대로 진행했다. 그 값은 폴더 경로 `posts/2026-02-30-<hash>/`가 되어
  // **공개 저장소에 push**되고, 그 뒤에 오는 loadSlugFromMetadata와 session-state는
  // 같은 값을 거부한다 — 되돌릴 수 없는 단계가 통과하고 되돌릴 수 있는 단계가 죽는다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-md-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (primaryDate) => {
    const f = path.join(dir, 'meta.json');
    fs.writeFileSync(f, JSON.stringify({ primary_date: primaryDate, photos: [] }), 'utf8');
    return f;
  };

  // 존재하지 않는 날짜 · 형식 위반은 업로드 전에 exit 1로 막는다
  for (const bad of ['2026-02-30', '2026-04-31', '2026-02-29', '2026-13-01']) {
    const r = run('upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--metadata', write(bad)]);
    assert.equal(r.status, 1, `primary_date=${bad} status=${r.status}`);
    assert.match(r.stderr, /(존재하지 않는 날짜|형식이 아닙니다)/, `${bad}: 이유를 말하지 않음`);
    // 날짜를 채택했다는 로그가 나오면 검증을 통과한 것이다
    assert.doesNotMatch(r.stderr, new RegExp(`날짜=${bad}`), `${bad}: 검증 없이 채택됨`);
  }
  for (const bad of ['2026/05/10', '20260510', 'not-a-date', '2026-5-10']) {
    const r = run('upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--metadata', write(bad)]);
    assert.equal(r.status, 1, `primary_date=${JSON.stringify(bad)} status=${r.status}`);
    assert.match(r.stderr, /형식이 아닙니다/);
  }

  // 정상 날짜는 통과한다 (파일이 없어서 그 다음 단계에서 멈춘다)
  const ok = run('upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--metadata', write('2024-02-29')]);
  assert.match(ok.stderr, /날짜=2024-02-29/, '윤년 날짜를 막음');

  // 달력에는 있으나 타당 범위 밖이면 차단하지 않고 경고한다 (--date와 같은 취급)
  const old = run('upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--metadata', write('1899-11-30')]);
  assert.match(old.stderr, /Warning/);
  assert.match(old.stderr, /날짜=1899-11-30/, '타당 범위 밖 날짜를 차단함 (경고여야 한다)');
});

// --- 23차 리뷰 회귀 ---

test('CLI는 비정상 입력에 raw 스택을 노출하지 않는다', (t) => {
  // 스택트레이스로 죽는 것은 이 프로젝트의 명시적 안티패턴이다 — 사용자는 무엇을
  // 해야 할지 알 수 없고, 자동화는 exit 1을 "일반 실패"로 뭉뚱그린다.
  //
  // publish-post의 --slug-from-date가 그랬다. 주석은 "깨진 파일 라인을 디버그할 수
  // 있게" 스택을 남긴다고 했지만, 실제로 찍히는 것은 `JSON.parse (<anonymous>)` →
  // `lib/slug.js` → `publish-post.js`로 **우리 소스**였다. 깨진 파일의 위치는 이미
  // 메시지에 있고("at position 2"), 스택은 조치할 줄을 6줄 아래로 밀어냈다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-stk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{ this is not json', 'utf8');
  const emptyHtml = path.join(dir, 'empty.html');
  fs.writeFileSync(emptyHtml, '', 'utf8');
  const binHtml = path.join(dir, 'bin.html');
  fs.writeFileSync(binHtml, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));

  // 스택이 새어 나왔다는 신호
  const STACK = [/^\s{4}at /m, /throw er;/, /Unhandled 'error' event/, /node:internal\//];

  const CASES = [
    ['lint-draft.js', []],
    ['lint-draft.js', ['/nonexistent.html']],
    ['lint-draft.js', [emptyHtml]],
    ['lint-draft.js', [binHtml]],
    ['lint-draft.js', [path.join(FIXTURES, 'draft-toscano.html'), '--upload-result', badJson]],
    ['lint-draft.js', [path.join(FIXTURES, 'draft-toscano.html'), '--format', 'yaml']],
    ['extract-exif.js', []],
    ['extract-exif.js', ['/nonexistent.jpg']],
    ['extract-exif.js', ['--output']],
    ['analyze-photos.js', []],
    ['upload-images.js', []],
    ['upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--metadata', badJson]],
    ['upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--date', 'abc']],
    ['upload-images.js', ['/nonexistent.jpg', '--slug', 'x', '--date', '2026-05-10', '--max-size-kb', 'abc']],
    ['session-state.js', []],
    ['session-state.js', ['bogus']],
    ['session-state.js', ['read', '--slug', 'nope', '--dir', dir]],
    ['session-state.js', ['read', '--slug', '../etc', '--dir', dir]],
    ['naver-create-draft.js', []],
    ['naver-create-draft.js', ['--html', '/nonexistent.html', '--title', 'T', '--dry-run']],
    ['naver-create-draft.js', ['--html', binHtml, '--title', 'T', '--dry-run']],
    ['publish-post.js', []],
    ['publish-post.js', ['--post-id', '1']],
    ['publish-post.js', ['--post-id', '1', '--slug', 'A_B']],
    ['publish-post.js', ['--post-id', '1', '--slug-from-date', badJson]],
    ['publish-post.js', ['--post-id', '1', '--slug-from-date', '/nonexistent.json']],
    ['delete-post.js', []],
    ['create-draft.js', []],
    ['create-draft.js', ['--title', 'T', '--content', '/nonexistent.html', '--labels', 'a']],
    ['update-post.js', []],
  ];

  const leaked = [];
  for (const [script, args] of CASES) {
    const r = run(script, args);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const hit = STACK.find((re) => re.test(out));
    if (hit) leaked.push(`${script} ${args.join(' ')} → ${hit}`);
  }
  assert.deepEqual(leaked, [], `스택이 노출된 호출:\n  ${leaked.join('\n  ')}`);
});

test('publish-post: --slug-from-date 실패는 원인별 조치를 안내한다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-sfd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{ this is not json', 'utf8');

  const missing = run('publish-post.js', ['--post-id', '1', '--slug-from-date', '/nonexistent.json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /파일이 없습니다/);
  assert.match(missing.stderr, /extract-exif/, '어떻게 만드는지 안내하지 않음');

  const broken = run('publish-post.js', ['--post-id', '1', '--slug-from-date', badJson]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /extract-exif\.js의 출력 형식/);
  assert.doesNotMatch(broken.stderr, /파일이 없습니다/, 'ENOENT가 아닌데 파일 없음으로 안내');

  // 두 경우 모두 대안을 제시한다
  for (const r of [missing, broken]) {
    assert.match(r.stderr, /--slug YYYY-MM-DD/, '대안(--slug 직접 지정)을 안내하지 않음');
  }
});

test('선언된 CLI 플래그는 전부 파서가 받는다', () => {
  // `--allow-replace`가 코드·README·**런타임 오류 메시지**에 있는데 파서의
  // BOOLEAN_FLAGS에는 없어서 `unknown option`으로 exit 1이 났다. 즉 오류 메시지가
  // 안내하는 조치를 그대로 따르면 다시 실패하는 막다른 길이었다.
  // (306건이 통과한 이유: 테스트가 uploadAsset을 **lib 레벨로만** 불러서 CLI
  //  경로가 검증되지 않았다.)
  //
  // 케이스가 아니라 클래스를 고정한다 — usage에 적힌 모든 `--flag`를 실제로 넘겨 본다.
  // **Options 절의 줄머리 플래그만** 센다. usage 전체에서 긁으면 설명 산문에 나오는
  // 다른 스크립트의 플래그(`lint-draft --upload-result`)까지 잡혀 오탐이 난다.
  const usage = run('upload-images.js', []);
  const declared = [...new Set(
    (usage.stdout.match(/^ {2}(--[a-z][a-z-]+)/gm) || []).map((l) => l.trim()),
  )].filter((f) => f !== '--slug');           // --slug는 아래에서 항상 함께 넘긴다
  assert.ok(declared.length >= 6, `usage에서 플래그를 찾지 못함: ${declared.join(',')}`);

  // 값을 받는 플래그와 불리언 플래그를 구분해 각각 유효한 값을 준다
  const VALUES = {
    '--metadata': null,          // 아래에서 임시 파일로 채움
    '--date': '2026-05-10',
    '--work-dir': null,
    '--max-size-kb': '150',
    '--output': null,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-flg-'));
  const meta = path.join(dir, 'm.json');
  fs.writeFileSync(meta, JSON.stringify({ primary_date: '2026-05-10', photos: [] }), 'utf8');
  VALUES['--metadata'] = meta;
  VALUES['--work-dir'] = path.join(dir, 'w');
  VALUES['--output'] = path.join(dir, 'o.json');

  const rejected = [];
  for (const flag of declared) {
    const args = ['/nonexistent.jpg', '--slug', 'abc-def'];
    if (flag in VALUES) args.push(flag, VALUES[flag]);
    else args.push(flag);
    if (!args.includes('--date') && !args.includes('--metadata')) args.push('--date', '2026-05-10');
    const r = run('upload-images.js', args);
    if (/unknown option/.test(r.stderr)) rejected.push(`${flag}: ${r.stderr.split('\n')[0]}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(rejected, [],
    `usage가 선언한 플래그를 파서가 거부함:\n  ${rejected.join('\n  ')}`);
});

test('upload-images: --allow-replace가 CLI에서 실제로 통한다', (t) => {
  // 위 테스트가 클래스를 잡지만, 이 플래그는 **되돌릴 수 없는 동작**(이미 발행된
  // 글의 이미지 교체)의 유일한 관문이므로 개별로도 고정한다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const r = run('upload-images.js',
    ['/nonexistent.jpg', '--slug', 'abc-def', '--date', '2026-05-10', '--allow-replace']);
  assert.doesNotMatch(r.stderr, /unknown option/, '--allow-replace를 파서가 거부함');
  // 파일이 없어서 그 다음 단계에서 멈춘다 = 플래그 파싱은 통과했다
  assert.match(r.stderr, /file not found/);

  // usage와 CLAUDE.md가 이 플래그를 안내해야 한다 (모델은 usage로 인자를 확인한다)
  const usage = run('upload-images.js', []);
  // synopsis에도 나오므로 전체 매칭으로는 Options 항목 삭제를 못 잡는다 (뮤테이션이
  // 잡아냄). 모델이 인자를 확인하는 곳은 **Options 절**이므로 거기를 직접 본다.
  assert.match(usage.stdout, /^ {2}--allow-replace\s+\S/m, 'usage의 Options 절에 없음');
  assert.match(usage.stdout, /\[--allow-replace\]/, 'usage synopsis에 없음');
  const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /--allow-replace/, 'CLAUDE.md에 없음');
});

test('모든 스크립트: usage가 선언한 플래그를 파서가 받는다', (t) => {
  // `--allow-replace`가 코드·README·**런타임 오류 메시지**에 있는데 파서에는 없어서
  // "unknown option"으로 죽었다 — 오류 메시지가 안내하는 조치를 따르면 다시 실패하는
  // 막다른 길이었다. 그때는 upload-images 하나만 개별로 고정했는데, 같은 종류가
  // 다른 스크립트에도 있는지 손으로 훑어야 했다. 그 훑기를 여기에 고정한다.
  //
  // usage에서 플래그를 뽑는 방식이 두 가지인 이유:
  //   (a) Options 절의 줄머리(`  --flag  설명`)
  //   (b) synopsis의 대괄호(`[--flag]`) — naver 스크립트들이 이 형태다
  // 설명 산문에 나오는 **다른 스크립트의** 플래그(`lint-draft --upload-result`)는
  // 둘 다에 안 걸리므로 오탐이 나지 않는다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = path.join(dir, 'm.json');
  fs.writeFileSync(meta, JSON.stringify({ primary_date: '2026-05-10', photos: [] }), 'utf8');
  const upres = path.join(dir, 'u.json');
  fs.writeFileSync(upres, JSON.stringify({ images: [] }), 'utf8');
  const html = path.join(FIXTURES, 'draft-toscano.html');

  // 그 플래그만 빼면 인자 검증을 통과하는 최소 인자. 목적은 실행 성공이 아니라
  // "unknown option"이 나오는지 하나뿐이다.
  const BASE = {
    'extract-exif.js': ['x.jpg'],
    'analyze-photos.js': ['x.jpg'],
    'upload-images.js': ['/nonexistent.jpg', '--slug', 'abc-def', '--date', '2026-05-10'],
    'lint-draft.js': [html],
    'create-draft.js': ['--title', 'T', '--content', '<p>x</p>'],
    'update-post.js': ['--post-id', '1', '--title', 'T'],
    'publish-post.js': ['--post-id', '1', '--slug', '2026-05-10'],
    'delete-post.js': ['--post-id', '1'],
    'naver-create-draft.js': ['--html', html, '--title', 'T', '--dry-run'],
    'naver-publish-post.js': ['--draft-title', 'T'],
    'naver-doctor.js': [],
    'naver-inspect.js': [],
  };
  const VALUES = {
    '--metadata': meta, '--date': '2026-05-10', '--slug': 'abc-def',
    '--work-dir': path.join(dir, 'w'), '--max-size-kb': '150',
    '--output': path.join(dir, 'o.json'), '--upload-result': upres,
    '--format': 'json', '--title': 'T', '--content': '<p>x</p>', '--post-id': '1',
    '--labels': 'a,b', '--slug-from-date': meta, '--html': html,
    '--category': 'C', '--tags': 'a,b', '--visibility': 'private',
    '--draft-title': 'T', '--image-dir': dir, '--dir': dir,
  };
  const REJECT = /unknown option|알 수 없는 (옵션|플래그)|인자를 받지 않습니다/;

  const problems = [];
  for (const [script, base] of Object.entries(BASE)) {
    // usage를 끌어내는 방법이 스크립트마다 다르다 — 인자 없이 내는 쪽과
    // 미지 플래그에만 내는 쪽이 섞여 있어 둘 다 시도한다.
    const extract = (text) => [...new Set([
      ...(text.match(/^\s{2,}--[a-z][a-z0-9-]+/gm) || []).map((l) => l.trim()),
      ...(text.match(/\[--[a-z][a-z0-9-]+/g) || []).map((l) => l.slice(1)),
    ])];
    let declared = [];
    for (const probe of [[], ['--zzz-bogus-flag']]) {
      const u = run(script, probe);
      declared = extract(`${u.stdout || ''}${u.stderr || ''}`);
      if (declared.length) break;
    }
    assert.ok(declared.length > 0, `${script}: usage에서 플래그를 찾지 못함`);

    for (const flag of declared) {
      if (base.includes(flag)) continue;
      const args = [...base, ...(flag in VALUES ? [flag, VALUES[flag]] : [flag])];
      const r = run(script, args);
      if (REJECT.test(`${r.stdout || ''}${r.stderr || ''}`)) {
        problems.push(`${script} ${flag}`);
      }
    }
  }
  assert.deepEqual(problems, [],
    `usage가 선언한 플래그를 파서가 거부함:\n  ${problems.join('\n  ')}`);
});

test('session-state: 서브커맨드별 선언 플래그를 전부 받는다', (t) => {
  // session-state는 플래그를 Options 절이 아니라 서브커맨드 synopsis에 인라인으로
  // 쓴다(`init --slug S [--primary-date D] ...`). 위 테스트의 추출 방식으로는
  // 안 잡히므로 따로 고정한다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = path.join(dir, 'm.json');
  fs.writeFileSync(meta, JSON.stringify({ primary_date: '2026-05-10' }), 'utf8');
  const html = path.join(FIXTURES, 'draft-toscano.html');

  const usage = (() => { const r = run('session-state.js', []); return `${r.stdout}${r.stderr}`; })();
  const VALUES = {
    '--slug': 'flag-probe', '--dir': dir, '--primary-date': '2026-05-10',
    '--metadata-path': meta, '--analysis-path': meta, '--upload-result-path': meta,
    '--draft-path': html, '--post-id': '1', '--post-url': 'https://x/y.html',
    '--complete': 'exif', '--field': 'slug', '--format': 'json',
  };
  const REJECT = /unknown option|알 수 없는 (옵션|플래그)/;

  // 서브커맨드 블록별로 플래그를 뽑는다
  const blocks = usage.split(/^ {2}(init|update|read|list)\s/m);
  const subs = {};
  for (let i = 1; i < blocks.length; i += 2) subs[blocks[i]] = blocks[i + 1].split('\n\n')[0];
  assert.ok(Object.keys(subs).length === 4, `서브커맨드 블록을 찾지 못함: ${Object.keys(subs)}`);

  run('session-state.js', ['init', '--slug', 'flag-probe', '--dir', dir]);
  const problems = [];
  for (const [sub, text] of Object.entries(subs)) {
    const base = sub === 'list' ? ['list', '--dir', dir] : [sub, '--slug', 'flag-probe', '--dir', dir];
    for (const flag of [...new Set(text.match(/--[a-z][a-z0-9-]+/g) || [])]) {
      if (base.includes(flag)) continue;
      const args = [...base, ...(flag in VALUES ? [flag, VALUES[flag]] : [flag])];
      const r = run('session-state.js', args);
      if (REJECT.test(`${r.stdout || ''}${r.stderr || ''}`)) problems.push(`${sub} ${flag}`);
    }
  }
  assert.deepEqual(problems, [],
    `session-state가 선언한 플래그를 거부함:\n  ${problems.join('\n  ')}`);
});
