require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { uploadBlogImages } = require('../lib/github-assets');
const { errFull } = require('../lib/err-text');

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photo-blog-assets-'));
  const sample = path.join(tempDir, 'sample.png');

  await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 230, g: 240, b: 255 },
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
          <rect width="1200" height="800" fill="#e6f0ff"/>
          <text x="80" y="170" font-size="64" fill="#1f2937" font-family="Arial">Photo Blog Asset Test</text>
          <text x="80" y="270" font-size="38" fill="#475569" font-family="Arial">GitHub Pages upload check</text>
        </svg>
      `),
    }])
    .png()
    .toFile(sample);

  const { images, summary } = await uploadBlogImages([sample], {
    date: new Date().toISOString().slice(0, 10),
    slug: 'asset-upload-test',
  });

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

  await fs.promises.rm(tempDir, { recursive: true, force: true });

  if (summary.failed > 0) process.exit(1);
  if (summary.degraded > 0) process.exit(4);
}

main().catch((err) => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : errFull(err);
  console.error(details);
  process.exit(1);
});