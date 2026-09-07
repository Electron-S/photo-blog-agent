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

/**
 * `err.exitCode`를 안전하게 읽는다. 없으면 fallback.
 *
 * **0은 받지 않는다.** 이건 실패 경로에서만 쓰이므로, `exitCode === 0`을 그대로
 * 돌려주면 치명적 실패가 `process.exit(0)`으로 성공 보고된다. 예전 표현
 * `errExitCode(err) || 1`이 우연히 막고 있던 것을 헬퍼로 옮기면서 잃었다.
 */
function errExitCode(err, fallback = 1) {
  try {
    const code = err && err.exitCode;
    return Number.isInteger(code) && code >= 1 && code <= 255 ? code : fallback;
  } catch {
    return fallback;
  }
}

/**
 * axios 등이 실은 응답 바디를 안전하게 뽑는다. 없으면 null.
 *
 * `if (err.response?.data)`는 **`err` 자체가 nullish일 때 죽는다** — `?.`는
 * `response`가 없는 경우만 막는다. errStack/errExitCode를 넣어 `Promise.reject(null)`을
 * 견디게 만든 바로 그 핸들러들의 **다음 줄**이 이 형태였다 (실측: TypeError).
 */
function errResponseData(err) {
  try {
    const data = err && err.response && err.response.data;
    if (data === undefined || data === null) return null;
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return null;
  }
}

/**
 * 최상위 `main().catch`의 공통 출력. **핸들러가 err를 직접 만지지 않게 하는 것**이
 * 목적이다 — 라운드마다 "이 접근에도 가드를 넣는다"를 반복한 이유가, 핸들러마다
 * 자기 손으로 err의 프로퍼티를 꺼냈기 때문이다.
 *
 * @returns {number} process.exit에 넘길 코드
 */
function reportFatal(err, label, options = {}) {
  const { fallbackExit = 1, quietStackFor = [] } = typeof options === 'number'
    ? { fallbackExit: options }
    : options;
  console.error(label, errFull(err));
  const code = errExitCode(err, fallbackExit);
  // 정책적 거부(예: exit 8 = lint 위반)는 버그가 아니므로 스택을 내지 않는다.
  // 스택 8줄이 "무엇을 고쳐야 하는지"를 화면 밖으로 밀어낸다.
  const stack = quietStackFor.includes(code) ? '' : errStack(err);
  if (stack) console.error(stack);
  const data = errResponseData(err);
  if (data) console.error('API response:', data);
  return code;
}

/** HTTP 상태 코드 (axios `err.response.status`). 없으면 null. */
function errStatus(err) {
  try {
    const status = err && err.response && err.response.status;
    return Number.isFinite(status) ? status : null;
  } catch {
    return null;
  }
}

/** `err.code` (fs의 ENOENT, axios의 ERR_BAD_REQUEST, DNS의 EAI_AGAIN 등). 없으면 null. */
function errCode(err) {
  try {
    const code = err && err.code;
    return code === undefined || code === null ? null : code;
  } catch {
    return null;
  }
}

/**
 * axios 응답 객체 원본. 감싼 오류에 그대로 옮겨 실을 때만 쓴다.
 *
 * `if (err && err.response) wrapped.response = err.response;`처럼 쓰면 논리적으로는
 * 안전하지만 소스 스캔이 블록 스코프를 볼 수 없어 위반으로 잡힌다. 스캔을 느슨하게
 * 하는 대신 헬퍼를 쓰는 쪽이 맞다 — 가드를 손으로 쓰는 형태가 남아 있으면
 * 라운드마다 "여기도 가드를 넣는다"가 반복된다.
 */
function errResponse(err) {
  try {
    const response = err && err.response;
    return response === undefined || response === null ? null : response;
  } catch {
    return null;
  }
}

/** axios 응답 바디 원본 객체. 문자열화 없이 필드를 봐야 하는 경우에만 쓴다. */
function errResponseBody(err) {
  try {
    const data = err && err.response && err.response.data;
    return data === undefined ? null : data;
  } catch {
    return null;
  }
}

module.exports = {
  errCode,
  errCodeTag,
  errExitCode,
  errFull,
  errResponse,
  errResponseBody,
  errResponseData,
  errStack,
  errStatus,
  errText,
  reportFatal,
};
