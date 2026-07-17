require('dotenv').config();

const { createDraftPost } = require('../lib/blogger');
const { getArg, validateKnownFlags } = require('../lib/cli-args');

function printUsage() {
  console.log('Usage: node create-draft.js --title "제목" --content "HTML 본문" [--labels "라벨1,라벨2"]');
  console.log('');
  console.log('Options:');
  console.log('  --title     글 제목 (필수)');
  console.log('  --content   HTML 본문 (필수, 파일 경로도 가능)');
  console.log('  --labels    라벨 (쉼표 구분)');
  process.exit(1);
}

async function main() {
  validateKnownFlags(['--title', '--content', '--labels']);

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

  // content가 '<'를 포함하지 않으면 인라인 HTML이 아니므로 파일 경로로 간주.
  // 존재하지 않으면 fail-fast — 경로 문자열을 본문으로 그대로 PUT하는 사고 방지.
  const fs = require('fs');
  if (!content.includes('<')) {
    if (!fs.existsSync(content)) {
      console.error(`Error: --content에 '<'가 없어 파일 경로로 해석했지만 "${content}"가 존재하지 않습니다. 인라인 HTML 또는 실제 파일 경로를 넘기세요.`);
      process.exit(1);
    }
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${err.message}`);
      process.exit(1);
    }
  }

  const labels = labelsArg ? labelsArg.split(',').map(l => l.trim()).filter(Boolean) : [];

  console.log('Verifying image URLs...');
  const { verifyImageUrls } = require('../lib/verify-images');
  const imageCheck = await verifyImageUrls(content);
  if (!imageCheck.ok) {
    console.error('Broken image URLs found:');
    for (const { url, status } of imageCheck.broken) {
      console.error(`  ${status}: ${url}`);
    }
    process.exit(1);
  }
  console.log(`All ${imageCheck.broken.length === 0 ? '' : 'remaining '}image URLs verified.`);

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
  console.error('Draft creation failed:', err.message);
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data));
  }
  process.exit(1);
});