// 예외에서 사람이 읽을 문구를 뽑는다. 의존성 없음.
//
// **왜 별 모듈인가.** JS는 무엇이든 throw할 수 있고 Promise는 무엇으로든 reject할
// 수 있다 (문자열 throw, `Promise.reject()`, `reject(null)`). 그래서 catch 블록에서
// `err.message`를 무가드로 만지면 거기서 TypeError가 나고, **원래 예외가 통째로
// 사라진다.** 이 저장소에서 그게 만든 실제 사고:
//
//   + lib/naver-dom.js가 NaverError(exit 12)를 만들기 전에 dumpFailure를 호출하는데,
//     덤프 쪽에서 TypeError가 나면 exit 12·후보 목록·"naver:inspect로 확인하세요"가
//     전부 없어지고 `err.exitCode || 1` → exit 1(=인자 오류)로 나갔다.
//   + scripts/naver-doctor.js가 세션 행에서 죽어 **셀렉터 게이트를 통째로 건너뛰었다.**
//   + lib/github-assets.js의 병렬 업로드에서 catch가 깨져 Promise.all이 reject되고,
//     성공한 이미지들의 결과가 전부 소실됐다 (공개 저장소에는 이미 push된 상태).
//
// 라운드마다 "이 catch에도 가드를 넣는다"를 반복하는 대신, err.message를 읽는
// **모든 지점이 이 함수 하나만 쓰도록** 한다. 새 catch를 쓸 때 가드를 잊는 것이
// 기본값이 되지 않게 하는 것이 목적이다.

/** 첫 줄만. 표의 한 칸·한 줄 로그에 쓴다. */
function errText(err) {
  return errFull(err).split('\n')[0];
}

/** 전문. 정규식 분류나 상세 출력에 쓴다. */
function errFull(err) {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  // `.message` **접근 자체**를 감싼다. getter가 던지는 객체(Proxy, 계산 프로퍼티)가
  // 있으면 여기서 죽어 원래 예외가 또 사라진다 — 이 모듈의 존재 이유와 정면 충돌.
  try {
    const msg = err.message;
    if (typeof msg === 'string' && msg) return msg;
  } catch { /* 아래 String(err)로 폴백 */ }
  try {
    return String(err);
  } catch {
    // toString도 던지는 객체까지 방어한다.
    return '(설명할 수 없는 예외)';
  }
}

/**
 * `err.code`가 있으면 ` (CODE)`를 붙인다. 진단에 필요한 신호를 삼키지 않기 위해.
 * `.code` 접근도 감싼다 — 이 모듈이 선언한 "접근 자체를 감싼다"가 자기 안에서
 * 지켜지지 않으면 모듈의 존재 이유가 무너진다.
 */
function errCodeTag(err) {
  try {
    const code = err && err.code;
    return code ? ` (${String(code)})` : '';
  } catch {
    return '';
  }
}

/**
 * 스택 트레이스. 없거나 접근이 던지면 빈 문자열.
 * 최상위 `main().catch`가 `if (err.stack)`를 무가드로 쓰면, `Promise.reject(null)`에서
 * **그 핸들러 자체가 죽어** 의도한 exit 코드 대신 unhandled rejection이 된다.
 */
function errStack(err) {
  try {
    const stack = err && err.stack;
    return typeof stack === 'string' ? stack : '';
  } catch {
    return '';
  }
}

/** `err.exitCode`를 안전하게 읽는다. 없으면 fallback. */
function errExitCode(err, fallback = 1) {
  try {
    const code = err && err.exitCode;
    return Number.isInteger(code) && code >= 0 && code <= 255 ? code : fallback;
  } catch {
    return fallback;
  }
}

module.exports = {
  errCodeTag, errExitCode, errFull, errStack, errText,
};
