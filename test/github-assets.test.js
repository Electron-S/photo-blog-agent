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

// --- 21차 리뷰 회귀 ---

test('getGitHubToken — gh 실패 이유를 버리지 않는다', () => {
  // 예전에는 `gh.status !== 0` 하나로 모든 실패를 같은 문장("Set GITHUB_TOKEN or run
  // gh auth login")으로 뭉갰다. 실측한 두 경우가 구조적으로 다른데 진단이 동일했다:
  //   gh 미설치 → status=null, error=ENOENT  → 안내가 `gh auth login`인데 **gh가 없다**
  //   gh 미인증 → status=1, stderr="no oauth token found for github.com" → 그걸 버렸다
  //
  // 이 함수는 export되지 않으므로(모듈을 require하면 sharp 네이티브 바인딩이 로드된다)
  // 소스에서 꺼내 평가한다. 함수 이름을 바꾸면 이 테스트가 먼저 깨진다.
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { errCode, errFull } = require('../lib/err-text');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'github-assets.js'), 'utf8');
  const body = src.match(/function getGitHubToken\(\)[\s\S]*?\n\}/);
  assert.ok(body, 'getGitHubToken을 소스에서 찾지 못함 (이름이 바뀌었나?)');

  // eval된 함수는 이 스코프의 `spawnSync`를 클로저로 집어간다 — 그 자리에 스텁을 끼워
  // gh의 응답을 마음대로 만든다 (실제 gh 설치·인증 상태에 의존하지 않는다).
  let stubbed = null;
  const realSpawnSync = spawnSync;
  // eslint-disable-next-line no-unused-vars
  const spawnSyncShim = (...args) => (stubbed === null ? realSpawnSync(...args) : stubbed);
  const load = () => {
    // eslint-disable-next-line no-eval
    return eval(`(${body[0].replace(/\bspawnSync\(/g, 'spawnSyncShim(')})`);
  };
  void errCode; void errFull; // eval된 함수가 함께 집어간다

  const withEnv = (env, run) => {
    const saved = { ...process.env };
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'PATH']) delete process.env[k];
    Object.assign(process.env, env);
    try { return run(); } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  // (1) 환경변수 토큰은 gh를 부르지 않고 그대로 쓴다 (PATH가 비어도 성공해야 한다)
  assert.equal(
    withEnv({ GITHUB_TOKEN: 'ghp_from_env', PATH: '' }, () => load()()),
    'ghp_from_env',
  );

  // (2) gh를 실행할 수 없으면 "설치되어 있지 않다"고 말한다 — 따를 수 없는 안내를
  //     내지 않는다. PATH를 비우면 spawnSync가 ENOENT를 낸다.
  const notInstalled = withEnv({ PATH: '' }, () => {
    try { load()(); return null; } catch (e) { return e.message; }
  });
  assert.ok(notInstalled, 'PATH가 비었는데 토큰을 반환함');
  assert.match(notInstalled, /ENOENT/);
  assert.match(notInstalled, /설치/, `미설치를 안내하지 않음: ${notInstalled}`);
  assert.match(notInstalled, /GITHUB_TOKEN/, '대안을 안내하지 않음');

  // (3) gh가 인증 실패 이유를 말하면 그것을 전달한다 (실측: "no oauth token found ...")
  stubbed = { status: 1, stdout: '', stderr: 'no oauth token found for github.com', error: undefined };
  const notAuthed = withEnv({ PATH: '' }, () => {
    try { load()(); return null; } catch (e) { return e.message; }
  });
  assert.ok(notAuthed, '인증 실패인데 토큰을 반환함');
  assert.match(notAuthed, /no oauth token found/, `gh의 이유를 버림: ${notAuthed}`);

  // (4) **stdout은 성공 시 토큰이다** — 어떤 오류 메시지에도 실려서는 안 된다.
  //     (텍스트 검사가 아니라 실제로 던져진 메시지를 본다.)
  const SECRET = 'ghp_TOKEN_MUST_NOT_LEAK';
  for (const ghResult of [
    { status: 1, stdout: SECRET, stderr: 'boom', error: undefined },
    { status: 0, stdout: '   ', stderr: '', error: undefined },
    { status: null, stdout: SECRET, stderr: null, error: Object.assign(new Error('spawn fail'), { code: 'EACCES' }) },
  ]) {
    stubbed = ghResult;
    const msg = withEnv({ PATH: '' }, () => {
      try { return { token: load()() }; } catch (e) { return { message: e.message }; }
    });
    if (msg.token !== undefined) {
      assert.notEqual(msg.token.trim(), '', '빈 토큰을 성공으로 반환함');
      continue;
    }
    assert.doesNotMatch(msg.message, new RegExp(SECRET),
      `오류 메시지에 토큰이 노출됨: ${msg.message}`);
  }
  stubbed = null;
});
