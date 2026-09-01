const axios = require('axios');
const { parseHtml, findAll, getAttr } = require('./html-parse');

// 예전에는 /<img[^>]+src="([^"]+)"/ 정규식이었다. 큰따옴표만 매칭해서
// 작은따옴표 src를 쓰면 검증을 **조용히 건너뛰었다**. 이제 lint-draft가 쓰는
// 것과 같은 파서를 재사용해 따옴표 종류·여러 줄 속성·대문자 태그를 모두 처리한다.
function extractImageUrls(html) {
  const urls = new Set();
  const { root } = parseHtml(html);

  for (const img of findAll(root, 'img')) {
    const src = getAttr(img, 'src');
    if (src) urls.add(src);
  }

  for (const tag of ['img', 'source']) {
    for (const el of findAll(root, tag)) {
      const srcset = getAttr(el, 'srcset');
      if (!srcset) continue;
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url) urls.add(url);
      }
    }
  }

  return [...urls];
}

// 동시성 제한 병렬 실행. 결과 순서는 입력 순서를 보존한다.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function verifyImageUrls(html, { concurrency = 4 } = {}) {
  const urls = extractImageUrls(html);
  if (urls.length === 0) return { ok: true, broken: [] };

  const checked = await mapWithConcurrency(urls, concurrency, async (url) => {
    try {
      const res = await axios.head(url, { timeout: 10000 });
      return res.status !== 200 ? { url, status: res.status } : null;
    } catch (err) {
      return { url, status: err.response?.status || 0 };
    }
  });

  const broken = checked.filter(Boolean);
  return { ok: broken.length === 0, broken };
}

module.exports = { extractImageUrls, mapWithConcurrency, verifyImageUrls };
