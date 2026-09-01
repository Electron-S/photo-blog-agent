// 자산 경로 계산 — 외부 의존성 없음.
// github-assets.js를 require하면 sharp 네이티브 바인딩이 함께 로드되므로,
// 경로 계산만 필요한 곳(테스트 포함)이 sharp를 끌고 오지 않도록 분리한다.

const crypto = require('crypto');

// 한글은 \w에 걸리지 않아 전부 제거되고 'post'가 된다. 이게 Blogger 슬러그와
// GitHub 경로를 ASCII로 유지하는 의도된 동작이며, 그래서 워크플로우가
// 사용자에게 영문 슬러그를 요구한다.
function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || 'post';
}

// URL 추측 방지용 경로 해시. (date, slug)가 같으면 항상 같은 값이어야 한다 —
// 같은 사진을 며칠 뒤 재업로드해도 같은 폴더를 가리켜야 멱등성이 유지된다.
function hashPath(date, slug) {
  return crypto.createHash('sha256').update(`${date}-${slug}`).digest('hex').slice(0, 12);
}

// 업로드 폴더명. lib/github-assets.js와 네이버 이미지 경로 해석이 공유하는 규약.
function postDirName(date, slug) {
  return `${date}-${hashPath(date, slug)}`;
}

module.exports = { slugify, hashPath, postDirName };
