require('dotenv').config();

const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { launchBrowser, createAuthenticatedContext, publishPost } = require('../lib/naver-blog');

function printUsage() {
  console.log('Usage: node naver-publish-post.js [--draft]');
  console.log('');
  console.log('Options:');
  console.log('  --draft   발행 대신 임시저장 (기본: 발행)');
  console.log('');
  console.log('참고: 이 스크립트는 현재 에디터 상태를 발행합니다.');
  console.log('네이버 블로그 에디터에서 직접 글을 작성한 후 실행하세요.');
  process.exit(1);
}

async function main() {
  validateKnownFlags(['--draft']);

  const isDraft = process.argv.includes('--draft');

  console.log(`네이버 블로그 글을 ${isDraft ? '임시저장' : '발행'} 중...`);

  const browser = await launchBrowser();

  try {
    const context = await createAuthenticatedContext(browser);
    const result = await publishPost(context, { isDraft });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Publish failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(err.exitCode || 1);
});
