require('dotenv').config();

const path = require('path');
const { uploadBlogImages } = require('../lib/github-assets');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node upload-images.js <image1> [image2] ... [--date YYYY-MM-DD] [--slug slug] [--work-dir dir] [--max-size-kb N]');
  console.log('');
  console.log('Options:');
  console.log('  --date          게시일 (기본값: 오늘, YYYY-MM-DD 형식)');
  console.log('  --slug          URL 슬러그 (기본값: 첫 번째 이미지 파일명에서 생성)');
  console.log('  --work-dir      압축 이미지 임시 디렉토리 (기본값: ./tmp/assets/<date>-<slug>)');
  console.log('  --max-size-kb   AdSense 이미지 크기 기준 KB (기본값: 150)');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

const FLAGS_WITH_VALUE = new Set(['--date', '--slug', '--work-dir', '--max-size-kb']);

function parseArgs() {
  const imagePaths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(`Error: ${a} requires a value`);
        printUsage();
      }
      i += 1;
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`Error: unknown option ${a}`);
      printUsage();
    }
    imagePaths.push(a);
  }
  return imagePaths;
}

function parseMaxSizeKB(raw) {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) {
    console.error(`Error: --max-size-kb must be a positive integer (1-10000), got "${raw}"`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const imagePaths = parseArgs();
  const date = getArg('--date') || new Date().toISOString().slice(0, 10);
  const slug = getArg('--slug');
  const workDir = getArg('--work-dir');
  const maxSizeKB = parseMaxSizeKB(getArg('--max-size-kb'));

  if (imagePaths.length === 0) {
    console.error('Error: at least one image path is required');
    printUsage();
  }

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
  if (maxSizeKB !== undefined) options.maxSizeKB = maxSizeKB;

  console.log(`Uploading ${imagePaths.length} image(s)...`);
  const { images, summary } = await uploadBlogImages(imagePaths, options);

  console.log(JSON.stringify({
    images: images.map((item) => ({
      index: item.index,
      originalPath: item.originalPath,
      webpUrl: item.webpUrl,
      url: item.url,
      originalBytes: item.originalBytes,
      webpBytes: item.webpBytes,
      ...(item.oversize ? { oversize: true } : {}),
      ...(item.fallbackUsed ? {
        fallbackUsed: true,
        watermarkApplied: false,
        orientationApplied: item.orientationApplied,
      } : {}),
      ...(item.compressionError ? { compressionError: item.compressionError } : {}),
      ...(item.verificationError ? { verificationError: item.verificationError } : {}),
      ...(item.error ? { error: item.error } : {}),
    })),
    summary,
  }, null, 2));

  if (summary.failed > 0) process.exit(1);
  if (summary.degraded > 0) process.exit(4);
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error('Upload failed:', details);
  process.exit(1);
});