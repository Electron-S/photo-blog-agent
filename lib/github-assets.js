const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const sharp = require('sharp');
const { slugify, hashPath, postDirName } = require('./asset-paths');

const DEFAULT_OWNER = 'Electron-S';
const DEFAULT_REPO = 'photo-blog-assets';
const DEFAULT_BRANCH = 'main';
const DEFAULT_BASE_URL = 'https://electron-s.github.io/photo-blog-assets';

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
    // 예전에는 `|| 1600` / `|| 1200` 으로 폴백했다. 그러면 치수를 못 읽었을 때
    // 워터마크 SVG를 실제와 다른 캔버스 크기로 그려서 엉뚱한 위치에 합성하고,
    // 그 거짓 치수가 <img width height>까지 흘러가 CLS를 유발한다 — 아무도
    // 눈치채지 못하는 silent failure다. 모르면 모른다고 실패한다.
    if (!Number.isInteger(resizedMeta.width) || !Number.isInteger(resizedMeta.height)
        || resizedMeta.width <= 0 || resizedMeta.height <= 0) {
      throw new Error(
        `compressImage: 리사이즈 결과에서 치수를 읽지 못했습니다 (${inputPath}). `
        + `width=${JSON.stringify(resizedMeta.width)} height=${JSON.stringify(resizedMeta.height)}`,
      );
    }
    const finalWidth = resizedMeta.width;
    const finalHeight = resizedMeta.height;
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
          width: finalWidth,
          height: finalHeight,
          dimensionsError: null,
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
      width: finalWidth,
      height: finalHeight,
      dimensionsError: null,
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
        width: null,
        height: null,
        dimensionsError: 'fallback 불가 — 출력 파일이 생성되지 않음',
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

    // 치수는 반드시 outputPath에서 읽는다. rotate-only 경로는 .rotate()로 EXIF
    // orientation을 적용해 저장하므로, 세로 사진은 inputPath의 metadata가 출력과
    // 뒤바뀌어 있다 (768x1024를 1024x768로 적어 정확히 CLS를 유발한다).
    let fallbackWidth = null;
    let fallbackHeight = null;
    let dimensionsError = null;
    try {
      const outMeta = await sharp(outputPath).metadata();
      if (Number.isInteger(outMeta.width) && Number.isInteger(outMeta.height)
          && outMeta.width > 0 && outMeta.height > 0) {
        fallbackWidth = outMeta.width;
        fallbackHeight = outMeta.height;
      } else {
        dimensionsError = 'sharp metadata에 유효한 width/height 없음';
      }
    } catch (metaErr) {
      dimensionsError = metaErr.message;
    }
    if (dimensionsError) {
      console.warn(`[compressImage] fallback 파일 치수 확인 실패: ${outputPath} — ${dimensionsError}. width/height=null로 전파합니다 (추측으로 채우면 CLS 사고).`);
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
      width: fallbackWidth,
      height: fallbackHeight,
      dimensionsError,
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

async function uploadBlogImages(inputPaths, options = {}) {
  if (!options.date || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`uploadBlogImages: options.date is required as YYYY-MM-DD (got ${JSON.stringify(options.date)}). Pass primary_date from extract-exif.js or an explicit date — never default to today (breaks folder idempotency).`);
  }
  const date = options.date;
  const slug = slugify(options.slug || options.title || 'post');
  const postDir = postDirName(date, slug);
  const workDir = options.workDir || path.join(process.cwd(), 'tmp', 'assets', postDir);
  const rawMaxSize = options.maxSizeKB;
  const localOnly = options.localOnly === true;
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

      const originalStat = await fs.promises.stat(inputPaths[i]);

      // --local-only: 압축본만 만들고 GitHub 업로드/검증은 건너뛴다. 네이버 발행은
      // 외부 URL이 아니라 이 로컬 파일을 에디터에 직접 올리므로 GITHUB_TOKEN이 필요 없다.
      if (localOnly) {
        images.push({
          index: i + 1,
          originalPath: inputPaths[i],
          webpPath,
          webpUrl: null,
          url: null,
          originalBytes: originalStat.size,
          webpBytes: compressed.sizeBytes,
          width: compressed.width ?? null,
          height: compressed.height ?? null,
          dimensionsError: compressed.dimensionsError || null,
          oversize: compressed.oversize,
          fallbackUsed: compressed.fallbackUsed,
          watermarkApplied: compressed.watermarkApplied,
          orientationApplied: compressed.orientationApplied,
          compressionError: compressed.error || null,
          verificationError: null,
          error: null,
        });
        continue;
      }

      let webpUrl = await uploadAsset(webpPath, `posts/${postDir}/${webpName}`);
      let verificationError = null;

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
        width: compressed.width ?? null,
        height: compressed.height ?? null,
        dimensionsError: compressed.dimensionsError || null,
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
        width: null,
        height: null,
        dimensionsError: '이미지 처리 실패 — 치수 미상',
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
  //   ok       — webpUrl 존재 + error 없음 + 워터마크/리사이즈/압축 + 치수 모두 정상
  //   failed   — webpUrl=null (압축 실패, 업로드 실패, 또는 검증 실패)
  //   oversize — AdSense 기준 초과 (게시는 되지만 정책 위반 가능)
  //   fallback — sharp 인코딩 실패로 워터마크/리사이즈 미적용 (이미지 보호 정책 위반)
  //   missingDimensions — URL은 살아 있는데 width/height를 모름. <img width height>
  //                       규칙을 만족시킬 수 없어 초안이 치수를 추측하게 된다 (CLS).
  //   degraded — webpUrl은 있지만 fallback/oversize/치수결손으로 품질 손상 (점검 필요)
  const hasDimensions = (u) => Number.isInteger(u.width) && Number.isInteger(u.height);
  // local-only 모드에서는 webpUrl=null이 정상이므로 "산출물이 있다"의 기준을
  // webpPath로 바꾼다. 그러지 않으면 정상 실행이 전부 failed로 집계된다.
  const delivered = (u) => (localOnly ? Boolean(u.webpPath) : Boolean(u.webpUrl));
  const summary = {
    total: inputPaths.length,
    mode: localOnly ? 'local-only' : 'github-pages',
    ok: images.filter((u) => delivered(u) && !u.error && !u.fallbackUsed && !u.oversize && hasDimensions(u)).length,
    failed: images.filter((u) => u.error).length,
    oversize: images.filter((u) => u.oversize).length,
    fallback: images.filter((u) => u.fallbackUsed).length,
    missingDimensions: images.filter((u) => delivered(u) && !u.error && !hasDimensions(u)).length,
    degraded: images.filter((u) => delivered(u) && !u.error
      && (u.fallbackUsed || u.oversize || !hasDimensions(u))).length,
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
  if (summary.missingDimensions > 0) {
    console.warn(`[uploadBlogImages] ${summary.missingDimensions}/${summary.total} 이미지의 width/height를 확인하지 못했습니다. 초안의 <img>에 치수를 추측해 넣지 마세요 (CLS).`);
  }

  return { images, summary };
}

module.exports = {
  addWatermark,
  compressImage,
  getAssetConfig,
  getWatermarkText,
  hashPath,
  postDirName,
  slugify,
  uploadAsset,
  uploadBlogImages,
  verifyAssetUrl,
};