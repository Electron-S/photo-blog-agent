require('dotenv').config();

const { publishPost } = require('../lib/blogger');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node publish-post.js --post-id ID');
  console.log('');
  console.log('Options:');
  console.log('  --post-id   Blogger post ID (필수)');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  const postId = getArg('--post-id');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
  }

  console.log(`Publishing Blogger post ${postId}...`);
  const post = await publishPost(postId);

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    published: post.published,
  }, null, 2));
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Publish failed:', details);
  process.exit(1);
});