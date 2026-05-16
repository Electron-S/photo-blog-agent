const axios = require('axios');

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

  return res.data.access_token;
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

  const wrapError = (err, isRetry) => {
    const detail = err.response?.data?.error?.message || err.message;
    const status = err.response?.status;
    const code = err.code;
    // Blogger의 sub-error reasons(rateLimitExceeded, quotaExceeded, invalidParameter 등)는
    // 재시도 가능성/원인 진단의 핵심 신호라 메시지에 노출한다.
    const errorsList = err.response?.data?.error?.errors;
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
    if (err.response) wrapped.response = err.response;
    wrapped.cause = err;
    return wrapped;
  };

  try {
    const accessToken = await getAccessToken();
    return await makeRequest(accessToken);
  } catch (err) {
    if (err.response?.status === 401) {
      // 토큰 재발급 실패는 OAuth 엔드포인트의 문제 — Blogger API URL 라벨로 둔갑시키지 않는다.
      let newToken;
      try {
        newToken = await getAccessToken();
      } catch (tokenErr) {
        const detail = tokenErr.response?.data?.error_description
          || tokenErr.response?.data?.error
          || tokenErr.message;
        const wrapped = new Error(`OAuth 토큰 재발급 실패 (Blogger 401 후): ${detail}. BLOGGER_REFRESH_TOKEN 확인 필요.`);
        // 호출 측 main catch의 response.data JSON 덤프 분기를 OAuth 실패에서도 살리기 위해 보존.
        if (tokenErr.response) wrapped.response = tokenErr.response;
        if (tokenErr.response?.status) wrapped.status = tokenErr.response.status;
        if (tokenErr.code) wrapped.code = tokenErr.code;
        wrapped.cause = tokenErr;
        throw wrapped;
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

module.exports = {
  createDraftPost,
  getAccessToken,
  getBlog,
  getPost,
  publishPost,
  updatePost,
};