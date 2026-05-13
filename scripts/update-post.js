require('dotenv').config();

const { updatePost } = require('../lib/blogger');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node update-post.js --post-id ID [--title "제목"] [--content "HTML 본문"] [--labels "라벨1,라벨2"]');
  console.log('');
  console.log('Options:');
  console.log('  --post-id   Blogger post ID (필수)');
  console.log('  --title     수정할 제목 (생략하면 기존 제목 유지)');
  console.log('  --content   수정할 HTML 본문 (생략하면 기존 본문 유지, 파일 경로도 가능)');
  console.log('  --labels    라벨 (쉼표 구분, 생략하면 기존 라벨 유지)');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  const postId = getArg('--post-id');
  const title = getArg('--title');
  let content = getArg('--content');
  const labelsArg = getArg('--labels');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
  }

  // content가 파일 경로면 파일 내용을 읽음
  if (content && (content.startsWith('/') || content.startsWith('./') || content.startsWith('../'))) {
    const fs = require('fs');
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${err.message}`);
      process.exit(1);
    }
  }

  const updateData = {};
  if (title) updateData.title = title;
  if (content) updateData.content = content;
  if (labelsArg) updateData.labels = labelsArg.split(',').map(l => l.trim()).filter(Boolean);

  if (Object.keys(updateData).length === 0) {
    console.error('Error: at least one of --title, --content, or --labels is required');
    printUsage();
  }

  console.log(`Updating Blogger post ${postId}...`);
  const post = await updatePost(postId, updateData);

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    editUrl: `https://www.blogger.com/blog/post/edit/${process.env.BLOGGER_BLOG_ID}/${post.id}`,
  }, null, 2));
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Post update failed:', details);
  process.exit(1);
});