// 업로드 결과를 **영속화 형태**로 투영한다.
//
// 왜 별도 모듈인가: 예전에는 scripts/upload-images.js 안에서 필드를 하나씩 열거해
// 옮겼는데, lib/github-assets.js가 새 필드(`remotePath`·`uploadStatus`)를 만들어도
// 그 목록에 넣는 것을 잊으면 **인메모리에만 존재하고 산출물에는 없었다**. 실제로
// 그렇게 됐다 — 검증 실패 시 되돌릴 대상 주소를 남기려던 수정이 tmp/upload-<slug>.json에
// 한 글자도 도달하지 않았고, 수정 전과 결과가 같았다.
//
// 여기에 모아 두면 (1) 투영이 한 곳이고 (2) test/github-assets.test.js가
// "uploadBlogImages가 만드는 모든 키가 여기에 있는가"를 계량으로 검사할 수 있다.
// 필드를 추가하고 여기 안 넣으면 그 테스트가 깨진다.

// 의도적으로 내보내지 않는 키. 새로 추가할 때는 **이유를 함께** 적을 것 —
// 비워 두면 "빠뜨린 것"과 "뺀 것"을 구별할 수 없다.
const INTENTIONALLY_OMITTED = new Set([
  // (현재 없음)
]);

/**
 * uploadBlogImages의 결과 항목 하나를 출력 JSON 형태로 투영한다.
 *
 * **조건부 spread를 쓰지 않는다.** 키가 없으면 초안 작성 모델이 "정보 없음"으로
 * 보고 추측하지만, `null`은 "모른다는 것이 확인됨"이라 추측을 막는다.
 * (예전에 watermarkApplied가 조건부라 `true`가 한 번도 안 나왔고, 그래서
 *  `if (!img.watermarkApplied)` 같은 자연스러운 검사가 정상 이미지 100%에서
 *  오작동했다. 워터마크는 이 프로젝트의 이미지 보호 정책 자체다.)
 */
function toOutputImage(item = {}) {
  return {
    index: item.index,
    originalPath: item.originalPath,
    // 로컬 압축본 경로. 네이버 발행이 에디터에 직접 올릴 파일이며,
    // 이게 없으면 하위 단계가 <date>-<hash12> 폴더명을 재계산해야 한다.
    webpPath: item.webpPath ?? null,
    webpUrl: item.webpUrl ?? null,
    url: item.url ?? null,
    // **공개된 사실은 검증 결과와 무관하게 남긴다.** 검증이 실패하면 webpUrl을
    // null로 지우는 것은 맞다(초안이 못 쓰는 URL을 쓰면 안 된다). 하지만 바이트가
    // 공개 저장소 어디에 올라갔는지는 남아야 되돌릴 수 있다.
    remotePath: item.remotePath ?? null,
    // 'created' | 'unchanged' | 'replaced' — 이번 실행이 원격에 실제로 한 일.
    uploadStatus: item.uploadStatus ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    originalBytes: item.originalBytes ?? null,
    webpBytes: item.webpBytes ?? null,
    oversize: item.oversize === true,
    fallbackUsed: item.fallbackUsed === true,
    watermarkApplied: item.watermarkApplied === true,
    orientationApplied: item.orientationApplied === true,
    dimensionsError: item.dimensionsError ?? null,
    compressionError: item.compressionError ?? null,
    // 계약 위반(치수를 못 읽음)은 폴백과 조치가 다르다 — 원본 점검이 아니라
    // sharp/파이프라인 점검이다. 이 필드를 빼면 summary.contractViolation만 남고
    // "어느 이미지가 계약 위반인지"는 stderr에만 존재해 영속화되지 않는다.
    contractError: item.contractError ?? null,
    verificationError: item.verificationError ?? null,
    error: item.error ?? null,
  };
}

// 투영이 내보내는 키 집합 (테스트가 커버리지 검사에 쓴다).
const OUTPUT_IMAGE_KEYS = Object.keys(toOutputImage({}));

module.exports = { INTENTIONALLY_OMITTED, OUTPUT_IMAGE_KEYS, toOutputImage };
