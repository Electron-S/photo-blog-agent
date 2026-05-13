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

async function compressImage(inputPath, outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  try {
    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 82,
        mozjpeg: true,
      })
      .toFile(outputPath);
  } catch (err) {
    const ext = path.extname(inputPath).toLowerCase();
    if (!['.jpg', '.jpeg'].includes(ext)) throw err;
    console.warn(`[compressImage] sharp 처리 실패, 원본 복사: ${inputPath} — ${err.message}`);
    await fs.promises.copyFile(inputPath, outputPath);
  }

  return outputPath;
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
  const date = options.date || new Date().toISOString().slice(0, 10);
  const slug = slugify(options.slug || options.title || 'post');
  const postDir = `${date}-${slug}`;
  const workDir = options.workDir || path.join(process.cwd(), 'tmp', 'assets', postDir);
  const uploaded = [];

  for (let i = 0; i < inputPaths.length; i += 1) {
    const outputName = `photo-${String(i + 1).padStart(2, '0')}.jpg`;
    const outputPath = path.join(workDir, outputName);
    const remotePath = `posts/${postDir}/${outputName}`;

    try {
      await compressImage(inputPaths[i], outputPath);
      const publicUrl = await uploadAsset(outputPath, remotePath);
      const originalStat = await fs.promises.stat(inputPaths[i]);
      const compressedStat = await fs.promises.stat(outputPath);

      uploaded.push({
        index: i + 1,
        originalPath: inputPaths[i],
        compressedPath: outputPath,
        remotePath,
        url: publicUrl,
        originalBytes: originalStat.size,
        compressedBytes: compressedStat.size,
      });
    } catch (err) {
      console.error(`[uploadBlogImages] 이미지 ${i + 1} (${inputPaths[i]}) 실패: ${err.message}`);
      uploaded.push({
        index: i + 1,
        originalPath: inputPaths[i],
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
  compressImage,
  getAssetConfig,
  slugify,
  uploadAsset,
  uploadBlogImages,
};