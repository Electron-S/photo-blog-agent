const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const LIB = path.join(__dirname, '..', 'lib', 'github-assets.js');

// sharp가 항상 실패하는 상황에서 집계가 정확한지 본다. 실제 sharp를 쓰면
// "디코드 불가 파일"을 만들기 어렵고 테스트가 느려진다.
// `async`로 두고 `await run(...)` 한다. 동기 finally로 복원하면 promise가
// settle되기 **전에** 패치가 풀려, 지금은 lib이 sharp를 top-level require해서
// 클로저가 스텁을 붙잡고 있는 덕에 우연히 통과한다. 그 require가 lazy로 바뀌면
// 테스트가 실제 sharp를 쓰면서 **엉뚱한 이유로 계속 통과**한다.
async function withFailingSharp(run) {
  const origLoad = Module._load;
  const fakeSharp = () => { throw new Error('Input buffer contains unsupported image format'); };
  fakeSharp.cache = () => {};
  Module._load = function load(request, ...rest) {
    if (request === 'sharp') return fakeSharp;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(LIB)];
  try {
    return await run(require(LIB));
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(LIB)];
  }
}

test('fallback 불가를 fallbackUsed로 오집계하지 않는다', async (t) => {
  // throw 메시지가 `compressImage`로 시작해서 문자열 검사가 참이 됐고,
  // **폴백이 실행되지 않고 출력 파일도 없는** 이미지에 fallbackUsed가 붙었다
  // (실측: 3장 전부 실패인데 "3/3 fallback 경로 — 원본 파일 점검 필요"로 보고).
  // 조치가 다르면 집계도 달라야 한다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-ga-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputs = ['a.jpg', 'b.jpg', 'c.jpg'].map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'not an image', 'utf8');
    return p;
  });

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    GITHUB_OWNER: 'x', GITHUB_ASSET_REPO: 'y', GITHUB_ASSET_BASE_URL: 'https://x/y',
  });
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const { images, summary } = await withFailingSharp(({ uploadBlogImages }) => uploadBlogImages(
      inputs,
      { date: '2026-05-10', slug: 'test-slug', localOnly: true, workDir: dir },
    ));
    assert.equal(summary.failed, 3);
    assert.equal(summary.fallback, 0, 'fallback이 실행되지 않았는데 집계됨');
    assert.equal(summary.contractViolation, 0);
    assert.deepEqual(images.map((i) => i.fallbackUsed), [false, false, false]);
    // 원인은 남긴다 — 조용히 사라지면 안 된다
    for (const im of images) {
      assert.match(im.error, /fallback unsupported/);
      assert.match(im.compressionError, /fallback unsupported/);
      assert.equal(im.webpPath, null);
    }
  } finally {
    console.warn = origWarn;
    console.error = origError;
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }
});
