require('dotenv').config();

const fs = require('fs');
const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { launchBrowser, createAuthenticatedContext, createDraftPost } = require('../lib/naver-blog');

function printUsage() {
  console.log('Usage: node naver-create-draft.js --title "제목" --content "HTML 본문 또는 파일" [--blocks JSON] [--images JSON] [--category "카테고리"] [--tags "태그1,태그2"]');
  console.log('');
  console.log('Options:');
  console.log('  --title      글 제목 (필수)');
  console.log('  --content    HTML 본문 또는 파일 경로 (필수)');
  console.log('  --blocks     블록 배열 JSON (선택, 기본: HTML을 1개 문단으로)');
  console.log('  --images     이미지 경로 배열 JSON (선택)');
  console.log('  --category   네이버 카테고리 (선택)');
  console.log('  --tags       태그 쉼표 구분 (선택)');
  process.exit(1);
}

async function main() {
  validateKnownFlags(['--title', '--content', '--blocks', '--images', '--category', '--tags']);

  const title = getArg('--title');
  let content = getArg('--content');
  const blocksArg = getArg('--blocks');
  const imagesArg = getArg('--images');
  const category = getArg('--category');
  const tagsArg = getArg('--tags');

  if (!title) {
    console.error('Error: --title is required');
    printUsage();
  }

  if (!content) {
    console.error('Error: --content is required');
    printUsage();
  }

  // content가 파일 경로인 경우 읽기
  if (!content.includes('<')) {
    if (!fs.existsSync(content)) {
      console.error(`Error: --content에 '<'가 없어 파일 경로로 해석했지만 "${content}"가 존재하지 않습니다.`);
      process.exit(1);
    }
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${err.message}`);
      process.exit(1);
    }
  }

  // 블록 파싱 (기본: 전체 HTML을 1개 문단으로)
  let blocks = [];
  if (blocksArg) {
    try {
      blocks = JSON.parse(blocksArg);
    } catch (err) {
      console.error(`Error parsing --blocks JSON: ${err.message}`);
      process.exit(1);
    }
  } else {
    blocks = [{ type: 'paragraph', text: content }];
  }

  // 이미지 배열 파싱
  let images = [];
  if (imagesArg) {
    try {
      images = JSON.parse(imagesArg);
    } catch (err) {
      console.error(`Error parsing --images JSON: ${err.message}`);
      process.exit(1);
    }
  }

  // 태그 파싱
  const tags = tagsArg ? tagsArg.split(',').map(t => t.trim()).filter(Boolean) : [];

  console.log('네이버 블로그에 초안을 생성 중...');
  const browser = await launchBrowser();

  try {
    const context = await createAuthenticatedContext(browser);
    const result = await createDraftPost(context, {
      title,
      blocks,
      images,
      category,
      tags,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Draft creation failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(err.exitCode || 1);
});
