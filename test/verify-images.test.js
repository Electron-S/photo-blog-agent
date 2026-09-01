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

test('extractImageUrls — 작은따옴표 src는 인식하지 못한다 (알려진 한계)', () => {
  // 정규식이 큰따옴표만 매칭한다. 프롬프트가 큰따옴표를 강제하므로 실사용에는
  // 문제가 없지만, 작은따옴표를 쓰면 URL 검증이 조용히 건너뛰어진다는 사실을
  // 테스트로 고정한다. 이 동작을 바꾸면 이 테스트도 함께 갱신할 것.
  assert.deepEqual(extractImageUrls("<img src='https://x/a.webp'>"), []);
});

test('extractImageUrls — 이미지 없음', () => {
  assert.deepEqual(extractImageUrls('<p>텍스트만</p>'), []);
  assert.deepEqual(extractImageUrls(''), []);
});
