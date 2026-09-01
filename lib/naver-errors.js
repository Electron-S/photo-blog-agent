// 네이버 자동화 전용 오류와 exit 코드.
//
// 1~9는 기존 스크립트가 점유하고 있으므로 (extract-exif 1/2/3,
// upload-images 1/4/5, publish-post 1/6/7, lint 8, session-state 9)
// 네이버는 10~18 블록을 쓴다. 조치가 다르면 코드도 다르다.

const NAVER_EXIT = {
  GENERAL: 1,
  // playwright 모듈 또는 브라우저 바이너리 없음
  // → npm install --include=optional && npx playwright install chromium
  MISSING_PLAYWRIGHT: 10,
  // 세션 없음/만료/다른 계정으로 로그인됨 → npm run naver:login
  SESSION: 11,
  // 셀렉터를 찾지 못함 (DOM 변경 의심)
  // → tmp/naver-debug/ 덤프 확인 → naver:inspect → 레지스트리 갱신
  SELECTOR: 12,
  // 카테고리 미존재 또는 설정 검증 실패 (에러에 사용 가능 목록을 나열한다)
  CATEGORY: 13,
  // 태그 설정 검증 실패
  TAGS: 14,
  // 발행 후 사후 검증 실패 — 글은 이미 게시됐다. 자동 재시도 금지.
  PUBLISH_VERIFY: 15,
  // 이미지 로컬 파일 없음 또는 네이버 업로드 미완료
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
  console.error(`\n실패 (exit ${err.exitCode || 1}): ${err.message}`);
  if (err.detail) {
    console.error(`상세: ${JSON.stringify(err.detail, null, 2)}`);
  }
  if (err.exitCode === NAVER_EXIT.PUBLISH_VERIFY) {
    console.error('\n※ 글은 이미 게시된 상태일 수 있습니다. 자동 재시도하지 마세요 —');
    console.error('  중복 발행이 됩니다. 네이버에서 직접 확인한 뒤 조치하세요.');
  }
}

module.exports = { NAVER_EXIT, NaverError, reportNaverError };
