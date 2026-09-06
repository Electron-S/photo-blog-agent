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
//
// 주의: `fn`은 던지지 않아야 한다. 던지면 Promise.all이 즉시 reject하는데, 나머지
// 워커는 계속 돌아 그 결과가 `results`에 채워지지 않은 채 버려지고 이미 시작된
// 요청은 그대로 진행된다. (나중의 rejection은 Promise.all이 흡수하므로 unhandled가
// 되지는 않는다.) 호출자가 fn 내부에서 오류를 잡아 결과 객체로 표현해야 한다.
async function mapWithConcurrency(items, limit, fn) {
  // limit<1이면 워커가 0개 생성되고 Promise.all([])가 즉시 resolve해서,
  // 콜백을 한 번도 부르지 않은 채 [null, null, ...]을 "성공"으로 반환한다.
  // 이 함수는 검증 유틸리티라 그 상태가 "전부 통과"로 읽힌다 — fail-fast한다.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(
      `mapWithConcurrency: limit은 1 이상의 정수여야 합니다 (받음: ${JSON.stringify(limit)}). `
      + '0 이하면 콜백이 한 번도 실행되지 않아 검증이 조용히 통과합니다.',
    );
  }
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
