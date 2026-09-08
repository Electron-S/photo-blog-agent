const axios = require('axios');
const {
  errCode, errCodeTag, errFull, errResponse, errResponseBody, errStatus,
} = require('./err-text');

function getBloggerConfig() {
  const {
    BLOGGER_BLOG_ID: blogId,
    BLOGGER_CLIENT_ID: clientId,
    BLOGGER_CLIENT_SECRET: clientSecret,
    BLOGGER_REFRESH_TOKEN: refreshToken,
  } = process.env;

  if (!blogId || !clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Blogger env vars: BLOGGER_BLOG_ID, BLOGGER_CLIENT_ID, BLOGGER_CLIENT_SECRET, BLOGGER_REFRESH_TOKEN');
  }

  return { blogId, clientId, clientSecret, refreshToken };
}

async function getAccessToken() {
  const { clientId, clientSecret, refreshToken } = getBloggerConfig();
  const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // **200인데 토큰이 없는 응답을 그대로 흘리지 않는다.**
  //
  // 예전에는 `Bearer undefined`로 Blogger를 호출했고, 그러면 Blogger가 401을
  // 돌려줘 "Blogger API GET … 실패 401: Invalid Credentials"로 보고됐다 (실측).
  // 폐기된 refresh token과 **글자 하나까지 같은 진단**이고, 안내대로 재인증해도
  // 낫지 않는다 — 토큰 엔드포인트가 토큰을 주지 않은 것이기 때문이다.
  // 캡티브 포털(호텔·사내 와이파이)이나 MITM 프록시가 200 + HTML을 돌려주면
  // 실제로 이 모양이 된다. 이 파일이 아래에서 막으려던 "OAuth 실패를 Blogger API
  // 실패로 둔갑"과 같은 문제가 **던지지 않는 경로**에 남아 있었다.
  const token = res.data && res.data.access_token;
  if (typeof token !== 'string' || token === '') {
    const shape = res.data && typeof res.data === 'object'
      ? `키: ${Object.keys(res.data).join(', ') || '(없음)'}`
      : `타입: ${typeof res.data}`;
    // 상태 코드마다 읽는 법이 달라 조사를 고정할 수 없다 (200=이백**을**,
    // 404=사백사**를**). 조사를 붙이지 않는 어순으로 쓴다. status가 없는 응답도 있다.
    const statusText = Number.isInteger(res.status) ? `HTTP ${res.status}` : '응답';
    const err = new Error(
      `OAuth 토큰 엔드포인트가 ${statusText}을 돌려줬는데 access_token이 없습니다 (${shape}). `
      + '자격증명 문제가 아닙니다 — 캡티브 포털·프록시가 응답을 가로챘을 수 있으니 '
      + '토큰을 재발급하기 전에 연결을 먼저 확인하세요.',
    );
    // **이 메시지는 그 자체로 완결이다.** 마커가 없으면 아래 wrapTokenError가
    // "응답이 없으니 전송 계층 실패"로 오분류해 `+ Google OAuth 엔드포인트에 닿지
    // 못했습니다`를 덧붙인다 — 첫 줄은 "HTTP 200을 받았다", 둘째 줄은 "닿지 못했다"로
    // **한 메시지 안에서 서로 모순**된다 (실측). 그렇다고 response를 실으면 이번엔
    // `FIX_HINT` 기본값인 "REFRESH_TOKEN/CLIENT_ID를 확인하세요"가 붙어, 이 검사가
    // 없애려던 바로 그 오안내가 돌아온다. 그래서 힌트 부착 자체를 건너뛰게 한다.
    err.tokenShapeFailure = true;
    throw err;
  }
  return token;
}

async function bloggerRequest(method, url, data = undefined) {
  const makeRequest = async (token) => {
    const res = await axios({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    return res.data;
  };

  // OAuth 토큰 엔드포인트의 실패를 Blogger API 실패로 둔갑시키지 않는다.
  // 이 프로젝트에서 가장 잦은 인증 실패인 invalid_grant(토큰 만료·폐기)는 **400**이라
  // 아래 401 분기를 타지 않았고, 그래서 "Blogger API GET .../blogs/1 실패 400"으로
  // 보고됐다 — Blogger는 호출된 적도 없는데. 게다가 OAuth 응답 바디는 error가
  // **문자열**이라 error.message 추출이 undefined가 되어 원인 문구조차 사라졌다.
  const oauthDetail = (err) => {
    const data = errResponseBody(err);
    const code = typeof data?.error === 'string' ? data.error : data?.error?.message;
    return [data?.error_description, code].filter(Boolean).join(' / ') || errFull(err);
  };
  // 조치가 다르면 안내도 달라야 한다. invalid_client는 REFRESH_TOKEN을 아무리
  // 재발급해도 낫지 않는다 — 고쳐야 할 것은 CLIENT_ID/SECRET이다.
  const FIX_HINT = {
    invalid_grant: 'BLOGGER_REFRESH_TOKEN이 만료·폐기되었습니다. npm run blogger:auth 로 재발급하세요.',
    invalid_client: 'BLOGGER_CLIENT_ID / BLOGGER_CLIENT_SECRET을 확인하세요 (토큰 재발급으로는 해결되지 않습니다).',
    unauthorized_client: 'BLOGGER_CLIENT_ID / BLOGGER_CLIENT_SECRET을 확인하세요.',
    invalid_request: '토큰 요청 파라미터가 잘못되었습니다. .env의 Blogger 설정을 확인하세요.',
  };
  const wrapTokenError = (err, context) => {
    // 토큰 shape 실패는 원인·조치가 이미 메시지에 담겨 있다. 힌트를 덧붙이면
    // 전송 계층 실패("닿지 못했습니다")나 자격증명 문제("재발급하세요")로
    // 오분류되는데, 둘 다 사실이 아니다.
    if (err && err.tokenShapeFailure) {
      const passthrough = new Error(`OAuth 토큰 재발급 실패${context}: ${errFull(err)}`);
      passthrough.tokenShapeFailure = true;
      passthrough.cause = err;
      return passthrough;
    }
    const data = errResponseBody(err);
    const code = typeof data?.error === 'string' ? data.error : undefined;
    // **응답이 없으면 자격증명 문제가 아니다.** getAccessToken을 try 밖으로 빼면서
    // 전송 계층 실패(DNS·타임아웃·프록시)가 전부 credential 안내로 나갔다:
    //   OAuth 토큰 재발급 실패: getaddrinfo EAI_AGAIN oauth2.googleapis.com
    //     + BLOGGER_REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET을 확인하세요.
    // .env는 정상인데 토큰을 재발급하게 만든다. naver-browser가
    // "세션 만료와는 다르므로 재로그인이 답이 아닐 수 있습니다"로 막은 것과 같은 문제다.
    const hint = errStatus(err) !== null || errResponseBody(err) !== null
      ? (FIX_HINT[code] || 'BLOGGER_REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET을 확인하세요.')
      : 'Google OAuth 엔드포인트에 닿지 못했습니다 (네트워크·DNS·프록시). '
        + '자격증명 문제가 아니므로 토큰을 재발급하지 말고 연결을 먼저 확인하세요.';
    const wrapped = new Error(
      `OAuth 토큰 재발급 실패${context}${errCodeTag(err)}: ${oauthDetail(err)}\n  + ${hint}`,
    );
    // 호출 측 main catch의 response.data JSON 덤프 분기를 OAuth 실패에서도 살리기 위해 보존.
    const response = errResponse(err);
    if (response) wrapped.response = response;
    if (errStatus(err) !== null) wrapped.status = errStatus(err);
    if (errCode(err) !== null) wrapped.code = errCode(err);
    wrapped.cause = err;
    return wrapped;
  };

  const wrapError = (err, isRetry) => {
    const detail = errResponseBody(err)?.error?.message || errFull(err);
    const status = errStatus(err);
    const code = errCode(err);
    // Blogger의 sub-error reasons(rateLimitExceeded, quotaExceeded, invalidParameter 등)는
    // 재시도 가능성/원인 진단의 핵심 신호라 메시지에 노출한다.
    const errorsList = errResponseBody(err)?.error?.errors;
    const reasonTag = Array.isArray(errorsList) && errorsList.length
      ? ` [${errorsList.map((e) => e.reason).filter(Boolean).join(',')}]`
      : '';
    const codeTag = code ? ` (${code})` : '';
    const statusTag = status ? ` ${status}` : '';
    const retryTag = isRetry ? ' (retry)' : '';
    const wrapped = new Error(`Blogger API ${method.toUpperCase()} ${url} 실패${statusTag}${codeTag}${reasonTag}${retryTag}: ${detail}`);
    if (status) wrapped.status = status;
    if (code) wrapped.code = code;
    // 호출 측 main catch의 JSON 덤프 분기가 dead code가 되지 않도록 원본 response/cause 보존.
    const response = errResponse(err);
    if (response) wrapped.response = response;
    wrapped.cause = err;
    return wrapped;
  };

  // 토큰 획득을 try **밖**에 둔다. 안에 두면 상태 코드가 무엇이든 아래 catch가
  // 받아 Blogger API 라벨을 붙인다 (invalid_grant=400이 정확히 그랬다).
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (tokenErr) {
    throw wrapTokenError(tokenErr, '');
  }

  try {
    return await makeRequest(accessToken);
  } catch (err) {
    if (errStatus(err) === 401) {
      // 여기서의 401은 **Blogger가** 낸 것이다 (토큰 만료 후 재발급 재시도).
      let newToken;
      try {
        newToken = await getAccessToken();
      } catch (tokenErr) {
        throw wrapTokenError(tokenErr, ' (Blogger 401 후)');
      }
      try {
        return await makeRequest(newToken);
      } catch (retryErr) {
        throw wrapError(retryErr, true);
      }
    }
    throw wrapError(err, false);
  }
}

async function getBlog() {
  const { blogId } = getBloggerConfig();
  return bloggerRequest('get', `https://www.googleapis.com/blogger/v3/blogs/${blogId}`);
}

async function getPost(postId) {
  const { blogId } = getBloggerConfig();
  // view=ADMIN: 기본 READER 뷰는 DRAFT/SCHEDULED/SOFT_TRASHED를 404로 가린다.
  // 슬러그 트릭 발행 흐름이 DRAFT를 GET하므로 ADMIN 권한 뷰가 필수.
  return bloggerRequest('get', `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}?view=ADMIN`);
}

async function createDraftPost({ title, content, labels = [] }) {
  const { blogId } = getBloggerConfig();
  return bloggerRequest(
    'post',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts?isDraft=true`,
    { title, content, labels },
  );
}

async function updatePost(postId, updates) {
  const { blogId } = getBloggerConfig();
  const body = {};
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.content !== undefined) body.content = updates.content;
  if (updates.labels !== undefined) body.labels = updates.labels;
  return bloggerRequest(
    'patch',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    body,
  );
}

async function publishPost(postId) {
  const { blogId } = getBloggerConfig();
  return bloggerRequest(
    'post',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}/publish`,
  );
}

// useTrash를 명시적으로 넘긴다. Blogger v3 문서에 기본값이 적혀 있지 않아,
// 생략하면 글이 휴지통에 남는지 영구 삭제되는지 알 수 없다. 휴지통에 남으면
// 옛 URL이 계속 응답해서 Google 색인이 새 URL로의 redirect로 오인한다
// (실제 사고 이력 — CLAUDE.md "URL 슬러그 절대 규칙" 참조).
async function deletePost(postId, { useTrash = false } = {}) {
  const { blogId } = getBloggerConfig();
  return bloggerRequest(
    'delete',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}?useTrash=${useTrash}`,
  );
}

module.exports = {
  createDraftPost,
  deletePost,
  getAccessToken,
  getBlog,
  getPost,
  publishPost,
  updatePost,
};