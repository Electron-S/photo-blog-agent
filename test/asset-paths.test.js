const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalSlugError, hashPath, postDirName, slugCollapsed, slugify,
} = require('../lib/asset-paths');

test('slugify — ASCII 정규화', () => {
  assert.equal(slugify('Seokchon Lake Spring'), 'seokchon-lake-spring');
  assert.equal(slugify('under_score and space'), 'under-score-and-space');
  assert.equal(slugify('multi---hyphen'), 'multi-hyphen');
  assert.equal(slugify('  trim me  '), 'trim-me');
  assert.equal(slugify('Café'), 'cafe');
});

test('slugify — 한글은 제거되어 기본값 post가 된다 (의도된 동작)', () => {
  // 한글은 \w에 걸리지 않아 전부 사라진다. 그래서 워크플로우가 사용자에게
  // 영문 슬러그를 요구한다. 이 동작에 의존하지 말고 --slug를 명시할 것.
  assert.equal(slugify('석촌호수'), 'post');
  assert.equal(slugify(''), 'post');
  assert.equal(slugify(null), 'post');
  assert.equal(slugify(undefined), 'post');
  assert.equal(slugify('!!!'), 'post');
  // 한글 + 영문이 섞이면 영문만 남는다
  assert.equal(slugify('석촌 lake'), 'lake');
});

test('hashPath — 결정적이고 12자 hex', () => {
  const h = hashPath('2026-05-10', 'dim-test');
  assert.match(h, /^[0-9a-f]{12}$/);
  // 고정 벡터: 같은 사진을 며칠 뒤 재업로드해도 같은 폴더를 가리켜야 한다 (멱등성).
  assert.equal(h, '17bad17b0188');
  assert.equal(hashPath('2026-05-10', 'dim-test'), h);
  assert.notEqual(hashPath('2026-05-11', 'dim-test'), h);
  assert.notEqual(hashPath('2026-05-10', 'other'), h);
});

test('postDirName', () => {
  assert.equal(postDirName('2026-05-10', 'dim-test'), '2026-05-10-17bad17b0188');
  assert.match(postDirName('2026-05-10', 'x'), /^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/);
});

test('github-assets가 같은 구현을 re-export한다', () => {
  const ga = require('../lib/github-assets');
  assert.equal(ga.slugify, slugify);
  assert.equal(ga.hashPath, hashPath);
  assert.equal(ga.postDirName, postDirName);
});

test('compressImage의 모든 반환 경로가 같은 필드 집합을 갖는다', async (t) => {
  // 한 경로만 필드를 빠뜨리면 다운스트림이 조용히 undefined를 만난다.
  // 정적 검사로는 놓치기 쉬워 실제로 4개 경로를 실행해 비교한다.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sharp = require('sharp');
  const { compressImage } = require('../lib/github-assets');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-cs-'));
  // **maxRetries/retryDelay는 Windows 때문이다.** sharp(libvips)가 입력 파일 핸들을
  // 아직 쥐고 있으면 Windows는 unlink를 거부하고, 정리 훅이
  // `EPERM: operation not permitted, unlink ...`로 실패한다 — 테스트 본문은 통과했는데
  // `failureType: 'hookFailed'`로 빨강이 된다 (첫 CI 실행의 Windows leg에서 실제로 봤다).
  // Linux에서는 열린 파일도 지워지므로 로컬에서는 절대 드러나지 않는다.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const good = path.join(dir, 'good.jpg');
  await sharp({ create: { width: 60, height: 40, channels: 3, background: '#345' } }).jpeg().toFile(good);

  // 1KB 아래로는 압축되지 않을 만큼 큰 노이즈 이미지 (oversize 경로용).
  const noise = Buffer.alloc(600 * 400 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) % 256;
  const big = path.join(dir, 'big.png');
  await sharp(noise, { raw: { width: 600, height: 400, channels: 3 } }).png().toFile(big);
  const badWebp = path.join(dir, 'bad.webp');
  fs.writeFileSync(badWebp, 'not a webp', 'utf8');
  const badJpg = path.join(dir, 'bad.jpg');
  fs.writeFileSync(badJpg, 'not a jpg', 'utf8');

  const results = [
    await compressImage(good, path.join(dir, 'a.webp'), 'webp', 150),           // 성공
    await compressImage(big, path.join(dir, 'b.webp'), 'webp', 1),              // oversize
    await compressImage(badJpg, path.join(dir, 'c.webp'), 'webp', 150),         // fallback 불가
    await compressImage(badWebp, path.join(dir, 'd.webp'), 'webp', 150),        // fallback 복사
  ];

  const shapes = results.map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(shapes).size, 1, `필드 집합 불일치:\n${shapes.join('\n')}`);
  assert.ok(shapes[0].includes('width'));
  assert.ok(shapes[0].includes('dimensionsError'));

  // 각 경로의 의미도 확인
  assert.equal(results[0].oversize, false);
  assert.equal(results[0].watermarkApplied, true);
  assert.equal(results[1].oversize, true);
  assert.equal(results[2].path, null, 'fallback 불가면 산출물이 없다');
  assert.equal(results[3].fallbackUsed, true);
  assert.equal(results[3].width, null, '치수를 모르면 관례값이 아니라 null');
});

test('escapeXml — 워터마크가 SVG를 깨뜨리지 않는다', () => {
  const { escapeXml } = require('../lib/github-assets');
  assert.equal(escapeXml('Kim & Lee'), 'Kim &amp; Lee');
  assert.equal(escapeXml('<b>'), '&lt;b&gt;');
  assert.equal(escapeXml('a"b\'c'), 'a&quot;b&apos;c');
  assert.equal(escapeXml('평범한 텍스트'), '평범한 텍스트');
});

// --- 7차 리뷰 회귀 ---

test('slugCollapsed — 한글 slug가 조용히 같은 폴더로 붕괴하는 것을 감지한다', () => {
  // slugify는 한글을 전부 지우고 'post'를 준다. 그래서 hashPath가 날짜만의
  // 함수가 되어 **서로 다른 글이 같은 원격 폴더를 쓴다** — 이미 발행된 글의
  // photo-NN.webp가 제자리에서 교체된다. slugify 자체는 ASCII 유지가 목적이므로
  // 호출자가 붕괴를 감지해야 한다.
  assert.equal(slugify('경복궁'), 'post');
  assert.equal(slugify('서울카페'), 'post');
  assert.equal(postDirName('2026-05-10', slugify('경복궁')),
    postDirName('2026-05-10', slugify('서울카페')), '전제 확인: 붕괴하면 같은 폴더');

  for (const collapsing of ['경복궁', '서울카페', '한글제목', '日本語', '★☆']) {
    assert.equal(slugCollapsed(collapsing), true, `${collapsing} 붕괴를 놓침`);
  }
  for (const fine of ['seokchon', 'post', '', '  ', 'a-b-c', '2026-05-10', '- leading']) {
    assert.equal(slugCollapsed(fine), false, `${fine} 를 붕괴로 오탐`);
  }
});

test('canonicalSlugError — slugify가 손대는 값은 전부 거부한다 (부분 붕괴 포함)', () => {
  // slugCollapsed만으로는 부족했다: slugify('trip-경복궁')과 slugify('trip-남산타워')는
  // 둘 다 'trip-'이라 collapsed=false인데 **같은 폴더**가 된다. 원격에서는 이미
  // 발행된 글의 photo-NN.webp를 제자리 덮어쓰기다.
  // 판정을 "붕괴 케이스 열거"에서 "slugify가 손대지 않는 값만 받는다"로 바꿨다.
  assert.equal(canonicalSlugError('seokchon-lake-spring'), null);
  assert.equal(canonicalSlugError('2026-05-10'), null);
  assert.equal(canonicalSlugError('a'), null);

  for (const bad of ['', '   ', '경복궁', 'trip-경복궁', 'trip-남산타워', 'My_Post',
    'Abc', '-lead', 'a b', 'a--b', 'a_b', '日本語']) {
    assert.ok(canonicalSlugError(bad), `${JSON.stringify(bad)}를 통과시킴`);
  }

  // 통과한 slug는 slugify가 손대지 않는다 = 부분 붕괴가 정의상 불가능하다
  for (const good of ['seokchon-lake', '2026-05-10', 'a', 'x1-2-3', 'trip-']) {
    assert.equal(canonicalSlugError(good), null, good);
    assert.equal(slugify(good), good, `${good}: slugify가 값을 바꿈`);
  }
  // 서로 다른 정규형 slug는 서로 다른 폴더다
  const dirs = new Set(['a', 'b', 'trip-seoul', 'trip-namsan']
    .map((s) => postDirName('2026-05-10', s)));
  assert.equal(dirs.size, 4);
});

test('uploadBlogImages는 정규형이 아닌 slug로 업로드하지 않는다', () => {
  // sharp를 로드하므로 여기서만 require한다.
  const { uploadBlogImages } = require('../lib/github-assets');
  return Promise.all([
    assert.rejects(() => uploadBlogImages(['a.jpg'], { date: '2026-05-10' }), /비어 있습니다/),
    assert.rejects(() => uploadBlogImages(['a.jpg'], { date: '2026-05-10', slug: '  ' }), /비어 있습니다/),
    assert.rejects(() => uploadBlogImages(['a.jpg'], { date: '2026-05-10', slug: '경복궁' }), /소문자 영문/),
    // 부분 붕괴 — 7차 수정이 놓쳤던 것
    assert.rejects(() => uploadBlogImages(['a.jpg'], { date: '2026-05-10', slug: 'trip-경복궁' }), /소문자 영문/),
    assert.rejects(() => uploadBlogImages(['a.jpg'], { date: '2026-05-10', slug: 'a--b' }), /정규형이 아닙니다/),
  ]);
});
