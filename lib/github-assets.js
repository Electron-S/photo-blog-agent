const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const sharp = require('sharp');

const DEFAULT_OWNER = 'Electron-S';
const DEFAULT_REPO = 'photo-blog-assets';
const DEFAULT_BRANCH = 'main';
const DEFAULT_BASE_URL = 'https://electron-s.github.io/photo-blog-assets';

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || 'post';
}

function getAssetConfig() {
  return {
    owner: process.env.GITHUB_OWNER || DEFAULT_OWNER,
    repo: process.env.GITHUB_ASSET_REPO || DEFAULT_REPO,
    branch: process.env.GITHUB_ASSET_BRANCH || DEFAULT_BRANCH,
    baseUrl: (process.env.GITHUB_ASSET_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
  };
}

function getGitHubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  const gh = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (gh.status !== 0) {
    throw new Error('GitHub token is missing. Set GITHUB_TOKEN or run gh auth login.');
  }

  const token = gh.stdout.trim();
  if (!token) {
    throw new Error('gh auth token returned an empty token.');
  }

  return token;
}

function getWatermarkText() {
  return process.env.WATERMARK_TEXT || 'electronian-review.blogspot.com';
}

async function addWatermark(pipeline, width, height) {
  const text = getWatermarkText();
  const fontSize = Math.max(16, Math.round(width * 0.025));
  const svgText = `
<svg width="${width}" height="${height}">
  <style>
    @import url('data:font/ttf;base64,');
  </style>
  <text x="${width - 10}" y="${height - 10}"
        font-family="sans-serif" font-size="${fontSize}" font-weight="bold"
        fill="white" fill-opacity="0.35"
        text-anchor="end" dominant-baseline="auto"
        stroke="black" stroke-opacity="0.15" stroke-width="1">${text}</text>
</svg>`;
  return pipeline.composite([{
    input: Buffer.from(svgText),
    gravity: 'southeast',
  }]);
}

async function compressImage(inputPath, outputPath, format = 'webp') {
  if (format !== 'webp' && format !== 'jpeg') {
    throw new Error(`compressImage: unsupported format '${format}'. Use 'webp' or 'jpeg'.`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  let pipeline = sharp(inputPath, { failOn: 'error' })
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: 'inside',
      withoutEnlargement: true,
    });

  const metadata = await sharp(inputPath).metadata();
  const imgWidth = metadata.width || 1600;
  const imgHeight = metadata.height || 1200;

  // Apply watermark (after resize to match final dimensions)
  const resized = await pipeline.toBuffer();
  let watermarked = sharp(resized);
  const resizedMeta = await watermarked.metadata();
  const finalWidth = resizedMeta.width || imgWidth;
  const finalHeight = resizedMeta.height || imgHeight;
  watermarked = await addWatermark(sharp(resized), finalWidth, finalHeight);

  try {
    if (format === 'webp') {
      await watermarked.webp({ quality: 80 }).toFile(outputPath);
    } else {
      await watermarked.jpeg({ quality: 82, mozjpeg: true }).toFile(outputPath);
    }
  } catch (err) {
    const inputExt = path.extname(inputPath).toLowerCase();
    const outputExt = path.extname(outputPath).toLowerCase();

    // Don't silently copy if format doesn't match (e.g. JPEG -> .webp)
    if (inputExt !== outputExt && !(format === 'jpeg' && ['.jpg', '.jpeg'].includes(inputExt))) {
      throw new Error(
        `[compressImage] ${format} conversion failed for ${inputPath} — ` +
        `cannot copy original (${inputExt}) to mismatched output extension (${outputExt}): ${err.message}`
      );
    }

    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(inputExt)) throw err;
    console.warn(`[compressImage] sharp ${format} failed, copying original WITHOUT resize/compression/watermark: ${inputPath} — ${err.message}`);
    await fs.promises.copyFile(inputPath, outputPath);
    const fallbackStat = await fs.promises.stat(outputPath);
    if (fallbackStat.size > 150 * 1024) {
      console.warn(`[compressImage] Fallback file exceeds 150KB target: ${outputPath} (${(fallbackStat.size / 1024).toFixed(0)}KB)`);
    }
  }

  return outputPath;
}

async function verifyAssetUrl(url, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await axios.head(url, { timeout: 10000 });
      if (res.status === 200) return true;
    } catch { /* retry */ }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function uploadAsset(localPath, remotePath) {
  const { owner, repo, branch, baseUrl } = getAssetConfig();
  const token = getGitHubToken();
  const content = await fs.promises.readFile(localPath);
  const apiPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'photo-blog-agent',
  };
  let sha = null;

  try {
    const existing = await axios.get(url, {
      params: { ref: branch },
      headers,
    });
    sha = existing.data.sha || null;
  } catch (err) {
    if (err.response?.status !== 404) {
      throw new Error(`GitHub 파일 확인 실패 (${remotePath}, branch ${branch}): ${err.response?.status} ${err.message}`);
    }
  }

  try {
    await axios.put(url, {
      message: `Add blog asset ${remotePath}`,
      content: content.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }, {
      headers,
    });
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`GitHub 업로드 실패 (${remotePath}, branch ${branch}): ${detail}`);
  }

  return `${baseUrl}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
}

function hashPath(date, slug) {
  const crypto = require('crypto');
  const input = `${date}-${slug}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function uploadBlogImages(inputPaths, options = {}) {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const slug = slugify(options.slug || options.title || 'post');
  const pathHash = hashPath(date, slug);
  const postDir = `${date}-${pathHash}`;
  const workDir = options.workDir || path.join(process.cwd(), 'tmp', 'assets', postDir);
  const uploaded = [];

  for (let i = 0; i < inputPaths.length; i += 1) {
    const idx = String(i + 1).padStart(2, '0');
    const webpName = `photo-${idx}.webp`;
    const jpgName = `photo-${idx}.jpg`;
    const webpPath = path.join(workDir, webpName);
    const jpgPath = path.join(workDir, jpgName);

    try {
      // WebP (primary format)
      await compressImage(inputPaths[i], webpPath, 'webp');
      // JPEG (fallback)
      await compressImage(inputPaths[i], jpgPath, 'jpeg');

      let webpUrl = await uploadAsset(webpPath, `posts/${postDir}/${webpName}`);
      const jpgUrl = await uploadAsset(jpgPath, `posts/${postDir}/${jpgName}`);

      const originalStat = await fs.promises.stat(inputPaths[i]);
      const webpStat = await fs.promises.stat(webpPath);
      const jpgStat = await fs.promises.stat(jpgPath);

      const webpVerified = await verifyAssetUrl(webpUrl);
      if (!webpVerified) {
        console.warn(`[uploadBlogImages] WebP 업로드 확인 실패, 재시도: ${webpName}`);
        try {
          webpUrl = await uploadAsset(webpPath, `posts/${postDir}/${webpName}`);
          if (!(await verifyAssetUrl(webpUrl))) {
            console.warn(`[uploadBlogImages] WebP 재시도도 실패, WebP URL 제거: ${webpName}`);
            webpUrl = null;
          }
        } catch (retryErr) {
          console.warn(`[uploadBlogImages] WebP 재업로드 실패, WebP URL 제거: ${webpName} - ${retryErr.message}`);
          webpUrl = null;
        }
      }

      uploaded.push({
        index: i + 1,
        originalPath: inputPaths[i],
        webpPath,
        jpgPath,
        webpUrl,
        jpgUrl,
        originalBytes: originalStat.size,
        webpBytes: webpStat.size,
        jpgBytes: jpgStat.size,
        url: jpgUrl,
      });
    } catch (err) {
      console.error(`[uploadBlogImages] 이미지 ${i + 1} (${inputPaths[i]}) 실패: ${err.message}`);
      uploaded.push({
        index: i + 1,
        originalPath: inputPaths[i],
        webpPath: null,
        jpgPath: null,
        webpUrl: null,
        jpgUrl: null,
        url: null,
        originalBytes: null,
        webpBytes: null,
        jpgBytes: null,
        error: err.message,
      });
    }
  }

  const failed = uploaded.filter((u) => u.error);
  if (failed.length > 0) {
    console.warn(`[uploadBlogImages] ${failed.length}/${inputPaths.length} 이미지 업로드 실패`);
  }

  return uploaded;
}

module.exports = {
  addWatermark,
  compressImage,
  getAssetConfig,
  getWatermarkText,
  slugify,
  uploadAsset,
  uploadBlogImages,
  verifyAssetUrl,
};