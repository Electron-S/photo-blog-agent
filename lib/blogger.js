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

  try {
    const accessToken = await getAccessToken();
    return await makeRequest(accessToken);
  } catch (err) {
    if (err.response?.status === 401) {
      try {
        const newToken = await getAccessToken();
        return await makeRequest(newToken);
      } catch (retryErr) {
        const detail = retryErr.response?.data?.error?.message || retryErr.message;
        throw new Error(`Blogger API ${method.toUpperCase()} ${url} 실패 (retry): ${detail}`);
      }
    }
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`Blogger API ${method.toUpperCase()} ${url} 실패: ${detail}`);
  }
}

async function getBlog() {
  const { blogId } = getBloggerConfig();
  return bloggerRequest('get', `https://www.googleapis.com/blogger/v3/blogs/${blogId}`);
}

async function createDraftPost({ title, content, labels = [] }) {
  const { blogId } = getBloggerConfig();
  return bloggerRequest(
    'post',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts?isDraft=true`,
    { title, content, labels },
  );
}

async function updatePost(postId, { title, content, labels = [] }) {
  const { blogId } = getBloggerConfig();
  return bloggerRequest(
    'patch',
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    { title, content, labels },
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
  publishPost,
  updatePost,
};