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

const MAX_SIZE_KB_LIMIT = 10000;

async function compressImage(inputPath, outputPath, format = 'webp', maxSizeKB = 150) {
  if (format !== 'webp' && format !== 'jpeg') {
    throw new Error(`compressImage: unsupported format '${format}'. Use 'webp' or 'jpeg'.`);
  }
  if (!Number.isFinite(maxSizeKB) || maxSizeKB <= 0 || maxSizeKB > MAX_SIZE_KB_LIMIT) {
    throw new Error(`compressImage: maxSizeKB must be a positive number ≤ ${MAX_SIZE_KB_LIMIT} (got ${maxSizeKB}).`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const targetBytes = maxSizeKB * 1024;
  const qualitySteps = format === 'webp'
    ? [80, 70, 60, 50]
    : [82, 72, 62, 52];

  try {
    const resized = await sharp(inputPath, { failOn: 'error' })
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();

    const resizedMeta = await sharp(resized).metadata();
    const finalWidth = resizedMeta.width || 1600;
    const finalHeight = resizedMeta.height || 1200;
    const watermarked = await addWatermark(sharp(resized), finalWidth, finalHeight);

    let best = null;
    for (const quality of qualitySteps) {
      const buf = format === 'webp'
        ? await watermarked.webp({ quality }).toBuffer()
        : await watermarked.jpeg({ quality, mozjpeg: true }).toBuffer();
      if (!best || buf.length < best.buf.length) {
        best = { buf, quality };
      }
      if (buf.length <= targetBytes) {
        await fs.promises.writeFile(outputPath, buf);
        return {
          path: outputPath,
          oversize: false,
          fallbackUsed: false,
          watermarkApplied: true,
          orientationApplied: true,
          sizeBytes: buf.length,
          quality,
          error: null,
        };
      }
      console.warn(`[compressImage] ${path.basename(outputPath)}: ${(buf.length / 1024).toFixed(0)}KB at quality ${quality} (target: ${maxSizeKB}KB) — reducing quality`);
    }

    await fs.promises.writeFile(outputPath, best.buf);
    console.warn(`[compressImage] ${path.basename(outputPath)}: ${(best.buf.length / 1024).toFixed(0)}KB at quality ${best.quality} exceeds ${maxSizeKB}KB target — keeping smallest result`);
    return {
      path: outputPath,
      oversize: true,
      fallbackUsed: false,
      watermarkApplied: true,
      orientationApplied: true,
      sizeBytes: best.buf.length,
      quality: best.quality,
      error: null,
    };
  } catch (err) {
    const inputExt = path.extname(inputPath).toLowerCase();
    const outputExt = path.extname(outputPath).toLowerCase();

    const canCopyOriginal =
      ['.jpg', '.jpeg', '.png', '.webp'].includes(inputExt) &&
      (inputExt === outputExt || (format === 'jpeg' && ['.jpg', '.jpeg'].includes(inputExt)));

    if (!canCopyOriginal) {
      console.warn(`[compressImage] sharp ${format} 인코딩 실패 + fallback 불가 (${inputExt} → ${outputExt}): ${inputPath} — ${err.message}`);
      return {
        path: null,
        oversize: false,
        fallbackUsed: true,
        watermarkApplied: false,
        orientationApplied: false,
        sizeBytes: 0,
        quality: null,
        error: err.message,
      };
    }

    // Try minimal fallback: rotate only (no resize/watermark/compression) so EXIF orientation is honored.
    let orientationApplied = false;
    try {
      await sharp(inputPath).rotate().toFile(outputPath);
      orientationApplied = true;
      console.warn(`[compressImage] sharp ${format} 인코딩 실패 — 회전만 적용한 원본 복사 (워터마크/리사이즈/압축 없음): ${inputPath} — ${err.message}`);
    } catch (rotateErr) {
      await fs.promises.copyFile(inputPath, outputPath);
      console.warn(`[compressImage] sharp ${format} + rotate 모두 실패 — 원본 바이트 그대로 복사 (워터마크/리사이즈/압축/회전 없음): ${inputPath} — encode: ${err.message} / rotate: ${rotateErr.message}`);
    }

    const fallbackStat = await fs.promises.stat(outputPath);
    const oversize = fallbackStat.size > targetBytes;
    if (oversize) {
      console.warn(`[compressImage] Fallback 파일이 ${maxSizeKB}KB 초과: ${outputPath} (${(fallbackStat.size / 1024).toFixed(0)}KB)`);
    }
    return {
      path: outputPath,
      oversize,
      fallbackUsed: true,
      watermarkApplied: false,
      orientationApplied,
      sizeBytes: fallbackStat.size,
      quality: null,
      error: err.message,
    };
  }
}

async function verifyAssetUrl(url, maxRetries = 3, delayMs = 3000) {
  let lastReason = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await axios.head(url, { timeout: 10000 });
      if (res.status >= 200 && res.status < 300) return true;
      lastReason = `HTTP ${res.status}`;
    } catch (err) {
      lastReason = err.response?.status
        ? `HTTP ${err.response.status}`
        : `${err.code || 'ERR'}: ${err.message}`;
    }
    if (attempt < maxRetries) {
      console.warn(`[verifyAssetUrl] ${url} 검증 실패 (${attempt}/${maxRetries}): ${lastReason}, ${delayMs}ms 후 재시도`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.warn(`[verifyAssetUrl] ${url} 최종 실패: ${lastReason}. GitHub Pages 전파 지연 가능성이 있으므로 잠시 후 수동 확인 권장.`);
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
  const rawMaxSize = options.maxSizeKB;
  const maxSizeKB = (typeof rawMaxSize === 'number'
    && Number.isFinite(rawMaxSize)
    && rawMaxSize > 0
    && rawMaxSize <= MAX_SIZE_KB_LIMIT)
    ? rawMaxSize
    : 150;
  const images = [];

  for (let i = 0; i < inputPaths.length; i += 1) {
    const idx = String(i + 1).padStart(2, '0');
    const webpName = `photo-${idx}.webp`;
    const webpPath = path.join(workDir, webpName);

    try {
      const compressed = await compressImage(inputPaths[i], webpPath, 'webp', maxSizeKB);
      if (!compressed.path) {
        throw new Error(`compressImage fallback unsupported: ${compressed.error}`);
      }

      let webpUrl = await uploadAsset(webpPath, `posts/${postDir}/${webpName}`);
      let verificationError = null;

      const originalStat = await fs.promises.stat(inputPaths[i]);

      const webpVerified = await verifyAssetUrl(webpUrl);
      if (!webpVerified) {
        console.warn(`[uploadBlogImages] WebP 업로드 확인 실패, 재시도: ${webpName}`);
        try {
          webpUrl = await uploadAsset(webpPath, `posts/${postDir}/${webpName}`);
          if (!(await verifyAssetUrl(webpUrl))) {
            console.warn(`[uploadBlogImages] WebP 재시도도 실패, WebP URL 제거: ${webpName}`);
            webpUrl = null;
            verificationError = 'verification failed after retries';
          }
        } catch (retryErr) {
          console.warn(`[uploadBlogImages] WebP 재업로드 실패, WebP URL 제거: ${webpName} - ${retryErr.message}`);
          webpUrl = null;
          verificationError = `re-upload failed: ${retryErr.message}`;
        }
      }

      images.push({
        index: i + 1,
        originalPath: inputPaths[i],
        webpPath,
        webpUrl,
        url: webpUrl,
        originalBytes: originalStat.size,
        webpBytes: compressed.sizeBytes,
        oversize: compressed.oversize,
        fallbackUsed: compressed.fallbackUsed,
        watermarkApplied: compressed.watermarkApplied,
        orientationApplied: compressed.orientationApplied,
        compressionError: compressed.error || null,
        verificationError,
        error: verificationError,
      });
    } catch (err) {
      console.error(`[uploadBlogImages] 이미지 ${i + 1} (${inputPaths[i]}) 실패: ${err.message}`);
      const isCompressionError = typeof err.message === 'string'
        && err.message.startsWith('compressImage');
      images.push({
        index: i + 1,
        originalPath: inputPaths[i],
        webpPath: null,
        webpUrl: null,
        url: null,
        originalBytes: null,
        webpBytes: null,
        oversize: false,
        fallbackUsed: isCompressionError,
        watermarkApplied: false,
        orientationApplied: false,
        compressionError: isCompressionError ? err.message : null,
        verificationError: null,
        error: err.message,
      });
    }
  }

  // 카운트 의미:
  //   ok       — webpUrl 존재 + error 없음 + 워터마크/리사이즈/압축 모두 정상 적용
  //   failed   — webpUrl=null (압축 실패, 업로드 실패, 또는 검증 실패)
  //   oversize — AdSense 기준 초과 (게시는 되지만 정책 위반 가능)
  //   fallback — sharp 인코딩 실패로 워터마크/리사이즈 미적용 (이미지 보호 정책 위반)
  //   degraded — webpUrl은 있지만 fallback/oversize로 품질 손상 (사용자 점검 필요)
  const summary = {
    total: inputPaths.length,
    ok: images.filter((u) => u.webpUrl && !u.error && !u.fallbackUsed && !u.oversize).length,
    failed: images.filter((u) => u.error).length,
    oversize: images.filter((u) => u.oversize).length,
    fallback: images.filter((u) => u.fallbackUsed).length,
    degraded: images.filter((u) => u.webpUrl && !u.error && (u.fallbackUsed || u.oversize)).length,
  };
  if (summary.failed > 0) {
    console.warn(`[uploadBlogImages] ${summary.failed}/${summary.total} 이미지 처리/업로드/검증 실패`);
  }
  if (summary.oversize > 0) {
    console.warn(`[uploadBlogImages] ${summary.oversize}/${summary.total} 이미지가 ${maxSizeKB}KB 기준 초과 (AdSense 정책 확인 필요)`);
  }
  if (summary.fallback > 0) {
    console.warn(`[uploadBlogImages] ${summary.fallback}/${summary.total} 이미지가 fallback 경로 (워터마크 미적용 — 원본 파일 점검 필요)`);
  }

  return { images, summary };
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