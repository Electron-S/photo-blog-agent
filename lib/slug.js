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

// **달력상 유효한 것과 사진 날짜로 타당한 것은 다르다.**
//
// 카메라 시계가 초기화되면 EXIF에 센티널이 들어오고, 그게 달력상 유효한 날짜로
// 정규화되어 모든 가드를 통과했다:
//   exif-reader가 `0000:00:00 00:00:00`을 Date.UTC(0,-1,0) = **1899-11-30**으로 준다
//   → date_status "ok" → primary_date "1899-11-30" → `--slug-from-date`
//   → **Blogger URL이 1899-11-30으로 영구 고정**되고 폴더도 1899-11-30-…
// CLAUDE.md "URL 슬러그 — 절대 규칙"상 삭제·재발행 없이는 복구가 불가능하다.
// 미래 날짜도 마찬가지로 시계 오류다 (사진은 미래에 찍힐 수 없다).
//
// 하한을 1990으로 둔 이유: 그 이전 디지털 사진은 존재하지 않고, 필름 스캔의
// EXIF는 스캔 시점이 들어간다. 정말로 옛 날짜를 쓰려면 --date/--slug로 명시하면
// 되므로 이 검사가 정당한 작업을 막지는 않는다.
const MIN_PHOTO_YEAR = 1990;

function checkDatePlausible(iso, { now = new Date() } = {}) {
  // 형식 검사를 이 함수 안에서도 한다. 예전에는 `NaN < 1990`과 `NaN > limit`이
  // 둘 다 false라서 'abc'·'2026'·'NaN-NaN-NaN'이 **타당하다고 통과**했다.
  // 지금은 모든 호출자가 먼저 정규식 검사를 하므로 도달하지 않지만, "형식이
  // 보장됐다고 가정하는 검증기"는 호출자가 하나 늘면 조용히 뚫린다.
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return `${JSON.stringify(iso)}는 YYYY-MM-DD 형식이 아니라 날짜 타당성을 판정할 수 없습니다.`;
  }
  const [y, mo, d] = iso.split('-').map(Number);
  // **달력 검사가 여기 있어야 한다.** 이 파일에 이미 isValidCalendarDate가 있는데
  // 이 함수만 그것을 부르지 않아, 존재하지 않는 날짜가 "타당"으로 통과했다
  // (실측: 2026-02-30·2026-04-31·2026-02-29 전부 null 반환 = 타당).
  //
  // 이 함수는 **EXIF 경로의 검증기**다 — scripts/extract-exif.js가 이걸로
  // date_status를 정하므로, 통과한 값은 `ok`가 되어 primary_date가 되고,
  // 폴더 경로 `posts/2026-02-30-<hash>/`로 공개 저장소에 push되고, 본문에
  // "지난 2월 30일"이라고 쓰이고, --slug-from-date로 Blogger URL에 영구 고정된다.
  // 그런데 그 뒤에 오는 loadSlugFromMetadata·assertPrimaryDate는 같은 값을
  // **거부한다** — 되돌릴 수 없는 단계가 통과하고 되돌릴 수 있는 단계가 죽는
  // 순서다 (SLUG_RE를 하나로 모은 것과 같은 이유로 같은 실수를 막는다).
  if (!isValidCalendarDate(y, mo, d)) {
    return `${iso}는 존재하지 않는 날짜입니다 (달력에 없는 월/일). `
      + 'EXIF가 손상됐거나 카메라 시계가 잘못된 사진일 수 있습니다 — '
      + '실제 방문 날짜를 --date(업로드) / --slug(발행)로 직접 지정하세요.';
  }
  if (y < MIN_PHOTO_YEAR) {
    return `${iso}는 사진 날짜로 타당하지 않습니다 (${MIN_PHOTO_YEAR}년 이전). `
      + '카메라 시계가 초기화된 사진일 수 있습니다 — EXIF를 확인하고, 의도한 날짜라면 '
      + '--date(업로드) / --slug(발행)로 직접 지정하세요.';
  }
  // 하루 여유: 촬영 기기와 실행 머신의 타임존 차이를 흡수한다.
  const limit = new Date(now.getTime() + 24 * 3600 * 1000);
  const asDate = new Date(Date.UTC(y, mo - 1, d));
  if (asDate.getTime() > Date.UTC(limit.getUTCFullYear(), limit.getUTCMonth(), limit.getUTCDate())) {
    return `${iso}는 미래 날짜입니다. 카메라 시계가 잘못 설정된 사진일 수 있습니다 — `
      + 'EXIF를 확인하고, 의도한 날짜라면 --date / --slug로 직접 지정하세요.';
  }
  return null;
}

// **슬러그 규칙의 정본.** 예전에는 여기가 `^[a-zA-Z0-9-]+$`(대문자·선행 하이픈 허용)이고
// lib/session-state.js의 assertSlug는 `^[a-z0-9][a-z0-9-]*$`였다. 그래서
// `--slug MyPost`가 publish-post를 통과해 **Blogger URL이 영구 고정된 뒤**
// session-state가 exit 9로 죽었다 — 되돌릴 수 없는 작업이 끝난 다음에 세션이
// 깨지는 순서다. 두 곳이 같은 상수를 쓰게 해서 그 순서를 없앤다.
// (소문자 제한은 SEO상으로도 맞다 — 대소문자가 다른 URL은 별 URL로 취급된다.)
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// metadata 객체에서 primary_date를 꺼내 슬러그로 쓸 수 있는지 검증한다 (순수 함수).
// 슬러그 정규식만으로는 "2026-13-99" 같은 invalid 날짜가 통과해서 URL이 그
// 문자열로 영구 고정되는 사고가 난다.
function parsePrimaryDate(meta, sourceLabel, options = {}) {
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
  const implausible = checkDatePlausible(meta.primary_date, options);
  if (implausible) throw new Error(`${where}의 primary_date ${implausible}`);
  return meta.primary_date;
}

function loadSlugFromMetadata(metadataPath, options = {}) {
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  return parsePrimaryDate(meta, metadataPath, options);
}

// CLI로 받은 슬러그 문자열 검증 (순수). { ok, error } 반환 — 호출자가 exit 코드를 정한다.
function validateSlugArg(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, error: 'Error: --slug에 빈 문자열이 전달되었습니다. (변수 치환 실패 의심)' };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: `Error: 슬러그는 소문자 영문/숫자/하이픈만 가능하며 하이픈으로 시작할 수 없습니다. (받음: "${slug}")`,
    };
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
  SLUG_RE,
  extractSlugFromUrl,
  checkDatePlausible,
  isValidCalendarDate,
  MIN_PHOTO_YEAR,
  loadSlugFromMetadata,
  parsePrimaryDate,
  slugMatchesWithAutoSuffix,
  validateSlugArg,
};
