require('dotenv').config();

const axios = require('axios');
const { getArg } = require('../lib/cli-args');
const { getAccessToken } = require('../lib/blogger');

async function main() {
  const postId = getArg('--post-id');
  const draftOnly = args.includes('--draft-only');

  if (!postId) {
    console.log('Usage: node delete-post.js --post-id ID [--draft-only]');
    console.log('');
    console.log('Options:');
    console.log('  --post-id      Blogger post ID (required)');
    console.log('  --draft-only   Only delete if the post is still a draft');
    process.exit(1);
  }

  const { BLOGGER_BLOG_ID: blogId } = process.env;
  const accessToken = await getAccessToken();

  // 먼저 글 상태 확인
  const getRes = await axios.get(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (draftOnly && getRes.data.status !== 'DRAFT') {
    console.log(`Post ${postId} is not a draft (status: ${getRes.data.status}). Skipping delete.`);
    console.log(JSON.stringify({ id: getRes.data.id, title: getRes.data.title, status: getRes.data.status }, null, 2));
    return;
  }

  console.log(`Deleting post ${postId}: "${getRes.data.title}" (status: ${getRes.data.status})...`);

  await axios.delete(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  console.log(`Post ${postId} deleted.`);
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Delete failed:', details);
  process.exit(1);
});