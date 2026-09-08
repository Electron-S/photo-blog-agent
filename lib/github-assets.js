const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const sharp = require('sharp');
const {
  canonicalSlugError, hashPath, postDirName, slugify,
} = require('./asset-paths');
const { mapWithConcurrency } = require('./verify-images');
const {
  errCode, errFull, errResponseBody, errStatus,
} = require('./err-text');

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

// **gh의 실패 이유를 버리지 않는다.** 예전에는 `gh.status !== 0` 하나로 모든 실패를
// 같은 문장("Set GITHUB_TOKEN or run gh auth login")으로 뭉갰다. 실측한 두 경우가
// 구조적으로 다른데 진단이 동일했다:
//
//   gh 미설치      → status=null, error=ENOENT, stderr=null
//                    → 안내가 `gh auth login`인데 gh가 없어서 **따를 수 없는 안내**다
//   gh 미인증      → status=1, stderr="no oauth token found for github.com"
//                    → gh가 정확한 이유를 말해 주는데 그걸 버렸다
//
// stdout은 **절대 메시지에 싣지 않는다** — 성공 시 그 내용이 토큰이다.
function getGitHubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  const gh = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // spawn 자체가 실패한 경우 (status는 null이다 — status만 보면 미인증과 구별되지 않는다)
  if (gh.error) {
    const code = errCode(gh.error) || 'ERR';
    const notFound = code === 'ENOENT';
    throw new Error(
      `GitHub 토큰이 없고 gh CLI를 실행할 수 없습니다 (${code}: ${errFull(gh.error)}).\n`
      + (notFound
        ? '  + gh CLI가 설치되어 있지 않습니다 — GITHUB_TOKEN 환경변수를 쓰거나 gh를 설치하세요 '
          + '(https://cli.github.com). `gh auth login`은 gh가 있어야 실행됩니다.\n'
        : '  + gh 실행 자체가 실패했습니다. PATH·권한을 확인하세요.\n')
      + '  + 또는 .env에 GITHUB_TOKEN=<repo 쓰기 권한 토큰>을 설정하세요.',
    );
  }

  if (gh.status !== 0) {
    const why = String(gh.stderr || '').trim();
    throw new Error(
      `GitHub 토큰이 없고 \`gh auth token\`이 실패했습니다 (exit ${gh.status})`
      + `${why ? `: ${why}` : ' (gh가 이유를 말하지 않았습니다)'}\n`
      + '  + `gh auth login`으로 로그인하거나, .env에 GITHUB_TOKEN=<repo 쓰기 권한 토큰>을 설정하세요.',
    );
  }

  const token = String(gh.stdout || '').trim();
  if (!token) {
    throw new Error('`gh auth token`이 성공했으나 빈 토큰을 반환했습니다. `gh auth status`로 상태를 확인하세요.');
  }

  return token;
}

function getWatermarkText() {
  return process.env.WATERMARK_TEXT || 'electronian-review.blogspot.com';
}

// **설정 문제를 사진 문제로 오진하지 않는다.**
//
// 예전에는 WATERMARK_TEXT가 렌더 불가일 때 sharp가 인코딩 실패로 죽고, 그 실패가
// 3단계 catch의 fallback 경로로 흘렀다. 그 경로의 결과는:
//   .webp 입력 → 회전만 적용한 **원본 복사가 성공**한다. 워터마크·리사이즈·압축이
//                전부 빠진 원본이 공개 저장소에 push되고 exit 4로 끝난다.
//   .jpg 입력  → fallback 불가로 배치 전체가 exit 1.
// 어느 쪽이든 사용자에게 나가는 문구는 "원본 파일 점검 필요"인데 진짜 원인은
// .env 한 글자다 (실측 재현).
//
// escapeXml이 XML 불허 문자를 지우므로 렌더 자체는 이제 깨지지 않지만, 지운 결과가
// 비면 **보이지 않는 워터마크**가 찍힌다 — 이미지 보호가 목적인 기능이 조용히
// 무력화되는 것이라 그때는 fail-fast한다. fallback 경로에는 진짜 인코딩 실패만 남긴다.
function assertWatermarkTextUsable() {
  const raw = getWatermarkText();
  const rendered = String(raw).replace(XML_ILLEGAL_RE, '').trim();
  if (rendered) return rendered;
  const err = new Error(
    `WATERMARK_TEXT에 렌더 가능한 문자가 없습니다 (받음: ${JSON.stringify(raw)}). `
    + '워터마크가 보이지 않는 채로 이미지가 공개 저장소에 올라가는 것을 막기 위해 중단합니다.\n'
    + '  + .env의 WATERMARK_TEXT를 확인하세요 (비우면 기본값 electronian-review.blogspot.com이 쓰입니다).',
  );
  err.kind = 'config';
  throw err;
}

// SVG는 XML이다. 이스케이프하지 않으면 WATERMARK_TEXT에 & < > 가 한 글자만
// 들어가도 SVG 파싱이 깨지고 sharp가 "Input buffer has corrupt header"로 실패한다.
// 그 실패는 fallback 경로로 흘러 **전 이미지가 워터마크 없는·리사이즈 안 된 원본**으로
// 공개 저장소에 올라간다 — 로그는 "sharp 인코딩 실패, 원본 파일 점검 필요"라고 하는데
// 실제 원인은 .env 한 글자다. (실측 재현됨)
// XML 1.0이 **어떤 인코딩으로도 표현할 수 없는** 문자들. 엔티티로도 못 쓴다
// (`&#11;`도 불허다). 남겨 두면 libxml이 "PCDATA invalid Char value 11"로 죽는데,
// 그 실패가 sharp의 "Input buffer has corrupt header"로 감싸여 **사진 문제로 오진**된다.
const XML_ILLEGAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeXml(value) {
  return String(value)
    .replace(XML_ILLEGAL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function addWatermark(pipeline, width, height) {
  const text = escapeXml(getWatermarkText());
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
const DEFAULT_MAX_SIZE_KB = 150;
const DEFAULT_CONCURRENCY = 4;

// sharp 디코드/리사이즈(1단계) 또는 워터마크·인코딩(3단계) 실패의 최소 폴백.
// 치수 계약 위반(2단계)과 출력 쓰기 실패(4단계)는 여기로 오지 않는다 — 섞이면
// 원인이 "sharp 인코딩 실패"로 잘못 표기되어 사용자가 자기 사진을 의심하게 된다.
async function fallbackCopy(inputPath, outputPath, format, targetBytes, maxSizeKB, err) {
  const inputExt = path.extname(inputPath).toLowerCase();
  const outputExt = path.extname(outputPath).toLowerCase();

  // **출력은 항상 .webp**이므로 이 조건은 실질적으로 "입력도 .webp인가"다.
  // 즉 일반 카메라 사진(.jpg/.heic)의 sharp 실패는 `path: null`로 나가 호출자가
  // 던지고 **exit 1**(실패)이 된다 — 문서가 약속한 exit 4(품질 저하: fallback)는
  // WebP 입력에서만 발생한다. 일반 사진에서 도달 가능한 exit 4는 oversize와
  // 치수 결손뿐이다. (문서에 이 사실을 명시했다.)
  const canCopyOriginal =
    ['.jpg', '.jpeg', '.png', '.webp'].includes(inputExt) &&
    (inputExt === outputExt || (format === 'jpeg' && ['.jpg', '.jpeg'].includes(inputExt)));

  if (!canCopyOriginal) {
    console.warn(`[compressImage] sharp ${format} 인코딩 실패 + fallback 불가 (${inputExt} → ${outputExt}): ${inputPath} — ${errFull(err)}`);
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
      error: errFull(err),
    };
  }

  // Try minimal fallback: rotate only (no resize/watermark/compression) so EXIF orientation is honored.
  let orientationApplied = false;
  try {
    await sharp(inputPath).rotate().toFile(outputPath);
    orientationApplied = true;
    console.warn(`[compressImage] sharp ${format} 인코딩 실패 — 회전만 적용한 원본 복사 (워터마크/리사이즈/압축 없음): ${inputPath} — ${errFull(err)}`);
  } catch (rotateErr) {
    await fs.promises.copyFile(inputPath, outputPath);
    console.warn(`[compressImage] sharp ${format} + rotate 모두 실패 — 원본 바이트 그대로 복사 (워터마크/리사이즈/압축/회전 없음): ${inputPath} — encode: ${errFull(err)} / rotate: ${errFull(rotateErr)}`);
    // sharp가 두 번 다 실패했다 = **디코드 자체가 안 되는 파일**이다. 그것을
    // photo-NN.webp로 복사하면 verifyAssetUrl은 HTTP HEAD만 하므로(2xx면 통과)
    // **깨진 이미지가 살아 있는 URL로 배포된다.** workflow-steps.md가 exit 4를
    // "경고로만 기록하고 진행"이라고 지시하므로, 실질 방어선은 width/height=null
    // 하나뿐이다. 그 사실을 여기서 크게 알린다.
    console.warn('[compressImage]   ⚠ 이 파일은 sharp가 디코드하지 못했습니다 — 원본이 손상됐을 수 있습니다.');
    console.warn('[compressImage]   ⚠ 업로드하면 브라우저에서도 깨져 보일 수 있습니다. 치수가 null로 나오면 초안에서 제외하세요.');
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
    dimensionsError = errFull(metaErr);
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
    error: errFull(err),
  };
}


async function compressImage(inputPath, outputPath, format = 'webp', maxSizeKB = DEFAULT_MAX_SIZE_KB) {
  if (format !== 'webp' && format !== 'jpeg') {
    throw new Error(`compressImage: unsupported format '${format}'. Use 'webp' or 'jpeg'.`);
  }
  if (!Number.isFinite(maxSizeKB) || maxSizeKB <= 0 || maxSizeKB > MAX_SIZE_KB_LIMIT) {
    throw new Error(`compressImage: maxSizeKB must be a positive number ≤ ${MAX_SIZE_KB_LIMIT} (got ${maxSizeKB}).`);
  }

  // 워터마크 설정은 인코딩을 시작하기 **전에** 판정한다 (아래 fallback 경로가
  // 설정 문제를 사진 문제로 오진하지 않도록).
  assertWatermarkTextUsable();

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const targetBytes = maxSizeKB * 1024;
  const qualitySteps = format === 'webp' ? [80, 70, 60, 50] : [82, 72, 62, 52];

  // --- 1단계: sharp 디코드/리사이즈. 여기 실패만 fallback 대상이다. ---
  let resized;
  let resizedMeta;
  try {
    resized = await sharp(inputPath, { failOn: 'error' })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    resizedMeta = await sharp(resized).metadata();
  } catch (err) {
    return fallbackCopy(inputPath, outputPath, format, targetBytes, maxSizeKB, err);
  }

  // --- 2단계: 치수 계약 검증. 폴백 대상이 아니라 계약 위반이므로 catch 밖에서 던진다. ---
  // 예전에는 `|| 1600` / `|| 1200` 으로 폴백했는데, 그러면 워터마크 SVG를 실제와 다른
  // 캔버스 크기로 그려 엉뚱한 위치에 합성하고 그 거짓 치수가 <img width height>까지
  // 흘러가 CLS를 유발한다. 모르면 모른다고 실패한다.
  if (!Number.isInteger(resizedMeta.width) || !Number.isInteger(resizedMeta.height)
      || resizedMeta.width <= 0 || resizedMeta.height <= 0) {
    const err = new Error(
      `compressImage: 리사이즈 결과에서 치수를 읽지 못했습니다 (${inputPath}). `
      + `width=${JSON.stringify(resizedMeta.width)} height=${JSON.stringify(resizedMeta.height)}`,
    );
    // 폴백이 아니라 계약 위반임을 호출자가 문자열 매칭 없이 구분할 수 있게 표시한다.
    err.kind = 'contract';
    throw err;
  }

  const finalWidth = resizedMeta.width;
  const finalHeight = resizedMeta.height;

  // --- 3단계: 워터마크 합성 + 품질 탐색. 여기 실패도 sharp 실패이므로 fallback. ---
  let chosen;
  try {
    const watermarked = await addWatermark(sharp(resized), finalWidth, finalHeight);

    let best = null;
    for (const quality of qualitySteps) {
      const buf = format === 'webp'
        ? await watermarked.webp({ quality }).toBuffer()
        : await watermarked.jpeg({ quality, mozjpeg: true }).toBuffer();
      if (!best || buf.length < best.buf.length) best = { buf, quality };
      if (buf.length <= targetBytes) {
        chosen = { buf, quality, oversize: false };
        break;
      }
      console.warn(`[compressImage] ${path.basename(outputPath)}: ${(buf.length / 1024).toFixed(0)}KB at quality ${quality} (target: ${maxSizeKB}KB) — reducing quality`);
    }

    if (!chosen) {
      console.warn(`[compressImage] ${path.basename(outputPath)}: ${(best.buf.length / 1024).toFixed(0)}KB at quality ${best.quality} exceeds ${maxSizeKB}KB target — keeping smallest result`);
      chosen = { buf: best.buf, quality: best.quality, oversize: true };
    }
  } catch (err) {
    return fallbackCopy(inputPath, outputPath, format, targetBytes, maxSizeKB, err);
  }

  // --- 4단계: 출력 쓰기. try 밖이다. ---
  // 디스크가 꽉 찼거나(ENOSPC) 권한이 없는 것을 "sharp 인코딩 실패"로 재라벨링하면
  // 로그가 사용자 사진을 의심하게 만들고 진짜 원인은 아무도 조사하지 않는다.
  await fs.promises.writeFile(outputPath, chosen.buf);

  return {
    path: outputPath,
    oversize: chosen.oversize,
    fallbackUsed: false,
    watermarkApplied: true,
    orientationApplied: true,
    sizeBytes: chosen.buf.length,
    width: finalWidth,
    height: finalHeight,
    dimensionsError: null,
    quality: chosen.quality,
    error: null,
  };
}

async function verifyAssetUrl(url, maxRetries = 3, delayMs = 3000) {
  let lastReason = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await axios.head(url, { timeout: 10000 });
      if (res.status >= 200 && res.status < 300) return true;
      lastReason = `HTTP ${res.status}`;
    } catch (err) {
      lastReason = errStatus(err) !== null
        ? `HTTP ${errStatus(err)}`
        : `${errCode(err) || 'ERR'}: ${errFull(err)}`;
    }
    if (attempt < maxRetries) {
      console.warn(`[verifyAssetUrl] ${url} 검증 실패 (${attempt}/${maxRetries}): ${lastReason}, ${delayMs}ms 후 재시도`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.warn(`[verifyAssetUrl] ${url} 최종 실패: ${lastReason}. GitHub Pages 전파 지연 가능성이 있으므로 잠시 후 수동 확인 권장.`);
  return false;
}

// git의 blob object id. GitHub Contents API가 주는 `sha`와 같은 값이라,
// 원격에 이미 있는 내용과 올릴 내용이 **바이트 단위로 같은지**를 요청 없이 판정할 수 있다.
function gitBlobSha(buffer) {
  return crypto.createHash('sha1')
    .update(`blob ${buffer.length}\u0000`)
    .update(buffer)
    .digest('hex');
}

/**
 * 반환: { url, status } — status는 'created' | 'unchanged' | 'replaced'.
 *
 * **이미 있는 경로에 다른 내용을 쓰는 것은 "추가"가 아니다.**
 * 예전에는 기존 파일의 sha를 얻어 무조건 PUT하고, 커밋 메시지는 그대로
 * "Add blog asset", 요약은 ok, 경고는 0건이었다. 그런데 CLAUDE.md는 멱등성을 위해
 * **같은 slug를 유지하라**고 지시한다 — 그래서 사진을 하나 앞에 추가해 재실행하면
 * photo-01이 다른 사진이 되고, 이미 LIVE인 글의 이미지가 한 칸씩 밀려 **전부
 * 바뀐다**. photo-NN이 입력 argv 순서로 붙기 때문이다.
 * 여기서는 사실만 판정하고, 거부·경고는 정책을 아는 호출자가 한다.
 */
// 기본값은 **거부**다. 이 함수는 export되어 있고, 새 호출자가 옵션을 잊었을 때
// 조용히 교체되는 쪽으로 실패하면 안 된다 (uploadBlogImages가 `=== true`를
// 요구하는 것과 같은 방향 — 이 저장소의 다른 가드들과 일관되게).
async function uploadAsset(localPath, remotePath, { allowReplace = false } = {}) {
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
    if (errStatus(err) !== 404) {
      throw new Error(`GitHub 파일 확인 실패 (${remotePath}, branch ${branch}): ${errStatus(err)} ${errFull(err)}`);
    }
  }

  const publicUrl = `${baseUrl}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;

  // 내용이 같으면 PUT을 보내지 않는다 — 이것이 진짜 멱등이다 (같은 사진을 다시
  // 올려도 새 커밋이 쌓이지 않는다).
  if (sha && sha === gitBlobSha(content)) {
    return { url: publicUrl, status: 'unchanged' };
  }

  const status = sha ? 'replaced' : 'created';
  if (status === 'replaced' && !allowReplace) {
    const err = new Error(
      `이미 있는 경로에 다른 내용을 쓰려고 합니다: ${remotePath} (branch ${branch}).\n`
      + '  + 이 경로가 이미 발행된 글에 걸려 있으면 그 글의 이미지가 제자리에서 바뀝니다.\n'
      + '  + 사진을 추가/제거하고 같은 --slug로 재실행하면 photo-NN이 밀려 전부 어긋납니다.\n'
      + '  + 의도한 교체라면 --allow-replace를 붙이세요. 새 글이라면 --slug를 다르게 주세요.\n'
      // 거부는 **이미지 단위**다 — 같은 배치의 다른 사진(특히 새로 추가한 것)은
      // 이 판정 전에 이미 push됐을 수 있다. `--slug`만 바꾸면 그것들이 옛 폴더에
      // 고아로 남아 계속 공개된다. 무엇이 올라갔는지는 결과 JSON의 remotePath에 있다.
      + '  + 주의: 같은 배치의 다른 사진은 이미 업로드됐을 수 있습니다. 결과 JSON의\n'
      + '    images[].remotePath(uploadStatus가 created/replaced인 것)를 확인하고,\n'
      + '    --slug를 바꾸기 전에 옛 폴더에 남는 파일을 정리하세요.',
    );
    err.kind = 'replace';
    throw err;
  }

  try {
    await axios.put(url, {
      // 커밋 메시지가 사실과 달랐다 — 교체인데 "Add"라고 적혀 히스토리로도
      // 무엇이 바뀌었는지 알 수 없었다.
      message: `${status === 'replaced' ? 'Replace' : 'Add'} blog asset ${remotePath}`,
      content: content.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }, {
      headers,
    });
  } catch (err) {
    const detail = errResponseBody(err)?.message || errFull(err);
    throw new Error(`GitHub 업로드 실패 (${remotePath}, branch ${branch}): ${detail}`);
  }

  return { url: publicUrl, status };
}

async function uploadBlogImages(inputPaths, options = {}) {
  if (!options.date || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`uploadBlogImages: options.date is required as YYYY-MM-DD (got ${JSON.stringify(options.date)}). Pass primary_date from extract-exif.js or an explicit date — never default to today (breaks folder idempotency).`);
  }
  const date = options.date;
  // slug는 폴더 경로의 유일한 식별자다. 없거나 ASCII화로 붕괴하면 같은 날짜의
  // 모든 글이 같은 폴더를 써서 **이미 발행된 글의 이미지를 덮어쓴다.**
  // (options.title 폴백은 없앴다 — 아무도 넘기지 않는데 한국어 제목이면
  //  조용히 'post'로 붕괴해 정확히 이 사고를 만든다.)
  // 판정은 "붕괴 케이스 열거"가 아니라 **"slugify가 손대지 않는 값만 받는다"**다.
  // slugCollapsed만 보면 부분 붕괴(trip-경복궁 → trip-)가 통과해 서로 다른 글이
  // 같은 폴더로 수렴한다.
  const slugError = canonicalSlugError(options.slug);
  if (slugError) {
    throw new Error(
      `uploadBlogImages: options.slug ${slugError}\n`
      + '  + slug은 폴더 경로의 유일한 식별자입니다. 잘못되면 같은 날짜의 다른 글과 '
      + `같은 폴더(${postDirName(date, 'post')} 형태)를 공유해 이미 발행된 이미지를 덮어씁니다.`,
    );
  }
  const slug = options.slug;   // canonicalSlugError가 slugify(slug) === slug를 보장한다
  const postDir = postDirName(date, slug);
  const workDir = options.workDir || path.join(process.cwd(), 'tmp', 'assets', postDir);
  const rawMaxSize = options.maxSizeKB;
  const localOnly = options.localOnly === true;
  // compressImage는 같은 조건에 throw하는데 여기만 조용히 150으로 갈아끼우면,
  // 호출자가 지정한 값이 무시된 채 실행되고 로그의 "150KB 기준" 경고를 보며
  // 자기가 200을 줬다고 믿는다. 라이브러리 경계에서 묵음 값 교체는 금물이다.
  const maxSizeKB = rawMaxSize === undefined ? DEFAULT_MAX_SIZE_KB : rawMaxSize;
  if (!Number.isFinite(maxSizeKB) || maxSizeKB <= 0 || maxSizeKB > MAX_SIZE_KB_LIMIT) {
    throw new Error(
      `uploadBlogImages: options.maxSizeKB는 0 초과 ${MAX_SIZE_KB_LIMIT} 이하의 수여야 합니다 `
      + `(받음: ${JSON.stringify(rawMaxSize)}).`,
    );
  }
  // 압축·업로드·검증을 동시성 제한 병렬로 돌린다. 검증 실패 시 3초씩 sleep하는
  // 경로가 있어 순차 처리는 사진 10장에 수십 초가 걸렸다.
  // photo-NN 인덱스가 본문 이미지 순서와 대응하므로 결과 배열의 순서 보존이
  // 필수인데, mapWithConcurrency가 입력 순서대로 결과를 채운다.
  // 기본은 **거부**다. 이미 있는 경로에 다른 내용을 쓰는 것은 이미 발행된 글의
  // 이미지를 제자리에서 바꾸는 일이고, 되돌릴 수 없다. 내용이 같으면 애초에
  // 'unchanged'라 여기에 걸리지 않으므로, 정상적인 재실행(멱등)은 영향이 없다.
  const allowReplace = options.allowReplace === true;
  const concurrency = options.concurrency === undefined ? DEFAULT_CONCURRENCY : options.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `uploadBlogImages: options.concurrency는 1 이상의 정수여야 합니다 (받음: ${JSON.stringify(options.concurrency)}).`,
    );
  }

  const images = await mapWithConcurrency(inputPaths, concurrency, async (inputPath, i) => {
    const idx = String(i + 1).padStart(2, '0');
    const webpName = `photo-${idx}.webp`;
    const webpPath = path.join(workDir, webpName);

    try {
      const compressed = await compressImage(inputPath, webpPath, 'webp', maxSizeKB);
      if (!compressed.path) {
        // **`fallbackUsed`로 집계되지 않게 종류를 표시한다.** 메시지가
        // `compressImage`로 시작해서 아래 catch의 문자열 검사가 참이 됐고,
        // **폴백이 실행되지 않고 출력 파일도 없는** 이미지에 fallbackUsed가
        // 붙었다 (실측: 3장 중 1장만 실제 폴백인데 "2/3 fallback 경로"로 보고).
        const unsupported = new Error(
          `compressImage fallback unsupported (${path.extname(inputPath) || '확장자 없음'} → .webp): `
          + `${compressed.error}`,
        );
        unsupported.kind = 'fallback-unsupported';
        throw unsupported;
      }

      const originalStat = await fs.promises.stat(inputPath);

      // --local-only: 압축본만 만들고 GitHub 업로드/검증은 건너뛴다. 네이버 발행은
      // 외부 URL이 아니라 이 로컬 파일을 에디터에 직접 올리므로 GITHUB_TOKEN이 필요 없다.
      if (localOnly) {
        return {
          index: i + 1,
          originalPath: inputPath,
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
        };
      }

      const remotePath = `posts/${postDir}/${webpName}`;
      const uploaded = await uploadAsset(webpPath, remotePath, { allowReplace });
      let webpUrl = uploaded.url;
      let uploadStatus = uploaded.status;
      let verificationError = null;

      if (uploadStatus === 'replaced') {
        console.warn(`[uploadBlogImages] 교체: ${remotePath} — 이 경로가 이미 발행된 글에 걸려 있으면 `
          + '그 글의 이미지가 제자리에서 바뀝니다 (--allow-replace로 허용된 동작).');
      }

      const webpVerified = await verifyAssetUrl(webpUrl);
      if (!webpVerified) {
        console.warn(`[uploadBlogImages] WebP 업로드 확인 실패, 재시도: ${webpName}`);
        try {
          const retried = await uploadAsset(webpPath, remotePath, { allowReplace });
          webpUrl = retried.url;
          // **재시도 결과로 강등하지 않는다.** 재시도 시점에는 방금 PUT한 내용이
          // 이미 원격에 있으므로 uploadAsset이 'unchanged'를 돌려준다 — 그걸 그대로
          // 쓰면 **이미 LIVE인 글의 이미지를 실제로 교체한 실행이 기록상 "아무것도
          // 건드리지 않음"**이 된다 (실측: PUT은 'Replace'로 나갔는데 기록은
          // 'unchanged'). 재시도가 도는 조건은 GitHub Pages 전파 지연이라 예외가
          // 아니라 이 코드가 존재하는 이유다.
          // uploadStatus의 의미는 "이번 실행이 원격에 한 일"이므로 첫 판정을 남긴다.
          if (uploadStatus === 'unchanged') uploadStatus = retried.status;
          if (!(await verifyAssetUrl(webpUrl))) {
            console.warn(`[uploadBlogImages] WebP 재시도도 실패, WebP URL 제거: ${webpName}`);
            webpUrl = null;
            verificationError = 'verification failed after retries';
          }
        } catch (retryErr) {
          console.warn(`[uploadBlogImages] WebP 재업로드 실패, WebP URL 제거: ${webpName} - ${errFull(retryErr)}`);
          webpUrl = null;
          verificationError = `re-upload failed: ${errFull(retryErr)}`;
        }
      }

      return {
        index: i + 1,
        originalPath: inputPath,
        webpPath,
        webpUrl,
        url: webpUrl,
        // **공개된 사실은 검증 결과와 무관하게 남긴다.** 검증이 실패하면 webpUrl을
        // null로 지우는 것은 맞다 (초안이 못 쓰는 URL을 쓰면 안 된다). 하지만 예전에는
        // 그 지움과 함께 **바이트가 공개 저장소 어디에 올라갔는지도 사라졌다** —
        // stderr에만 남아서, 모델 간 핸드오프 정본인 tmp/upload-<slug>.json만 보면
        // 되돌릴 대상의 주소를 알 수 없었다.
        remotePath,
        uploadStatus,
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
      };
    } catch (err) {
      console.error(`[uploadBlogImages] 이미지 ${i + 1} (${inputPath}) 실패: ${errFull(err)}`);
      // **err.kind를 읽는다.** 예전에는 `message.startsWith('compressImage')`로
      // 분류해서, compressImage가 던지는 **계약 위반**("리사이즈 결과에서 치수를
      // 읽지 못했습니다")도 fallbackUsed로 집계됐다. 그러면 사용자는
      // "1/1 이미지가 fallback 경로 (워터마크 미적용 — 원본 파일 점검 필요)"를
      // 보는데, 폴백은 실행되지 않았고 파일도 없으며 원본은 아무 문제가 없다.
      // 계약 위반임을 표시하려고 err.kind를 붙여 놓고 아무도 읽지 않아 죽은 코드였다.
      const errKind = err && err.kind;
      const isContractError = errKind === 'contract';
      const isUnsupported = errKind === 'fallback-unsupported';
      // 문자열 검사가 아니라 **종류**로 판정한다. `err.kind`가 없을 때만 메시지에
      // 의존한다 (compressImage 안에서 던진 다른 오류).
      const isCompressionError = !isContractError && !isUnsupported
        && errFull(err).startsWith('compressImage');
      return {
        index: i + 1,
        originalPath: inputPath,
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
        compressionError: (isCompressionError || isContractError || isUnsupported)
          ? errFull(err) : null,
        contractError: isContractError ? errFull(err) : null,
        verificationError: null,
        error: errFull(err),
      };
    }
  });

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
    // 계약 위반(치수를 못 읽음)은 폴백과 조치가 다르다 — 원본 점검이 아니라
    // sharp/파이프라인 점검이다. 같은 칸에 넣으면 안내가 엉뚱해진다.
    contractViolation: images.filter((u) => u.contractError).length,
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
  if (summary.contractViolation > 0) {
    console.warn(`[uploadBlogImages] ${summary.contractViolation}/${summary.total} 이미지에서 파이프라인 계약 위반 (치수를 읽지 못함). 폴백이 아니라 sharp/파이프라인 문제이므로 원본 파일이 아니라 위 오류 메시지를 확인하세요.`);
  }
  if (summary.missingDimensions > 0) {
    console.warn(`[uploadBlogImages] ${summary.missingDimensions}/${summary.total} 이미지의 width/height를 확인하지 못했습니다. 초안의 <img>에 치수를 추측해 넣지 마세요 (CLS).`);
  }

  return { images, summary };
}

module.exports = {
  DEFAULT_CONCURRENCY,
  escapeXml,
  DEFAULT_MAX_SIZE_KB,
  MAX_SIZE_KB_LIMIT,
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