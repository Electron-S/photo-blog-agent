const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, hashPath, postDirName } = require('../lib/asset-paths');

test('slugify — ASCII 정규화', () => {
  assert.equal(slugify('Seokchon Lake Spring'), 'seokchon-lake-spring');
  assert.equal(slugify('under_score and space'), 'under-score-and-space');
  assert.equal(slugify('multi---hyphen'), 'multi-hyphen');
  assert.equal(slugify('  trim me  '), 'trim-me');
  assert.equal(slugify('Café'), 'cafe');
});

test('slugify — 한글은 제거되어 기본값 post가 된다 (의도된 동작)', () => {
  // 한글은 \w에 걸리지 않아 전부 사라진다. 그래서 워크플로우가 사용자에게
  // 영문 슬러그를 요구한다. 이 동작에 의존하지 말고 --slug를 명시할 것.
  assert.equal(slugify('석촌호수'), 'post');
  assert.equal(slugify(''), 'post');
  assert.equal(slugify(null), 'post');
  assert.equal(slugify(undefined), 'post');
  assert.equal(slugify('!!!'), 'post');
  // 한글 + 영문이 섞이면 영문만 남는다
  assert.equal(slugify('석촌 lake'), 'lake');
});

test('hashPath — 결정적이고 12자 hex', () => {
  const h = hashPath('2026-05-10', 'dim-test');
  assert.match(h, /^[0-9a-f]{12}$/);
  // 고정 벡터: 같은 사진을 며칠 뒤 재업로드해도 같은 폴더를 가리켜야 한다 (멱등성).
  assert.equal(h, '17bad17b0188');
  assert.equal(hashPath('2026-05-10', 'dim-test'), h);
  assert.notEqual(hashPath('2026-05-11', 'dim-test'), h);
  assert.notEqual(hashPath('2026-05-10', 'other'), h);
});

test('postDirName', () => {
  assert.equal(postDirName('2026-05-10', 'dim-test'), '2026-05-10-17bad17b0188');
  assert.match(postDirName('2026-05-10', 'x'), /^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/);
});

test('github-assets가 같은 구현을 re-export한다', () => {
  const ga = require('../lib/github-assets');
  assert.equal(ga.slugify, slugify);
  assert.equal(ga.hashPath, hashPath);
  assert.equal(ga.postDirName, postDirName);
});
