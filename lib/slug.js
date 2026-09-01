// Blogger URL 슬러그 로직 — 외부 의존성 없음 (fs 제외).
//
// Blogger는 첫 발행 시점에 URL을 영구 고정한다. 슬러그를 잘못 정하면 되돌릴 방법이
// 없고, 글을 지우고 다시 올리면 Google이 옛 URL → 새 URL redirect로 오인해
// Search Console "리디렉션 오류"로 색인이 막힌다 (실제 사고 이력).
// 그래서 이 모듈의 모든 검증은 통과보다 거부 쪽으로 엄격하다.

const fs = require('fs');

// 같은 날짜에 둘 이상의 글을 발행하면 Blogger가 두 번째부터 `-1`, `-2` suffix를
// 자동 부여한다. 이건 정상 동작이므로 통과시키되, 그 외 임의 슬러그 변경은
// silent하게 넘기지 않는다.
// 주의: requested가 너무 짧으면 (예: "2026-05") 다른 글의 슬러그("2026-05-10")가
// 자동 suffix로 오인되어 false positive 통과 가능. 자동화 흐름은 `--slug-from-date`로
// 항상 `YYYY-MM-DD`를 강제하므로 사고 가능성은 낮지만, 수동 `--slug`로 짧은
// prefix를 넣지 말 것. (test/slug.test.js가 이 한계를 명시적으로 문서화한다.)
function slugMatchesWithAutoSuffix(actual, requested) {
  if (actual === requested) return true;
  // requested는 호출 전에 ^[a-zA-Z0-9-]+$로 검증되어 regex 특수문자가 없다.
  return new RegExp(`^${requested}-\\d+$`).test(actual);
}

// Blogger 글 URL(.../YYYY-MM-DD.html)에서 슬러그만 뽑는다.
function extractSlugFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/([^/]+)\.html$/);
  return m ? m[1] : null;
}

function isValidCalendarDate(y, mo, d) {
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() + 1 === mo && date.getDate() === d;
}

// metadata 객체에서 primary_date를 꺼내 슬러그로 쓸 수 있는지 검증한다 (순수 함수).
// 슬러그 정규식만으로는 "2026-13-99" 같은 invalid 날짜가 통과해서 URL이 그
// 문자열로 영구 고정되는 사고가 난다.
function parsePrimaryDate(meta, sourceLabel) {
  const where = sourceLabel ? `metadata ${sourceLabel}` : 'metadata';
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error(`${where}의 최상위 타입이 객체가 아닙니다.`);
  }
  if (typeof meta.primary_date !== 'string' || !meta.primary_date) {
    throw new Error(`${where}의 primary_date가 null이거나 문자열이 아닙니다. --slug로 직접 지정하세요.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.primary_date)) {
    throw new Error(`${where}의 primary_date "${meta.primary_date}"가 YYYY-MM-DD 형식이 아닙니다.`);
  }
  const [y, mo, d] = meta.primary_date.split('-').map(Number);
  if (!isValidCalendarDate(y, mo, d)) {
    throw new Error(`${where}의 primary_date "${meta.primary_date}"가 유효한 달력 날짜가 아닙니다.`);
  }
  return meta.primary_date;
}

function loadSlugFromMetadata(metadataPath) {
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  return parsePrimaryDate(meta, metadataPath);
}

// CLI로 받은 슬러그 문자열 검증 (순수). { ok, error } 반환 — 호출자가 exit 코드를 정한다.
function validateSlugArg(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, error: 'Error: --slug에 빈 문자열이 전달되었습니다. (변수 치환 실패 의심)' };
  }
  if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
    return { ok: false, error: `Error: 슬러그는 영문/숫자/하이픈만 가능합니다. (받음: "${slug}")` };
  }
  // 날짜 형식 슬러그인데 zero-padding이 안 된 경우 차단. URL이 영구 고정되므로
  // "2026-5-4"와 "2026-05-04"가 섞이면 색인에 악영향을 준다.
  const dateLike = slug.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateLike) {
    const [, yStr, moStr, dStr] = dateLike;
    const zeroPadded = `${yStr}-${moStr.padStart(2, '0')}-${dStr.padStart(2, '0')}`;
    if (slug !== zeroPadded) {
      return { ok: false, error: `Error: 날짜 슬러그는 zero-padding이 필요합니다. "${slug}" → "${zeroPadded}"으로 지정하세요.` };
    }
    if (!isValidCalendarDate(Number(yStr), Number(moStr), Number(dStr))) {
      return { ok: false, error: `Error: 슬러그 "${slug}"는 유효한 달력 날짜가 아닙니다.` };
    }
  }
  return { ok: true, error: null };
}

module.exports = {
  extractSlugFromUrl,
  isValidCalendarDate,
  loadSlugFromMetadata,
  parsePrimaryDate,
  slugMatchesWithAutoSuffix,
  validateSlugArg,
};
