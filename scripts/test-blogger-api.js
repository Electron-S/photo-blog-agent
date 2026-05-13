require('dotenv').config();

const { getBlog } = require('../lib/blogger');

const {
  BLOGGER_BLOG_ID: blogId,
  BLOGGER_CLIENT_ID: clientId,
  BLOGGER_CLIENT_SECRET: clientSecret,
  BLOGGER_REFRESH_TOKEN: refreshToken,
} = process.env;

async function main() {
  if (!blogId || !clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Blogger env vars.');
  }

  const blog = await getBlog();

  console.log(JSON.stringify({
    id: blog.id,
    name: blog.name,
    url: blog.url,
    posts: blog.posts?.totalItems,
  }, null, 2));
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error(details);
  process.exit(1);
});