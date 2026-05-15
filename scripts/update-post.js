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
  if (idx === -1) return null;
  if (idx + 1 >= args.length) {
    console.error(`Error: ${name}에 값이 필요합니다.`);
    process.exit(1);
  }
  // 다음 토큰이 `--`로 시작하면 값 누락 — silent하게 다음 플래그를 값으로 채택하면 사고가 난다.
  const val = args[idx + 1];
  if (val.startsWith('--')) {
    console.error(`Error: ${name}의 값으로 또 다른 플래그 "${val}"가 들어왔습니다. 값을 명시하세요.`);
    process.exit(1);
  }
  return val;
}

// 알 수 없는 플래그(typo)나 중복 지정을 silent하게 흘리지 않도록 시작 시 한 번 검증.
function validateKnownFlags(known) {
  const seen = new Set();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    if (!known.includes(arg)) {
      console.error(`Error: 알 수 없는 플래그 "${arg}". 사용 가능: ${known.join(', ')}`);
      process.exit(1);
    }
    if (seen.has(arg)) {
      console.error(`Error: 플래그 "${arg}"가 중복 지정되었습니다.`);
      process.exit(1);
    }
    seen.add(arg);
  }
}

async function main() {
  validateKnownFlags(['--post-id', '--title', '--content', '--labels']);

  const postId = getArg('--post-id');
  const title = getArg('--title');
  let content = getArg('--content');
  const labelsArg = getArg('--labels');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
  }

  // content가 '<'를 포함하지 않으면 인라인 HTML이 아니므로 파일 경로로 간주.
  // 존재하지 않으면 fail-fast — 경로 문자열을 본문으로 그대로 PUT하는 사고 방지.
  if (content && !content.includes('<')) {
    const fs = require('fs');
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

  const updateData = {};
  if (title) updateData.title = title;
  if (content) updateData.content = content;
  if (labelsArg) updateData.labels = labelsArg.split(',').map(l => l.trim()).filter(Boolean);

  if (Object.keys(updateData).length === 0) {
    console.error('Error: at least one of --title, --content, or --labels is required');
    printUsage();
  }

  if (content) {
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
  console.error('Post update failed:', err.message);
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data));
  }
  process.exit(1);
});