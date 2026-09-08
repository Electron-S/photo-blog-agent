const axios = require('axios');
const { parseHtml, findAll, getAttr } = require('./html-parse');
const { decodeEntities } = require('./korean-text');
const { errStatus, errText } = require('./err-text');

// 예전에는 /<img[^>]+src="([^"]+)"/ 정규식이었다. 큰따옴표만 매칭해서
// 작은따옴표 src를 쓰면 검증을 **조용히 건너뛰었다**. 이제 lint-draft가 쓰는
// 것과 같은 파서를 재사용해 따옴표 종류·여러 줄 속성·대문자 태그를 모두 처리한다.
function extractImageUrls(html) {
  const urls = new Set();
  const { root } = parseHtml(html);
  // **브라우저가 실제로 요청하는 URL**을 검증해야 한다. 파서는 속성을 원문으로
  // 주므로 `src="a&amp;b.webp"`는 `a&amp;b.webp`인데 브라우저는 `a&b.webp`를
  // 요청한다. 원문을 HEAD하면 살아 있는 이미지를 깨진 것으로, 혹은 그 반대로 본다.
  // lib/lint-draft.js의 ctx.attr와 같은 이유·같은 처리다.
  const attr = (el, name) => {
    const raw = getAttr(el, name);
    return raw === undefined ? undefined : decodeEntities(raw);
  };

  for (const img of findAll(root, 'img')) {
    const src = attr(img, 'src');
    if (src) urls.add(src);
  }

  for (const tag of ['img', 'source']) {
    for (const el of findAll(root, tag)) {
      const srcset = attr(el, 'srcset');
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
// `fn`은 던지지 않는 것이 계약이지만, **계약을 주석으로만 두지 않는다.** 예전에는
// fn이 던지면 Promise.all이 즉시 reject하고 이미 끝난 결과가 통째로 사라졌다.
// 업로드 경로에서 그건 "공개 저장소에는 이미 이미지가 push됐는데 어느 것이
// 올라갔는지 아무 기록이 없다"를 뜻한다 (tmp/upload-<slug>.json은 쓰이지 않는다).
// 그래서 예외를 그 자리에서 잡아 두고 **나머지를 끝까지 돌린 뒤**, 완료된 결과를
// 실은 오류를 던진다. 호출자는 err.partialResults로 무엇이 끝났는지 볼 수 있다.
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
  const failures = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // 여기서 다시 던지면 남은 결과가 버려진다. 기록하고 계속 돈다.
        failures.push({ index: i, item: items[i], error: err });
      }
    }
  });
  await Promise.all(workers);
  if (failures.length) {
    const err = new Error(
      `mapWithConcurrency: 콜백이 ${failures.length}/${items.length}건에서 예외를 던졌습니다 `
      + '(콜백은 오류를 결과 객체로 표현해야 합니다).\n'
      + failures.map((f) => `  + [${f.index}] ${errText(f.error)}`).join('\n'),
    );
    // 완료된 결과를 실어 보낸다 — 이미 외부에 반영된 작업을 호출자가 알 수 있어야 한다.
    err.partialResults = results;
    err.failures = failures;
    throw err;
  }
  return results;
}

// 일시적 실패는 재시도한다.
//
// 예전에는 재시도가 없어서 5xx/429 한 번에 `create-draft`/`update-post`가 exit 1로
// 끝났다 — 같은 저장소가 **동일 URL**에 대해 업로드 시점에는 3회/3초 재시도가
// 필요하다고 판단한 것(lib/github-assets.js)과 비대칭이었다. GitHub Pages는
// 배포 직후 몇 초간 5xx를 내는 일이 있다.
//
// 그리고 판정이 `=== 200`이었다. 204·206도 정상 응답이므로 **2xx 전체**를 받는다.
const VERIFY_RETRIES = 3;
const VERIFY_RETRY_DELAY_MS = 3000;

// 재시도해도 달라지지 않는 상태는 즉시 포기한다 (404·403은 배포가 안 된 것이다).
function isRetriableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function headOnce(url) {
  try {
    const res = await axios.head(url, { timeout: 10000 });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status };
  } catch (err) {
    return { ok: false, status: errStatus(err) || 0, reason: errText(err) };
  }
}

async function verifyImageUrls(html, { concurrency = 4, retries = VERIFY_RETRIES } = {}) {
  const urls = extractImageUrls(html);
  if (urls.length === 0) return { ok: true, broken: [] };

  const checked = await mapWithConcurrency(urls, concurrency, async (url) => {
    let last = null;
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
      last = await headOnce(url);
      if (last.ok) return null;
      if (!isRetriableStatus(last.status) || attempt === Math.max(1, retries)) break;
      await new Promise((r) => setTimeout(r, VERIFY_RETRY_DELAY_MS));
    }
    return { url, status: last.status, attempts: Math.max(1, retries), reason: last.reason || null };
  });

  const broken = checked.filter(Boolean);
  return { ok: broken.length === 0, broken };
}

module.exports = { extractImageUrls, mapWithConcurrency, verifyImageUrls };
