// 자산 경로 계산 — 외부 의존성 없음.
// github-assets.js를 require하면 sharp 네이티브 바인딩이 함께 로드되므로,
// 경로 계산만 필요한 곳(테스트 포함)이 sharp를 끌고 오지 않도록 분리한다.

const crypto = require('crypto');

// 한글은 \w에 걸리지 않아 전부 제거되고 'post'가 된다. ASCII 경로를 유지하는
// 의도된 동작이지만, **호출자는 그 붕괴를 감지해야 한다** — `slugify('경복궁')`과
// `slugify('서울카페')`가 모두 'post'가 되므로 hashPath가 날짜만의 함수가 되어
// 서로 다른 글이 **같은 원격 폴더를 덮어쓴다** (이미 발행된 글의 photo-NN.webp가
// 제자리에서 교체된다). 그래서 slugCollapsed()를 함께 제공한다.
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

// slugify가 식별성을 잃었는지 — 입력이 비어 있지도 'post'도 아닌데 결과가
// 'post'면 ASCII화 과정에서 정보가 전부 사라진 것이다.
function slugCollapsed(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;                     // 입력 없음은 별개 문제다
  if (raw.toLowerCase() === 'post') return false;
  return slugify(raw) === 'post';
}

module.exports = {
  hashPath, postDirName, slugCollapsed, slugify,
};
