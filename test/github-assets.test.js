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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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

// --- 22차 리뷰 회귀 ---

test('escapeXml — XML이 표현할 수 없는 제어문자를 남기지 않는다', () => {
  // XML 1.0은 C0 제어문자(0x0B VT, 0x0C FF, 0x01~0x08, 0x0E~0x1F)를 **어떤 인코딩으로도**
  // 표현하지 못한다 (`&#11;`도 불허). 남겨 두면 libxml이 "PCDATA invalid Char value 11"로
  // 죽는데, 그 실패가 sharp의 "Input buffer has corrupt header"로 감싸여
  // **사진 문제로 오진**된다 (실측: WATERMARK_TEXT에 0x0B 한 글자 → fallbackUsed=true,
  // watermarkApplied=false, 안내는 "원본 파일 점검 필요").
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'github-assets.js'), 'utf8');
  const body = src.match(/function escapeXml\(value\)[\s\S]*?\n\}/);
  assert.ok(body, 'escapeXml을 소스에서 찾지 못함');
  // eval된 함수가 클로저로 집어간다 (lib과 같은 정의를 여기서 다시 쓴다 —
  // 이 상수가 lib에서 사라지면 아래 단언이 깨져서 알 수 있다)
  // eslint-disable-next-line no-unused-vars
  const XML_ILLEGAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  // eslint-disable-next-line no-eval
  const escapeXml = eval(`(${body[0]})`);

  for (const cp of [0x00, 0x01, 0x08, 0x0B, 0x0C, 0x0E, 0x1F]) {
    const out = escapeXml(`site${String.fromCodePoint(cp)}.com`);
    assert.equal(out, 'site.com', `U+${cp.toString(16)} 가 남음: ${JSON.stringify(out)}`);
  }
  // XML이 허용하는 공백문자(tab/LF/CR)는 지우지 않는다
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
  // 기존 이스케이프는 그대로
  assert.equal(escapeXml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

test('uploadAsset — 이미 있는 경로에 다른 내용을 조용히 덮어쓰지 않는다', async (t) => {
  // 예전에는 기존 파일의 sha를 얻어 **무조건 PUT**하고, 커밋 메시지는 그대로
  // "Add blog asset", 요약은 ok, 경고는 0건이었다. 그런데 CLAUDE.md는 멱등성을 위해
  // **같은 slug를 유지하라**고 지시한다 — 사진을 하나 앞에 추가해 재실행하면
  // photo-NN이 입력 argv 순서로 붙으므로 photo-01이 다른 사진이 되고, 이미 LIVE인
  // 글의 이미지가 한 칸씩 밀려 **전부 바뀐다**. 되돌릴 수 없다.
  const crypto = require('node:crypto');
  const fsp = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');

  const dir = fsp.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-ua-'));
  t.after(() => fsp.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = pathMod.join(dir, 'photo-01.webp');
  const bytes = Buffer.from('IMAGE-BYTES-A');
  fsp.writeFileSync(file, bytes);
  // git blob object id — GitHub Contents API의 sha와 같은 값이다
  const realSha = crypto.createHash('sha1')
    .update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex');

  const puts = [];
  const withStub = async (remoteSha, run) => {
    puts.length = 0;
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: 'x', GITHUB_OWNER: 'o', GITHUB_ASSET_REPO: 'r' });
    const Module = require('node:module');
    const origLoad = Module._load;
    Module._load = function load(request, ...rest) {
      if (request === 'axios') {
        return {
          get: async () => {
            if (remoteSha === null) { const e = new Error('nf'); e.response = { status: 404 }; throw e; }
            return { data: { sha: remoteSha } };
          },
          put: async (u, b) => { puts.push(b.message); return { data: {} }; },
          head: async () => ({ status: 200 }),
        };
      }
      return origLoad.call(this, request, ...rest);
    };
    const LIB = require.resolve('../lib/github-assets');
    delete require.cache[LIB];
    try { return await run(require(LIB)); } finally {
      Module._load = origLoad;
      delete require.cache[LIB];
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  // 내용이 같으면 PUT 자체를 보내지 않는다 — 이것이 진짜 멱등이다
  const same = await withStub(realSha, (ga) => ga.uploadAsset(file, 'posts/d/photo-01.webp'));
  assert.equal(same.status, 'unchanged');
  assert.equal(puts.length, 0, '같은 내용인데 PUT을 보냄 (커밋이 쌓인다)');

  // 내용이 다르면 기본은 거부다 — PUT이 나가기 전에 막아야 한다
  await withStub('deadbeef', async (ga) => {
    await assert.rejects(
      () => ga.uploadAsset(file, 'posts/d/photo-01.webp', { allowReplace: false }),
      (e) => e.kind === 'replace' && /이미 발행된 글/.test(e.message),
    );
  });
  assert.equal(puts.length, 0, '거부했는데 PUT이 나감');

  // **옵션을 아예 넘기지 않아도 거부여야 한다.** 이 함수는 export되어 있고, 새
  // 호출자가 옵션을 잊었을 때 조용히 교체되는 쪽으로 실패하면 안 된다.
  // (기본값을 허용으로 되돌리는 뮤테이션을 아무 테스트도 잡지 못해서 추가했다 —
  //  uploadBlogImages가 항상 명시적으로 넘기므로 기본값이 어디에도 안 닿았다.)
  await withStub('deadbeef', async (ga) => {
    await assert.rejects(
      () => ga.uploadAsset(file, 'posts/d/photo-01.webp'),
      (e) => e.kind === 'replace',
      '옵션 생략 시 기본값이 허용이다 (거부여야 한다)',
    );
  });
  assert.equal(puts.length, 0, '기본값으로 교체가 나감');

  // 명시적으로 허용하면 교체하고, 커밋 메시지가 사실을 말한다
  const replaced = await withStub('deadbeef',
    (ga) => ga.uploadAsset(file, 'posts/d/photo-01.webp', { allowReplace: true }));
  assert.equal(replaced.status, 'replaced');
  assert.match(puts[0], /^Replace /, `교체인데 커밋 메시지가 "${puts[0]}"`);

  // 신규는 그대로 추가
  const created = await withStub(null, (ga) => ga.uploadAsset(file, 'posts/d/photo-09.webp'));
  assert.equal(created.status, 'created');
  assert.match(puts[0], /^Add /);
});

// --- 23차 리뷰 회귀 ---

// uploadBlogImages를 스텁으로 돌리는 하네스. 실제 네트워크·GitHub push는 없다.
async function withUploadStub({ remoteSha = null, headFailures = 0 }, run) {
  const Module = require('node:module');
  const origLoad = Module._load;
  const puts = [];
  let fails = headFailures;
  // **PUT이 원격 상태를 바꾼다.** 이걸 반영하지 않으면 재시도 경로가 현실과 달라진다 —
  // 실제로는 재시도 시점에 방금 올린 내용이 원격에 있어 uploadAsset이 'unchanged'를
  // 돌려주는데, 고정 sha 스텁에서는 계속 'replaced'가 나왔다. 그래서 "재시도가
  // uploadStatus를 강등하지 않는다"는 가드를 제거해도 테스트가 통과했다 (뮤테이션이
  // 잡아냄). 스텁이 현실보다 관대하면 그만큼 테스트가 비어 있는 것이다.
  let current = remoteSha;
  const saved = { ...process.env };
  Object.assign(process.env, { GITHUB_TOKEN: 'stub', GITHUB_OWNER: 'o', GITHUB_ASSET_REPO: 'r' });
  Module._load = function load(request, ...rest) {
    if (request === 'axios') {
      return {
        get: async () => {
          if (current === null) { const e = new Error('nf'); e.response = { status: 404 }; throw e; }
          return { data: { sha: current } };
        },
        put: async (u, b) => {
          puts.push(b.message.split(' ')[0]);
          const crypto = require('node:crypto');
          const bytes = Buffer.from(b.content, 'base64');
          current = crypto.createHash('sha1')
            .update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex');
          return { data: {} };
        },
        head: async () => {
          if (fails > 0) { fails -= 1; const e = new Error('x'); e.response = { status: 404 }; throw e; }
          return { status: 200 };
        },
      };
    }
    return origLoad.call(this, request, ...rest);
  };
  const LIB = require.resolve('../lib/github-assets');
  delete require.cache[LIB];
  try {
    return await run(require(LIB), puts);
  } finally {
    Module._load = origLoad;
    delete require.cache[LIB];
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

async function makeTestJpeg(dir) {
  const sharp = require('sharp');
  const p = require('node:path').join(dir, 'a.jpg');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg().toFile(p);
  return p;
}

test('업로드 결과 투영이 lib의 모든 키를 덮는다', async (t) => {
  // 예전에는 scripts/upload-images.js가 필드를 **하나씩 열거해** 옮겼고, lib이 새
  // 필드(remotePath·uploadStatus)를 만들어도 그 목록에 넣는 것을 잊으면 인메모리에만
  // 존재했다. 실제로 그렇게 됐다 — "검증 실패 시 되돌릴 대상 주소를 남긴다"는 수정이
  // tmp/upload-<slug>.json에 한 글자도 도달하지 않아 수정 전과 결과가 같았다.
  // 케이스가 아니라 **클래스**를 고정한다: lib이 만드는 키는 전부 투영에 있어야 한다.
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const { OUTPUT_IMAGE_KEYS, INTENTIONALLY_OMITTED } = require('../lib/upload-result');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-proj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const img = await makeTestJpeg(dir);

  const collect = (result) => Object.keys(result.images[0]);
  const keySets = [];
  // 성공 경로와 실패 경로가 서로 다른 키를 만들 수 있으므로 둘 다 본다
  keySets.push(await withUploadStub({}, (ga) => ga.uploadBlogImages([img], {
    date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, 'w1'),
  }).then(collect)));
  keySets.push(await withUploadStub({ headFailures: 99 }, (ga) => ga.uploadBlogImages([img], {
    date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, 'w2'),
  }).then(collect)));
  keySets.push(await withUploadStub({}, (ga) => ga.uploadBlogImages(['/nonexistent.jpg'], {
    date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, 'w3'),
  }).then(collect)));

  const libKeys = [...new Set(keySets.flat())];
  const dropped = libKeys.filter((k) => !OUTPUT_IMAGE_KEYS.includes(k) && !INTENTIONALLY_OMITTED.has(k));
  assert.deepEqual(dropped, [],
    `lib이 만드는 키가 산출물에 도달하지 않음: ${dropped.join(', ')}\n`
    + '  lib/upload-result.js의 toOutputImage에 추가하거나, 빼는 이유를 '
    + 'INTENTIONALLY_OMITTED에 적으세요.');
});

test('검증이 실패해도 공개된 주소는 산출물에 남는다', async (t) => {
  // 바이트는 공개 저장소에 있는데 tmp/upload-<slug>.json(모델 간 핸드오프 정본)에는
  // 주소가 없고 stderr에만 남았다 — 되돌릴 대상을 찾을 수 없었다.
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const { toOutputImage } = require('../lib/upload-result');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-rp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const img = await makeTestJpeg(dir);

  const { result, puts } = await withUploadStub({ headFailures: 99 }, async (ga, p) => ({
    result: await ga.uploadBlogImages([img], {
      date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, 'w'),
    }),
    puts: p,
  }));
  const out = toOutputImage(result.images[0]);

  assert.ok(puts.length > 0, '전제: 바이트가 실제로 push됐다');
  assert.equal(out.webpUrl, null, '검증 실패인데 쓸 수 있는 URL을 남김');
  assert.match(String(out.remotePath), /^posts\/2026-05-14-[0-9a-f]{12}\/photo-01\.webp$/,
    `공개된 주소가 기록되지 않음: ${JSON.stringify(out.remotePath)}`);
  assert.equal(out.uploadStatus, 'created');
});

test('재시도가 uploadStatus를 unchanged로 강등하지 않는다', async (t) => {
  // 재시도 시점에는 방금 PUT한 내용이 이미 원격에 있어 uploadAsset이 'unchanged'를
  // 돌려준다. 그걸 그대로 쓰면 **이미 LIVE인 글의 이미지를 실제로 교체한 실행이
  // 기록상 "아무것도 건드리지 않음"**이 된다 (실측: PUT은 'Replace'인데 기록은
  // 'unchanged'). 재시도가 도는 조건은 GitHub Pages 전파 지연이라 예외가 아니다.
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const { toOutputImage } = require('../lib/upload-result');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const img = await makeTestJpeg(dir);

  const run = (stub, options, w) => withUploadStub(stub, async (ga, puts) => ({
    out: toOutputImage((await ga.uploadBlogImages([img], {
      date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, w), ...options,
    })).images[0]),
    puts,
  }));

  // 교체 + 재시도 1회 → 'replaced'가 유지되어야 한다
  const replaced = await run({ remoteSha: 'deadbeef', headFailures: 1 }, { allowReplace: true }, 'w1');
  assert.deepEqual(replaced.puts, ['Replace'], '전제: 교체 PUT이 나갔다');
  assert.equal(replaced.out.uploadStatus, 'replaced',
    `교체했는데 ${JSON.stringify(replaced.out.uploadStatus)}로 기록됨`);

  // 신규 + 재시도 1회 → 'created'가 유지되어야 한다
  const created = await run({ headFailures: 1 }, {}, 'w2');
  assert.deepEqual(created.puts, ['Add'], '전제: 신규 PUT이 나갔다');
  assert.equal(created.out.uploadStatus, 'created',
    `신규인데 ${JSON.stringify(created.out.uploadStatus)}로 기록됨`);
});

test('교체 거부는 기본값이고, 부분 업로드 위험을 함께 안내한다', async (t) => {
  // 거부는 이미지 단위라 같은 배치의 다른 사진(특히 새로 추가한 것)은 이 판정 전에
  // 이미 push됐을 수 있다. "새 글이라면 --slug를 다르게 주세요"만 안내하면 그것들이
  // 옛 폴더에 고아로 남아 계속 공개된다.
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-rj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const img = await makeTestJpeg(dir);

  const { result, puts } = await withUploadStub({ remoteSha: 'deadbeef' }, async (ga, p) => ({
    result: await ga.uploadBlogImages([img], {
      date: '2026-05-14', slug: 'trip', workDir: pathMod.join(dir, 'w'),
    }),
    puts: p,
  }));
  assert.equal(puts.length, 0, '거부했는데 PUT이 나감');
  const err = String(result.images[0].error);
  assert.match(err, /이미 있는 경로에 다른 내용/);
  assert.match(err, /--allow-replace/);
  assert.match(err, /같은 배치의 다른 사진은 이미 업로드/, '부분 업로드 위험을 안내하지 않음');
  assert.match(err, /remotePath/, '무엇이 올라갔는지 확인할 곳을 안내하지 않음');
});

// --- 25차 리뷰 회귀 ---

test('--work-dir가 글 폴더 분리를 없애면 표면화한다', async (t) => {
  // 기본 workDir은 `tmp/assets/{date}-{hash12}`이고, 그 세그먼트가 글마다 로컬
  // 산출물을 분리하는 **유일한** 수단이다. `--work-dir`를 주면 그 경로를 그대로
  // 쓰므로 분리가 사라진다 — 서로 다른 글을 같은 경로로 돌리면 photo-NN.webp가
  // 조용히 덮어써지고, 먼저 만든 글의 upload-<slug>.json에 적힌 webpPath가
  // **나중 글의 사진**을 가리킨다 (실측 재현). 네이버 발행은 그 경로의 파일을
  // 그대로 에디터에 올리므로 다른 글의 사진이 올라간다.
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const sharp = require('sharp');
  const { postDirName } = require('../lib/asset-paths');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pba-wd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const mk = async (name, tint) => {
    const p = pathMod.join(dir, name);
    await sharp({ create: { width: 400, height: 300, channels: 3,
      background: { r: tint, g: 90, b: 160 } } }).jpeg().toFile(p);
    return p;
  };
  const a = await mk('a.jpg', 30);
  const b = await mk('b.jpg', 210);

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let r1;
  let r2;
  try {
    const { uploadBlogImages } = require('../lib/github-assets');
    const shared = pathMod.join(dir, 'shared');
    r1 = await uploadBlogImages([a], {
      date: '2026-05-10', slug: 'post-one', localOnly: true, workDir: shared,
    });
    r2 = await uploadBlogImages([b], {
      date: '2026-05-10', slug: 'post-two', localOnly: true, workDir: shared,
    });
  } finally {
    console.warn = origWarn;
  }

  // 전제: 실제로 덮어썼다 (같은 경로, 다른 내용)
  assert.equal(r1.images[0].webpPath, r2.images[0].webpPath, '전제: 같은 경로를 쓴다');
  assert.ok(warns.some((w) => /--work-dir가 글 폴더/.test(w)),
    `분리가 사라졌는데 경고하지 않음:\n${warns.join('\n')}`);
  assert.ok(warns.some((w) => /webpPath/.test(w)),
    '기록된 경로가 어긋날 수 있다는 것을 안내하지 않음');

  // 기본값(생략)에서는 조용해야 한다 — 그 경로는 postDir을 포함한다
  const quiet = [];
  console.warn = (...args) => { quiet.push(args.join(' ')); };
  try {
    const { uploadBlogImages } = require('../lib/github-assets');
    await uploadBlogImages([a], {
      date: '2026-05-10', slug: 'post-one', localOnly: true,
      workDir: pathMod.join(dir, postDirName('2026-05-10', 'post-one')),
    });
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(quiet.filter((w) => /--work-dir가 글 폴더/.test(w)), [],
    '글 폴더와 일치하는데 경고함');
});
