// 자산 경로 계산 — 외부 의존성 없음.
// github-assets.js를 require하면 sharp 네이티브 바인딩이 함께 로드되므로,
// 경로 계산만 필요한 곳(테스트 포함)이 sharp를 끌고 오지 않도록 분리한다.

const crypto = require('crypto');
// lib/slug.js는 fs만 require하므로 순환이 없다 (지연 require가 불필요했다).
const { SLUG_RE } = require('./slug');

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
//
// **이것만으로는 부족하다** (7차 수정의 구멍): `slugify('trip-경복궁')`과
// `slugify('trip-남산타워')`는 둘 다 `'trip-'`이라 collapsed=false인데 같은
// 폴더가 된다. "전부 사라졌나"가 아니라 "**조금이라도** 사라졌나"를 봐야 한다.
// → canonicalSlugError가 그 판정을 한다. 이 함수는 진단 문구용으로만 남긴다.
function slugCollapsed(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;                     // 입력 없음은 별개 문제다
  if (raw.toLowerCase() === 'post') return false;
  return slugify(raw) === 'post';
}

// **폴더 경로의 식별자는 "자기 자신의 정규형"이어야 한다.**
//
// hashPath는 slugify **결과**로 계산된다. 그래서 slugify가 입력을 바꾸는 순간
// 사용자가 지정한 slug와 폴더 식별자가 갈라지고, 서로 다른 두 slug가 같은
// 결과로 수렴할 수 있다 (실측: trip-경복궁 · trip-남산타워 → 둘 다 `trip-`).
// 원격에서는 **이미 발행된 글의 photo-NN.webp를 제자리 덮어쓰기**다.
//
// "붕괴하는 케이스를 열거해 막는다"가 아니라 **"slugify가 손대지 않는 값만
// 받는다"**로 판정 기준을 바꾼다. 그러면 부분 붕괴가 정의상 불가능하다.
// 규칙은 lib/slug.js의 SLUG_RE — 발행·세션과 같은 정본이다.
function canonicalSlugError(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    return '이 비어 있습니다.';
  }
  if (!SLUG_RE.test(slug)) {
    return `"${slug}"은 소문자 영문/숫자/하이픈만 가능하며 하이픈으로 시작할 수 없습니다 `
      + '(발행·세션 슬러그와 같은 규칙입니다).';
  }
  const canonical = slugify(slug);
  if (canonical !== slug) {
    return `"${slug}"은 정규형이 아닙니다 (경로 계산에는 "${canonical}"이 쓰입니다). `
      + `"${canonical}"을 그대로 지정하세요 — 그러지 않으면 다른 slug가 같은 폴더로 수렴할 수 있습니다.`;
  }
  return null;
}

module.exports = {
  canonicalSlugError, hashPath, postDirName, slugCollapsed, slugify,
};
