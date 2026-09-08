const test = require('node:test');
const assert = require('node:assert/strict');
const { extractImageUrls } = require('../lib/verify-images');

test('extractImageUrls — src와 srcset', () => {
  assert.deepEqual(
    extractImageUrls('<img src="https://x/a.webp">'),
    ['https://x/a.webp'],
  );
  assert.deepEqual(
    extractImageUrls('<img srcset="https://x/a.webp 1x, https://x/b.webp 2x">'),
    ['https://x/a.webp', 'https://x/b.webp'],
  );
});

test('extractImageUrls — 중복 제거와 대문자 태그', () => {
  assert.deepEqual(
    extractImageUrls('<img src="https://x/a.webp"><IMG SRC="https://x/a.webp">'),
    ['https://x/a.webp'],
  );
  assert.deepEqual(
    extractImageUrls('<IMG src="https://x/b.webp">'),
    ['https://x/b.webp'],
  );
});

test('extractImageUrls — 여러 줄에 걸친 속성', () => {
  // 실제 초안은 <img> 속성을 여러 줄로 나눠 쓴다.
  const html = `<img loading="lazy" width="1024" height="768"
       src="https://x/a.webp"
       alt="설명" style="max-width:100%;height:auto;" />`;
  assert.deepEqual(extractImageUrls(html), ['https://x/a.webp']);
});

test('extractImageUrls — 작은따옴표 src도 인식한다', () => {
  // 예전 정규식 구현은 큰따옴표만 매칭해서, 작은따옴표를 쓰면 URL 검증을
  // 조용히 건너뛰었다. 이제 lint-draft와 같은 파서를 재사용한다.
  assert.deepEqual(extractImageUrls("<img src='https://x/a.webp'>"), ['https://x/a.webp']);
});

test('extractImageUrls — source의 srcset도 수집', () => {
  assert.deepEqual(
    extractImageUrls('<source srcset="https://x/a.webp 1x">'),
    ['https://x/a.webp'],
  );
});

test('mapWithConcurrency — 순서 보존과 동시성 제한', async () => {
  const { mapWithConcurrency } = require('../lib/verify-images');
  let running = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14], '입력 순서가 보존되어야 한다');
  assert.ok(peak <= 3, `동시 실행이 ${peak}개로 제한을 넘었다`);
});

test('mapWithConcurrency — 빈 입력', async () => {
  const { mapWithConcurrency } = require('../lib/verify-images');
  assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
});

test('extractImageUrls — 이미지 없음', () => {
  assert.deepEqual(extractImageUrls('<p>텍스트만</p>'), []);
  assert.deepEqual(extractImageUrls(''), []);
});

test('mapWithConcurrency — limit이 1 미만이면 던진다 (조용한 전부 통과 방지)', async () => {
  const { mapWithConcurrency } = require('../lib/verify-images');
  // limit<1이면 워커가 0개라 콜백을 한 번도 부르지 않고 [null,...]을 반환했다.
  // 이 함수는 검증 유틸리티라 그 상태가 "전부 통과"로 읽힌다.
  // await하지 않으면 어느 값이 통과했는지 리포트에 안 나온다.
  await Promise.all([0, -1, 1.5, '4', null, undefined, NaN].map((bad) => assert.rejects(
    () => mapWithConcurrency([1, 2, 3], bad, async (x) => x),
    TypeError,
    `limit=${JSON.stringify(bad)} 를 통과시킴`,
  )));
});

// --- 19차 리뷰 회귀 ---

test('verifyImageUrls — 2xx를 정상으로 보고 일시 실패는 재시도한다', async (t) => {
  // 판정이 `=== 200`이라 204·206이 broken이 됐고, 재시도가 없어 일시적 5xx/429
  // 한 번에 create-draft/update-post가 exit 1로 끝났다 — 같은 저장소가 **동일
  // URL**에 대해 업로드 시점에는 3회/3초 재시도가 필요하다고 판단한 것과 비대칭이다.
  const Module = require('node:module');
  const LIB = require.resolve('../lib/verify-images');

  const withAxios = async (head, run) => {
    const origLoad = Module._load;
    const stub = {};
    stub.head = head;
    Module._load = function load(request, ...rest) {
      if (request === 'axios') return stub;
      return origLoad.call(this, request, ...rest);
    };
    delete require.cache[LIB];
    try {
      return await run(require(LIB));
    } finally {
      Module._load = origLoad;
      delete require.cache[LIB];
    }
  };

  const HTML = '<img src="https://x/a.webp">';

  // 204·206은 정상이다
  for (const status of [200, 201, 204, 206]) {
    const r = await withAxios(async () => ({ status }),
      ({ verifyImageUrls }) => verifyImageUrls(HTML));
    assert.equal(r.ok, true, `status ${status} 를 broken으로 판정`);
  }

  // 일시적 5xx는 재시도해서 살린다
  let calls = 0;
  const retried = await withAxios(async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('boom');
      err.response = { status: 503 };
      throw err;
    }
    return { status: 200 };
  }, ({ verifyImageUrls }) => verifyImageUrls(HTML, { retries: 3 }));
  assert.equal(retried.ok, true, '재시도로 살아나지 않음');
  assert.equal(calls, 3);

  // 404는 재시도하지 않는다 (배포가 안 된 것이다)
  let notFound = 0;
  const gone = await withAxios(async () => {
    notFound += 1;
    const err = new Error('nope');
    err.response = { status: 404 };
    throw err;
  }, ({ verifyImageUrls }) => verifyImageUrls(HTML, { retries: 3 }));
  assert.equal(gone.ok, false);
  assert.equal(notFound, 1, '404를 재시도함 (시간 낭비)');
  assert.equal(gone.broken[0].status, 404);
});

// --- 20차 리뷰 회귀 ---

test('verifyImageUrls — attempts가 설정값이 아니라 실제 시도 횟수다', async (t) => {
  // `attempts: Math.max(1, retries)`는 **설정값**이라, 404처럼 한 번만 요청하고
  // 포기한 경우에도 "3회 시도"로 보고했다 (실측: 서버 hit 1회 / attempts 3).
  // 재시도했는데도 404인 것과 재시도 대상이 아닌 것은 다른 진단이다.
  const http = require('node:http');
  const { verifyImageUrls } = require('../lib/verify-images');

  const serve = async (status) => {
    let hits = 0;
    const srv = http.createServer((req, res) => { hits += 1; res.writeHead(status); res.end(); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${srv.address().port}/a.webp`;
    const r = await verifyImageUrls(`<img src="${url}">`, { retries: 2 });
    srv.close();
    return { hits, broken: r.broken[0] };
  };

  // 404는 재시도 대상이 아니다 — 요청도 1회, 보고도 1회여야 한다
  const gone = await serve(404);
  assert.equal(gone.hits, 1, '404를 재시도함');
  assert.equal(gone.broken.attempts, 1, `attempts=${gone.broken.attempts} (실제 요청 ${gone.hits}회)`);
  assert.equal(gone.broken.status, 404);

  // 503은 소진까지 재시도한다 — 요청 횟수와 보고가 일치해야 한다
  const flaky = await serve(503);
  assert.equal(flaky.hits, 2);
  assert.equal(flaky.broken.attempts, flaky.hits,
    `attempts=${flaky.broken.attempts} != 실제 요청 ${flaky.hits}회`);
});

test('verifyImageUrls — 네트워크 실패 이유를 버리지 않는다', async () => {
  // status만 남기면 오프라인·DNS 실패·TLS 오류·타임아웃·연결 거부가 전부 status 0
  // 한 값으로 붕괴해, 사용자가 "GitHub Pages 전파 지연"인지 "내 인터넷이 끊겼는지"를
  // 구별할 수 없다 (그 상태로 create-draft/update-post가 exit 1이라 발행이 막힌다).
  const { verifyImageUrls } = require('../lib/verify-images');
  const r = await verifyImageUrls('<img src="http://127.0.0.1:1/x.webp">', { retries: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.broken[0].status, 0);
  assert.match(r.broken[0].reason, /ECONNREFUSED/,
    `reason이 비었거나 이유를 담지 않음: ${JSON.stringify(r.broken[0].reason)}`);
});
