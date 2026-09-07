require('dotenv').config();

const fs = require('fs');
const { createDraftPost } = require('../lib/blogger');
const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { lintDraftHtml, formatLintReport, validateUploadResult } = require('../lib/lint-draft');
const { verifyImageUrls } = require('../lib/verify-images');
const { errFull } = require('../lib/err-text');

function printUsage() {
  console.log('Usage: node create-draft.js --title "제목" --content "HTML 본문" [--labels "라벨1,라벨2"] [--upload-result <upload.json>]');
  console.log('');
  console.log('Options:');
  console.log('  --title          글 제목 (필수)');
  console.log('  --content        HTML 본문 (필수, 파일 경로도 가능)');
  console.log('  --labels         라벨 (쉼표 구분)');
  console.log('  --upload-result  upload-images.js --output 결과 JSON. img width/height를 실제 치수와 대조');
  console.log('');
  console.log('종료 코드: 0=성공, 1=일반 실패, 8=초안 lint 규칙 위반');
  process.exit(1);
}

async function main() {
  validateKnownFlags(['--title', '--content', '--labels', '--upload-result']);

  let title = getArg('--title');
  let content = getArg('--content');
  const labelsArg = getArg('--labels');
  const uploadResultPath = getArg('--upload-result');

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
  if (!content.includes('<')) {
    if (!fs.existsSync(content)) {
      console.error(`Error: --content에 '<'가 없어 파일 경로로 해석했지만 "${content}"가 존재하지 않습니다. 인라인 HTML 또는 실제 파일 경로를 넘기세요.`);
      process.exit(1);
    }
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${errFull(err)}`);
      process.exit(1);
    }
  }

  const labels = labelsArg ? labelsArg.split(',').map(l => l.trim()).filter(Boolean) : [];

  // lint를 URL 검증보다 먼저 돌린다. lint는 오프라인 수 ms지만 verifyImageUrls는
  // 이미지당 HTTP HEAD(최대 10초)라, 규칙 위반이면 네트워크를 쓰기 전에 죽는 게 맞다.
  let uploadResult;
  if (uploadResultPath) {
    try {
      uploadResult = JSON.parse(fs.readFileSync(uploadResultPath, 'utf8'));
    } catch (err) {
      console.error(`Error: --upload-result를 읽을 수 없음 (${uploadResultPath}): ${errFull(err)}`);
      process.exit(1);
    }
    const shape = validateUploadResult(uploadResult, `--upload-result "${uploadResultPath}"`);
    if (!shape.ok) {
      console.error(`Error: ${shape.error}`);
      process.exit(1);
    }
  }

  console.log('Linting draft HTML...');
  const lint = lintDraftHtml(content, { uploadResult });
  if (lint.warnings.length) {
    console.warn(formatLintReport(lint, { only: 'warn' }));
  }
  if (!lint.ok) {
    console.error(formatLintReport(lint, { only: 'error' }));
    console.error(`stats: ${JSON.stringify(lint.stats)}`);
    const err = new Error('초안 HTML 규칙 위반으로 Blogger 초안 생성을 중단합니다. 전체 findings는 `node scripts/lint-draft.js <파일> --format json`으로 확인하세요.');
    err.exitCode = 8;
    throw err;
  }
  if (lint.stats.dimensionCheck === 'skipped') {
    console.log('Draft lint passed. (--upload-result 미지정 — img 치수 대조는 건너뜀)');
  } else if (lint.stats.dimensionCheck !== 'ok') {
    console.log(`Draft lint passed. (치수 대조 커버리지 ${lint.stats.dimensionCheck})`);
  } else {
    console.log('Draft lint passed.');
  }

  console.log('Verifying image URLs...');
  const imageCheck = await verifyImageUrls(content);
  if (!imageCheck.ok) {
    console.error('Broken image URLs found:');
    for (const { url, status } of imageCheck.broken) {
      console.error(`  ${status}: ${url}`);
    }
    process.exit(1);
  }
  console.log('All image URLs verified.');

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
  console.error('Draft creation failed:', errFull(err));
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data));
  }
  // 의미별 exit 코드 전파 (8=lint 위반). publish-post.js의 failWithExit 패턴과 동일.
  process.exit(err.exitCode || 1);
});