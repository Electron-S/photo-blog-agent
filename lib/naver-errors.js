// 네이버 자동화 전용 오류와 exit 코드.
//
// 1~9는 기존 스크립트가 점유하고 있으므로 (extract-exif 1/2/3,
// upload-images 1/2/4/5, publish-post 1/6/7, delete-post 1/7,
// lint 8, session-state 9) 네이버 **고유** 실패는 10~19를 쓴다.
// 인자 오류 같은 일반 실패는 1을 공유한다. 조치가 다르면 코드도 다르다.

const { errFull } = require('./err-text');

const NAVER_EXIT = {
  // 인자 오류·설정 누락 등 일반 실패
  GENERAL: 1,
  // 초안 HTML을 네이버 블록으로 변환할 수 없음 (허용 밖 태그, 구조 오류 등).
  // "플래그를 잘못 썼다"와 조치가 완전히 다르므로 GENERAL과 분리한다.
  CONTENT: 19,
  // playwright 모듈 또는 브라우저 바이너리 없음
  // → npm install --include=optional && npx playwright install chromium
  MISSING_PLAYWRIGHT: 10,
  // 세션 없음/만료/다른 계정으로 로그인됨 → npm run naver:login
  SESSION: 11,
  // 셀렉터를 찾지 못함 (DOM 변경 의심)
  // → tmp/naver-debug/ 덤프 확인 → naver:inspect → 레지스트리 갱신
  SELECTOR: 12,
  // --- 13·14·15는 예약된 코드다. 발행 레이어(lib/naver-editor.js)가 구현되기
  // 전까지는 어디서도 throw되지 않는다. 이 사실은 scripts/naver-create-draft.js의
  // usage와 README의 exit 표에 "(예약)"으로 표시돼 있다 — 이 셋을 던지게 될
  // 스크립트가 늘어나면 그 usage에도 같은 표시를 넣을 것. ---
  //
  // 카테고리 미존재 또는 설정 검증 실패 (에러에 사용 가능 목록을 나열한다)
  CATEGORY: 13,
  // 태그 설정 검증 실패
  TAGS: 14,
  // 발행 후 사후 검증 실패 — 글은 이미 게시됐다. 자동 재시도 금지.
  PUBLISH_VERIFY: 15,
  // --- 아래는 예약이 아니라 실제로 쓰인다 ---
  //
  // 이미지 로컬 파일을 찾지 못함 (lib/naver-content.js의 resolveImagePaths)
  IMAGE: 16,
  // headed 실행 불가 (디스플레이 없음)
  NO_DISPLAY: 17,
  // 공개 발행 안전장치 거부
  PUBLIC_BLOCKED: 18,
};

class NaverError extends Error {
  /**
   * @param {number} exitCode NAVER_EXIT 중 하나
   * @param {string} message 사용자가 다음에 무엇을 해야 하는지 알 수 있는 문구
   * @param {object} [detail] 덤프 경로·시도한 셀렉터 등
   */
  constructor(exitCode, message, detail = null) {
    super(message);
    this.name = 'NaverError';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

// 각 스크립트의 main().catch에서 공통으로 쓰는 출력.
function reportNaverError(err) {
  console.error(`\n실패 (exit ${err.exitCode || 1}): ${errFull(err)}`);
  if (err.detail) {
    console.error(`상세: ${JSON.stringify(err.detail, null, 2)}`);
  }
  if (err.exitCode === NAVER_EXIT.PUBLISH_VERIFY) {
    console.error('\n※ 글은 이미 게시된 상태일 수 있습니다. 자동 재시도하지 마세요 —');
    console.error('  중복 발행이 됩니다. 네이버에서 직접 확인한 뒤 조치하세요.');
  }
}

module.exports = { NAVER_EXIT, NaverError, reportNaverError };
