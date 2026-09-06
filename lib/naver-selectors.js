// 네이버 SmartEditor ONE 셀렉터 레지스트리 — 단일 집결지.
//
// ############################################################################
// # 경고: 아래 셀렉터는 전부 **추정값**입니다.                                 #
// #                                                                          #
// # 실제 네이버 DOM을 확인하지 않고 작성했습니다. `npm run naver:inspect`로     #
// # 실물을 본 뒤 후보 순서를 확정하고 VERIFIED_AT을 채우세요.                   #
// # VERIFIED_AT이 null인 동안 naver:doctor는 FAIL 행으로, naver:draft/publish는  #
// # 실행 경로에서 exit 12로 막습니다 (--dry-run은 게이트 앞에서 반환하므로       #
// # 경고가 없습니다).                                                            #
// ############################################################################
//
// 설계 규칙:
//  - 모든 값은 **후보 배열**이다. 1순위는 한국어 UI 텍스트 기반(role/텍스트)으로
//    둔다. 네이버 UI에서는 클래스명(.se-*)보다 버튼 라벨이 더 오래 안정적이다.
//  - must()가 몇 번째 후보로 매칭됐는지 로그에 남긴다. 인덱스가 0이 아니면
//    1순위 셀렉터가 drift한 것이므로 조기 경보가 된다.
//  - 셀렉터를 코드에 흩뿌리지 않는다. DOM이 바뀌면 이 파일만 고친다.

const SCHEMA_VERSION = 1;

// 실물 확인을 마친 날짜(YYYY-MM-DD)와 그때의 playwright 버전을 기입한다.
const VERIFIED_AT = null;
const PLAYWRIGHT_VERIFIED = null;

const editorUrl = (blogId) => `https://blog.naver.com/${blogId}/postwrite`;
const postUrl = (blogId, logNo) => `https://blog.naver.com/${blogId}/${logNo}`;

// 업로드된 이미지가 실제로 네이버 서버에 올라갔는지 판정하는 호스트.
// blob:/data: URL은 아직 클라이언트 메모리에만 있다는 뜻이라 성공이 아니다.
const NAVER_IMAGE_HOSTS = [/postfiles\.pstatic\.net/i, /blogfiles\.pstatic\.net/i, /\.pstatic\.net/i];

const SELECTORS = {
  // 에디터 iframe 탐색
  frame: {
    urlPattern: /PostWriteForm|postwrite/i,
    // top-level에 이 중 하나가 있으면 iframe이 아니라 최상위 문서다
    rootCandidates: [
      '.se-content',
      '.se-container',
      '[contenteditable="true"]',
    ],
  },

  // 진입 시 뜨는 모달들. 이게 떠 있으면 이후 모든 클릭이 조용히 무효가 된다.
  startupModals: [
    {
      key: 'draftRecovery',
      description: '작성 중인 글 복구 팝업',
      container: ['.se-popup-container', '.se-popup', '[class*="popup"]'],
      // "취소"를 눌러 새 글로 시작한다 (이어쓰기하면 이전 내용이 섞인다)
      dismiss: ['button:has-text("취소")', 'button:has-text("닫기")', '.se-popup-button-cancel'],
    },
    {
      key: 'helpLayer',
      description: '첫 사용 도움말 레이어',
      container: ['.se-help-panel', '[class*="guide"]', '[class*="onboarding"]'],
      dismiss: ['button:has-text("닫기")', 'button[class*="close"]'],
    },
  ],

  // 화면을 덮는 오버레이. 레지스트리에 없는 것이 남아 있으면 exit 12로 실패한다.
  overlayProbe: ['.se-popup-dimmed', '.dimmed', '[class*="dimmed"]'],

  title: {
    // SmartEditor ONE의 제목은 input이 아니라 contenteditable일 가능성이 높다.
    candidates: [
      '.se-documentTitle [contenteditable="true"]',
      '.se-section-documentTitle [contenteditable="true"]',
      '[class*="documentTitle"] [contenteditable="true"]',
      'textarea[placeholder*="제목"]',
      'input[placeholder*="제목"]',
    ],
  },

  body: {
    candidates: [
      '.se-component-content [contenteditable="true"]',
      '.se-text-paragraph',
      '.se-content [contenteditable="true"]',
      '[contenteditable="true"]',
    ],
  },

  // 삽입된 이미지 컴포넌트 개수 세기 (업로드 완료 판정용)
  imageComponent: {
    candidates: ['.se-component.se-image', '.se-image', 'figure.se-image'],
  },
  imageElement: {
    candidates: ['.se-component.se-image img', '.se-image img'],
  },

  photoButton: {
    candidates: [
      'button[data-name="image"]',
      'button:has-text("사진")',
      'button[title*="사진"]',
      '.se-toolbar-item-image button',
    ],
  },
  fileInput: {
    // hidden이 정상이다. Playwright의 setInputFiles는 hidden input에도 동작하므로
    // isVisible() 가드를 절대 붙이지 않는다 (조용한 스킵의 원인이었다).
    candidates: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
  },

  saveDraft: {
    candidates: ['button:has-text("저장")', 'button:has-text("임시저장")', '.se-save-button'],
  },
  saveDraftDone: {
    candidates: ['.se-toast:has-text("저장")', '[class*="toast"]:has-text("저장")'],
  },

  // 1차 발행 버튼 — 누르면 발행 설정 레이어가 열린다.
  // 카테고리·태그·공개 범위는 본문 에디터가 아니라 이 레이어 안에 있다.
  publishOpen: {
    candidates: ['button:has-text("발행")', '.publish_btn', '[class*="publish"] button'],
  },
  publishLayer: {
    candidates: ['.se-publish-layer', '[class*="publish"][class*="layer"]', '[class*="option_area"]'],
  },

  categoryOpen: {
    candidates: ['button:has-text("카테고리")', '[class*="category"] button', 'select[name*="category"]'],
  },
  categoryItems: {
    candidates: ['[class*="category"] li', '[class*="category_list"] label', 'select[name*="category"] option'],
  },
  categorySelected: {
    candidates: ['[class*="category"] [class*="selected"]', '[class*="category"] button'],
  },

  visibility: {
    private: ['label:has-text("비공개")', 'input[value="private"]', '[class*="private"]'],
    public: ['label:has-text("전체공개")', 'input[value="public"]', '[class*="public"]'],
    selected: ['input[type="radio"]:checked'],
  },

  tagInput: {
    candidates: ['input[placeholder*="태그"]', '[class*="tag"] input', 'input[name*="tag"]'],
  },
  tagChips: {
    candidates: ['[class*="tag_item"]', '[class*="tag"] li'],
  },

  // 레이어 안의 최종 발행 버튼
  publishConfirm: {
    candidates: ['.se-publish-layer button:has-text("발행")', '[class*="layer"] button:has-text("발행")'],
  },
};

// 확인 상태를 사람이 읽을 수 있는 한 줄로.
function verificationStatus() {
  if (VERIFIED_AT) {
    return `셀렉터 확인됨: ${VERIFIED_AT} (playwright ${PLAYWRIGHT_VERIFIED || '미기입'})`;
  }
  return '경고: 셀렉터가 실물로 확인되지 않았습니다 (VERIFIED_AT=null). '
    + '`npm run naver:inspect`로 확인한 뒤 lib/naver-selectors.js를 갱신하세요.';
}

function isVerified() {
  return Boolean(VERIFIED_AT);
}

module.exports = {
  NAVER_IMAGE_HOSTS,
  PLAYWRIGHT_VERIFIED,
  SCHEMA_VERSION,
  SELECTORS,
  VERIFIED_AT,
  editorUrl,
  isVerified,
  postUrl,
  verificationStatus,
};
