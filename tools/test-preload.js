// 테스트 프로세스마다 먼저 로드되는 설정. `tools/run-tests.js`가 `--require`로 넣는다.
//
// **sharp의 파일 캐시를 끈다.** libvips는 열었던 입력 파일을 캐시에 붙들고 있고,
// Windows는 열린 파일의 unlink를 거부한다. 그래서 임시 디렉터리를 지우는 `t.after`
// 훅이 이렇게 실패했다 (첫·두 번째 CI 실행의 Windows leg에서 실제로 관측):
//
//   failureType: 'hookFailed'
//   error: "EPERM: operation not permitted, unlink 'C:\...\Temp\pba-cs-...\good.jpg'"
//
// 테스트 **본문은 통과했는데** 정리 훅이 실패해 빨강이 된다. `rmSync`의
// maxRetries(5회/100ms)로는 부족했다 — 캐시가 붙들고 있는 동안에는 기다려도
// 풀리지 않는다. Linux는 열린 파일도 지워지므로 로컬에서는 어떤 방법으로도
// 드러나지 않는다. CI 매트릭스에 windows-latest를 넣은 이유 그 자체다.
//
// 프로덕션 경로는 입력 파일을 지우지 않으므로 이 설정은 테스트에만 필요하다.
try {
  require('sharp').cache(false);
} catch {
  // sharp가 없어도 테스트 러너는 돌아야 한다 (대부분의 테스트가 sharp를 쓰지 않는다).
  // 다만 조용히 넘기지 않고 이유를 남긴다 — sharp를 쓰는 테스트가 Windows에서
  // 정리 훅 실패로 빨강이 되면 원인을 여기서 찾을 수 있어야 한다.
  process.emitWarning('tools/test-preload: sharp를 로드할 수 없어 파일 캐시를 끄지 못했습니다.');
}
