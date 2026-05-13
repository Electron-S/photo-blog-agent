const axios = require('axios');

function extractImageUrls(html) {
  const urls = new Set();
  const srcRegex = /<img[^>]+src="([^"]+)"/gi;
  const srcsetRegex = /srcset="([^"]+)"/gi;

  let match;
  while ((match = srcRegex.exec(html)) !== null) {
    urls.add(match[1]);
  }
  while ((match = srcsetRegex.exec(html)) !== null) {
    for (const entry of match[1].split(',')) {
      const url = entry.trim().split(/\s+/)[0];
      if (url) urls.add(url);
    }
  }

  return [...urls];
}

async function verifyImageUrls(html) {
  const urls = extractImageUrls(html);
  if (urls.length === 0) return { ok: true, broken: [] };

  const broken = [];
  for (const url of urls) {
    try {
      const res = await axios.head(url, { timeout: 10000 });
      if (res.status !== 200) {
        broken.push({ url, status: res.status });
      }
    } catch (err) {
      const status = err.response?.status || 0;
      broken.push({ url, status });
    }
  }

  return { ok: broken.length === 0, broken };
}

module.exports = { extractImageUrls, verifyImageUrls };