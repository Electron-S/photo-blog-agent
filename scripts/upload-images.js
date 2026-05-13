require('dotenv').config();

const path = require('path');
const { uploadBlogImages } = require('../lib/github-assets');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node upload-images.js <image1> [image2] ... [--date YYYY-MM-DD] [--slug slug] [--work-dir dir]');
  console.log('');
  console.log('Options:');
  console.log('  --date       게시일 (기본값: 오늘, YYYY-MM-DD 형식)');
  console.log('  --slug       URL 슬러그 (기본값: 첫 번째 이미지 파일명에서 생성)');
  console.log('  --work-dir   압축 이미지 임시 디렉토리 (기본값: ./tmp/assets/<date>-<slug>)');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  const imagePaths = args.filter(a => !a.startsWith('--') && !getArg(a));
  const date = getArg('--date') || new Date().toISOString().slice(0, 10);
  const slug = getArg('--slug');
  const workDir = getArg('--work-dir');

  if (imagePaths.length === 0) {
    console.error('Error: at least one image path is required');
    printUsage();
  }

  // 파일 존재 확인
  const fs = require('fs');
  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) {
      console.error(`Error: file not found: ${imgPath}`);
      process.exit(1);
    }
  }

  const options = { date };
  if (slug) options.slug = slug;
  if (workDir) options.workDir = workDir;

  console.log(`Uploading ${imagePaths.length} image(s)...`);
  const result = await uploadBlogImages(imagePaths, options);

  console.log(JSON.stringify(result.map(item => ({
    index: item.index,
    originalPath: item.originalPath,
    remotePath: item.remotePath,
    url: item.url,
    originalBytes: item.originalBytes,
    compressedBytes: item.compressedBytes,
  })), null, 2));
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Upload failed:', details);
  process.exit(1);
});