require('dotenv').config();

const { createDraftPost } = require('../lib/blogger');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node create-draft.js --title "제목" --content "HTML 본문" [--labels "라벨1,라벨2"]');
  console.log('');
  console.log('Options:');
  console.log('  --title     글 제목 (필수)');
  console.log('  --content   HTML 본문 (필수, 파일 경로도 가능)');
  console.log('  --labels    라벨 (쉼표 구분)');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  let title = getArg('--title');
  let content = getArg('--content');
  const labelsArg = getArg('--labels');

  if (!title) {
    console.error('Error: --title is required');
    printUsage();
  }

  if (!content) {
    console.error('Error: --content is required');
    printUsage();
  }

  // content가 파일 경로면 파일 내용을 읽음
  const fs = require('fs');
  if (content.startsWith('/') || content.startsWith('./') || content.startsWith('../')) {
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${err.message}`);
      process.exit(1);
    }
  }

  const labels = labelsArg ? labelsArg.split(',').map(l => l.trim()).filter(Boolean) : [];

  console.log('Creating Blogger draft...');
  const post = await createDraftPost({ title, content, labels });

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    editUrl: `https://www.blogger.com/blog/post/edit/${process.env.BLOGGER_BLOG_ID}/${post.id}`,
    published: post.published,
  }, null, 2));
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Draft creation failed:', details);
  process.exit(1);
});