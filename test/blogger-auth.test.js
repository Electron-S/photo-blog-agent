// lib/blogger.js — 인증 실패 경로의 **라벨과 조치 안내**를 고정한다.
//
// 여기서 검증하는 것은 "어느 시스템이 실패했는가"이다. OAuth 토큰 엔드포인트의
// 실패를 Blogger API 실패로 보고하면, 첫 줄이 엉뚱한 곳을 가리켜 사용자가
// 재시도·네트워크 점검으로 시간을 버린다. axios를 스텁으로 갈아끼워
// 네트워크·자격증명 없이 확인한다 (CI에 .env가 없다).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const BLOGGER_PATH = path.join(__dirname, '..', 'lib', 'blogger.js');

// scenario: { token(n), blogger(n) } — 각 호출 회차에 무엇을 돌려줄지 결정한다.
async function withStubbedAxios(scenario, run) {
  const calls = { token: 0, blogger: 0 };
  const httpError = ({ status, data }) => {
    const err = new Error(`Request failed with status code ${status}`);
    err.code = 'ERR_BAD_REQUEST';
    err.response = { status, data };
    return err;
  };
  const axiosStub = async (cfg) => {
    calls.blogger += 1;
    const s = scenario.blogger(calls.blogger, cfg);
    if (s.ok) return { data: s.data };
    throw httpError(s);
  };
  axiosStub.post = async () => {
    calls.token += 1;
    const s = scenario.token(calls.token);
    if (s.ok) return { data: { access_token: 'tok' } };
    throw httpError(s);
  };

  const origLoad = Module._load;
  const origEnv = { ...process.env };
  Module._load = function load(request, ...rest) {
    if (request === 'axios') return axiosStub;
    return origLoad.call(this, request, ...rest);
  };
  Object.assign(process.env, {
    BLOGGER_BLOG_ID: '1', BLOGGER_CLIENT_ID: 'c',
    BLOGGER_CLIENT_SECRET: 's', BLOGGER_REFRESH_TOKEN: 'r',
  });
  delete require.cache[require.resolve(BLOGGER_PATH)];
  try {
    // await가 없으면 finally가 run의 첫 await 이전에 실행돼 스텁·env가 벗겨진다.
    return await run(require(BLOGGER_PATH), calls);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(BLOGGER_PATH)];
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }
}

const OAUTH_FAIL = (error, description, status) => () => ({
  status, data: { error, error_description: description },
});
const BLOGGER_OK = () => ({ ok: true, data: { id: 'B' } });

test('만료된 refresh token(OAuth 400)이 Blogger API 실패로 둔갑하지 않는다', async () => {
  // 이 프로젝트에서 가장 잦은 인증 실패다. invalid_grant는 **400**이라 401
  // 재발급 분기를 타지 않았고, getAccessToken이 try 안에 있어서 바깥 catch가
  // "Blogger API GET .../blogs/1 실패 400"이라는 라벨을 붙였다 — Blogger는
  // 호출된 적도 없는데. OAuth 바디는 error가 문자열이라 error.message 추출이
  // undefined가 되어 원인 문구(invalid_grant)조차 사라졌다.
  await withStubbedAxios({
    token: OAUTH_FAIL('invalid_grant', 'Token has been expired or revoked.', 400),
    blogger: BLOGGER_OK,
  }, async ({ getBlog }, calls) => {
    await assert.rejects(getBlog, (err) => {
      assert.match(err.message, /OAuth 토큰 재발급 실패/);
      assert.doesNotMatch(err.message.split('\n')[0], /Blogger API/);
      assert.match(err.message, /invalid_grant/);
      assert.match(err.message, /blogger:auth/);
      return true;
    });
    assert.equal(calls.blogger, 0, 'Blogger API가 호출되면 안 된다');
  });
});

test('invalid_client는 REFRESH_TOKEN이 아니라 CLIENT_ID/SECRET을 가리킨다', async () => {
  // 조치가 다르면 안내도 달라야 한다 — 토큰을 몇 번 재발급해도 낫지 않는다.
  await withStubbedAxios({
    token: OAUTH_FAIL('invalid_client', 'The OAuth client was not found.', 401),
    blogger: BLOGGER_OK,
  }, async ({ getBlog }, calls) => {
    await assert.rejects(getBlog, (err) => {
      assert.match(err.message, /BLOGGER_CLIENT_ID \/ BLOGGER_CLIENT_SECRET/);
      assert.doesNotMatch(err.message.split('\n')[0], /Blogger API/);
      return true;
    });
    // OAuth 401을 "Blogger 401"로 오인해 토큰을 한 번 더 받으러 가지 않는다
    assert.equal(calls.token, 1);
    assert.equal(calls.blogger, 0);
  });
});

test('Blogger가 낸 401만 토큰 재발급 후 재시도한다', async () => {
  await withStubbedAxios({
    token: () => ({ ok: true }),
    blogger: (n) => (n === 1
      ? { status: 401, data: { error: { message: 'Invalid Credentials' } } }
      : BLOGGER_OK()),
  }, async ({ getBlog }, calls) => {
    assert.deepEqual(await getBlog(), { id: 'B' });
    assert.equal(calls.blogger, 2);
    assert.equal(calls.token, 2);
  });
});

test('진짜 Blogger 실패는 Blogger 라벨과 reason 태그를 유지한다', async () => {
  await withStubbedAxios({
    token: () => ({ ok: true }),
    blogger: () => ({
      status: 400,
      data: { error: { message: 'Invalid value', errors: [{ reason: 'invalidParameter' }] } },
    }),
  }, async ({ getBlog }) => {
    await assert.rejects(getBlog, (err) => {
      assert.match(err.message, /Blogger API GET/);
      assert.match(err.message, /\[invalidParameter\]/);
      assert.match(err.message, /Invalid value/);
      assert.equal(err.status, 400);
      return true;
    });
  });
});

// --- 26차 리뷰 회귀 ---

test('OAuth가 200인데 토큰이 없으면 Blogger 401로 둔갑시키지 않는다', async (t) => {
  // 예전에는 `Bearer undefined`로 Blogger를 호출했고, Blogger가 401을 돌려줘
  // "Blogger API GET … 실패 401: Invalid Credentials"로 보고됐다 — **폐기된 refresh
  // token과 글자 하나까지 같은 진단**이고, 안내대로 재인증해도 낫지 않는다
  // (토큰 엔드포인트가 토큰을 주지 않은 것이기 때문이다). 캡티브 포털이나 MITM
  // 프록시가 200 + HTML을 돌려주면 실제로 이 모양이 된다.
  //
  // lib/blogger.js는 "OAuth 실패를 Blogger API 실패로 둔갑시키지 않는다"를 명시적
  // 목표로 삼는데, 그 가드가 **던지는 경로**에만 있었다.
  const Module = require('node:module');
  const LIB = require.resolve('../lib/blogger');

  const withToken = async (tokenResponse, run) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      BLOGGER_BLOG_ID: '1', BLOGGER_CLIENT_ID: 'c',
      BLOGGER_CLIENT_SECRET: 's', BLOGGER_REFRESH_TOKEN: 'r',
    });
    const origLoad = Module._load;
    Module._load = function load(request, ...rest) {
      if (request === 'axios') {
        const ax = async () => {
          const e = new Error('Request failed with status code 401');
          e.response = { status: 401, data: { error: { message: 'Invalid Credentials' } } };
          throw e;
        };
        ax.post = async () => tokenResponse;
        return ax;
      }
      return origLoad.call(this, request, ...rest);
    };
    delete require.cache[LIB];
    try { return await run(require(LIB)); } finally {
      Module._load = origLoad;
      delete require.cache[LIB];
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  const messageOf = async (tokenResponse) => withToken(tokenResponse, async (blogger) => {
    try { await blogger.getPost('123'); return null; } catch (e) { return e.message; }
  });

  // 토큰이 없거나 비었으면 **토큰 단계**의 실패로 보고한다
  for (const data of [{}, { access_token: null }, { access_token: '' }, { error: 'x' }]) {
    const msg = await messageOf({ status: 200, data });
    assert.ok(msg, `${JSON.stringify(data)}: 오류 없이 통과`);
    assert.match(msg, /access_token이 없습니다/, `잘못된 층에서 보고: ${msg.split('\n')[0]}`);
    assert.doesNotMatch(msg, /Blogger API/,
      `Blogger API 실패로 둔갑: ${msg.split('\n')[0]}`);
    // 자격증명 재발급을 권하지 않는다 — 그건 이 상황에 듣지 않는다
    assert.match(msg, /연결을 먼저 확인/);
  }
  // 응답 자체가 객체가 아닌 경우(프록시가 HTML을 준 경우)도 같은 층에서 잡는다
  const html = await messageOf({ status: 200, data: '<html>Sign in to WiFi</html>' });
  assert.match(html, /access_token이 없습니다/);

  // 정상 토큰이면 Blogger 층까지 간다 (여기서 401이 나는 것은 진짜 Blogger 응답이다)
  const ok = await messageOf({ status: 200, data: { access_token: 'tok' } });
  assert.match(ok, /Blogger API/);

  // **한 메시지 안에서 두 줄이 모순되면 안 된다.** 이 오류는 `.response`가 없는
  // 평범한 Error라, 마커가 없으면 wrapTokenError가 "응답이 없으니 전송 계층 실패"로
  // 오분류해 `+ Google OAuth 엔드포인트에 닿지 못했습니다`를 덧붙였다 — 첫 줄은
  // "HTTP 200을 돌려줬는데", 둘째 줄은 "닿지 못했다"였다 (실측). 그렇다고 response를
  // 실으면 이번엔 FIX_HINT 기본값인 "REFRESH_TOKEN을 확인하세요"가 붙어, 이 검사가
  // 없애려던 오안내가 돌아온다.
  for (const data of [{}, '<html>Sign in to WiFi</html>', { expires_in: 3600 }]) {
    const msg = await messageOf({ status: 200, data });
    assert.doesNotMatch(msg, /닿지 못했습니다/,
      `"HTTP 200을 받았다"와 "닿지 못했다"가 한 메시지에 함께 있음:\n${msg}`);
    assert.doesNotMatch(msg, /BLOGGER_REFRESH_TOKEN \/ CLIENT_ID/,
      `자격증명 재발급을 권함 (이 상황에 듣지 않는다):\n${msg}`);
  }

  // 상태 코드마다 읽는 법이 달라 조사를 고정할 수 없다. status가 없는 응답도 있다.
  const noStatus = await messageOf({ data: {} });
  assert.doesNotMatch(noStatus, /HTTP undefined/, `status가 없는데 "HTTP undefined": ${noStatus}`);
  assert.match(noStatus, /응답을 돌려줬는데/);
});
