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
