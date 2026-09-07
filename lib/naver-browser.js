// 브라우저 기동과 세션 관리.
//
// 예전 구현의 두 가지 치명적 결함을 고친다:
//  1. chromium.launch()는 headless가 기본인데 loginToNaver는 사용자가 브라우저에서
//     직접 로그인하길 5분 기다렸다. 창이 안 뜨므로 로그인이 원리적으로 불가능했다.
//  2. waitForNavigation은 첫 네비게이션에 반응하므로 로그인 **실패** 리로드도
//     "성공"으로 잡았다.

const fs = require('fs');
const path = require('path');
const { NAVER_EXIT, NaverError } = require('./naver-errors');
const { editorUrl } = require('./naver-selectors');
const { errFull, errText } = require('./err-text');

const DEFAULT_PROFILE_DIR = '.naver-profile';
const SESSION_SNAPSHOT = '.naver-session.json';
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login';

function requirePlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new NaverError(
      NAVER_EXIT.MISSING_PLAYWRIGHT,
      'playwright가 설치되어 있지 않습니다 (optionalDependencies).\n'
      + '  + npm install --include=optional\n'
      + '  + npx playwright install chromium\n'
      + `  + 원인: ${errText(err)}`,
    );
  }
}

function browserExecutable() {
  const { chromium } = requirePlaywright();
  let p = null;
  try { p = chromium.executablePath(); } catch { p = null; }
  return { path: p, exists: Boolean(p && fs.existsSync(p)) };
}

function assertBrowserInstalled() {
  const { path: p, exists } = browserExecutable();
  if (!exists) {
    throw new NaverError(
      NAVER_EXIT.MISSING_PLAYWRIGHT,
      `chromium 바이너리가 없습니다 (${p || '경로 확인 불가'}).\n`
      + '  + npx playwright install chromium\n'
      + '  + 시스템 라이브러리가 없다면: sudo npx playwright install-deps chromium',
    );
  }
  return p;
}

// headed 모드는 실제 창이 필요하다. 디스플레이가 없으면 5분 기다렸다 타임아웃 나는
// 대신 실행 전에 즉시 거부한다.
//
// 판정은 **환경변수만** 본다. 예전에는 `/tmp/.X11-unix/X0` 소켓 파일이 있으면
// OK를 줬는데, chromium은 소켓 경로가 아니라 $DISPLAY로 접속하므로 거짓 초록이었다.
// 그 결과 naver-login-setup의 "실행 전 즉시 거부"(exit 17 + 안내)가 무력화되고
// playwright 원시 덤프 + exit 1로 끝났다. 소켓 존재는 안내 문구에만 쓴다.
function displayAvailable() {
  if (process.env.DISPLAY) return { ok: true, via: `DISPLAY=${process.env.DISPLAY}` };
  if (process.env.WAYLAND_DISPLAY) return { ok: true, via: `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}` };
  const socketOnly = fs.existsSync('/tmp/.X11-unix/X0');
  return { ok: false, via: null, socketOnly };
}

function assertDisplayAvailable() {
  const d = displayAvailable();
  if (!d.ok) {
    throw new NaverError(
      NAVER_EXIT.NO_DISPLAY,
      'headed 브라우저를 띄울 수 없습니다 (DISPLAY / WAYLAND_DISPLAY 둘 다 없음).\n'
      + (d.socketOnly
        ? '  + /tmp/.X11-unix/X0 소켓은 있지만 chromium은 $DISPLAY로 접속합니다. `export DISPLAY=:0` 을 시도하세요.\n'
        : '')
      + '  + WSL이라면 WSLg가 동작하는지 확인하세요.\n'
      + '  + GUI가 없는 환경에서는 네이버 로그인을 할 수 없습니다.',
    );
  }
  return d;
}

function profileDir() {
  return process.env.NAVER_PROFILE_DIR || DEFAULT_PROFILE_DIR;
}

function requireBlogId() {
  const id = (process.env.NAVER_BLOG_ID || '').trim();
  if (!id) {
    throw new NaverError(
      NAVER_EXIT.GENERAL,
      'NAVER_BLOG_ID가 설정되어 있지 않습니다 (.env). '
      + 'blog.naver.com/{여기} 의 블로그 아이디가 필요합니다 — '
      + '에디터 URL, 로그인 검증, 발행 후 URL 대조에 모두 씁니다.',
    );
  }
  return id;
}

/**
 * 영속 프로필 컨텍스트를 연다.
 *
 * storageState(쿠키/localStorage만 복원)가 아니라 launchPersistentContext를 쓰는 이유:
 * 네이버는 로그인 유지에 기기 식별 흔적을 함께 보므로, 매 실행 새 컨텍스트로 뜨면
 * "새로운 기기에서의 로그인"으로 인식되어 재인증·캡차가 재발할 확률이 높다.
 *
 * 트레이드오프: 영속 프로필은 동시 실행이 불가능하다(chromium SingletonLock).
 * lock 충돌은 조용히 넘기지 않고 명시적으로 실패시킨다.
 */
async function openContext({ headless = false, dir = profileDir() } = {}) {
  const { chromium } = requirePlaywright();
  assertBrowserInstalled();
  if (!headless) assertDisplayAvailable();

  fs.mkdirSync(dir, { recursive: true });

  try {
    return await chromium.launchPersistentContext(path.resolve(dir), {
      headless,
      viewport: { width: 1440, height: 960 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    if (/SingletonLock|ProcessSingleton|already (in use|running)/i.test(errFull(err))) {
      throw new NaverError(
        NAVER_EXIT.GENERAL,
        `네이버 프로필(${dir})이 이미 사용 중입니다. 다른 네이버 스크립트가 실행 중인지 확인하세요.\n`
        + `  + 남아 있는 프로세스가 없다면 ${path.join(dir, 'SingletonLock')} 을 지우고 재시도하세요.`,
      );
    }
    throw err;
  }
}

// "쿠키가 없다"와 "쿠키를 조회하지 못했다"를 같은 값으로 뭉개면, 로그인을 정상적으로
// 마친 사용자에게 5분 뒤 "로그인이 완료되지 않았습니다"라고 말하게 된다. 그러면
// 사용자는 로그인을 반복하며 캡차를 유발한다 — 영속 프로필까지 도입해 피하려던 상황이다.
async function hasLoginCookies(context) {
  let cookies;
  try {
    cookies = await context.cookies('https://www.naver.com');
  } catch (err) {
    // 가장 흔한 원인은 사용자가 로그인 대기 중 브라우저 창을 닫은 것이다.
    // GENERAL(1)로 내보내면 usage의 "1=인자 오류"와 겹쳐 조치로 연결되지 않고,
    // naver-doctor의 `fail(err.exitCode || SESSION)`이 11을 1로 강등시킨다.
    const closed = /Target (page, context or browser has been )?closed|browser has been closed|Session closed/i
      .test(errText(err));
    throw new NaverError(
      closed ? NAVER_EXIT.SESSION : NAVER_EXIT.GENERAL,
      `쿠키를 조회하지 못해 로그인 여부를 판정할 수 없습니다: ${errText(err)}\n`
      + (closed
        ? '  + 브라우저 창이 닫혔습니다. npm run naver:login 을 다시 실행하세요.'
        : '  + 브라우저 컨텍스트 문제일 수 있습니다. "로그인 안 됨"으로 간주하지 않습니다.'),
    );
  }
  const names = new Set(cookies.map((c) => c.name));
  return names.has('NID_AUT') && names.has('NID_SES');
}

/**
 * 로그인 완료를 감지한다.
 *
 * waitForNavigation은 로그인 실패 리로드도 "성공"으로 잡으므로 쓰지 않는다.
 * 대신 인증 쿠키가 생겼는지 폴링하고, 생기면 프로브 네비게이션으로 확정한다.
 */
async function establishSession(context, { blogId, timeoutMs = 5 * 60 * 1000 } = {}) {
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('브라우저에서 네이버 로그인을 완료해 주세요. (최대 5분 대기)');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await hasLoginCookies(context)) {
      console.log('인증 쿠키를 확인했습니다. 세션을 검증합니다...');
      await page.close();
      return assertLoggedIn(context, { blogId });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await page.close();
  throw new NaverError(
    NAVER_EXIT.SESSION,
    '로그인이 5분 안에 완료되지 않았습니다. 다시 시도하세요.',
  );
}

/**
 * 세션이 실제로 유효한지, 그리고 **NAVER_BLOG_ID와 같은 계정인지** 확인한다.
 *
 * 계정 확인이 중요한 이유: 프로필에 다른 계정이 로그인돼 있으면 남의 블로그에
 * 글을 쓰게 된다. 파일이 존재한다는 것은 세션이 유효하다는 뜻이 아니다.
 */
async function assertLoggedIn(context, { blogId } = {}) {
  const id = blogId || requireBlogId();
  const page = await context.newPage();
  try {
    try {
      await page.goto(editorUrl(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      // 타임아웃·DNS 실패를 그대로 던지면 exitCode가 없어서 호출자(naver-doctor)가
      // SESSION(11)로 강등한다. 그러면 정상 로그인 사용자에게 재로그인을 반복시켜
      // 캡차를 유발한다 — 이 파일이 영속 프로필까지 도입해 피하려던 상황이다.
      //
      // err.message를 무가드로 만지면 안 된다. 문자열 throw·undefined reject에서
      // TypeError가 나면 exitCode가 사라져 **결국 같은 강등이 다시 일어난다**.
      throw new NaverError(
        NAVER_EXIT.GENERAL,
        `에디터 페이지에 접속하지 못했습니다 (${editorUrl(id)}): ${errText(err)}\n`
        + '  + 네트워크·타임아웃 문제일 수 있습니다. 세션 만료와는 다르므로 재로그인이 답이 아닐 수 있습니다.',
      );
    }
    const finalUrl = page.url();

    if (/nid\.naver\.com|nidlogin/i.test(finalUrl)) {
      throw new NaverError(
        NAVER_EXIT.SESSION,
        `세션이 만료되었습니다 (로그인 페이지로 리다이렉트됨: ${finalUrl}).\n`
        + '  + npm run naver:login 을 다시 실행하세요.',
      );
    }
    if (!(await hasLoginCookies(context))) {
      throw new NaverError(
        NAVER_EXIT.SESSION,
        '네이버 인증 쿠키(NID_AUT/NID_SES)가 없습니다. npm run naver:login 을 실행하세요.',
      );
    }
    // 에디터 URL에 blogId가 들어가므로, 다른 계정이면 네이버가 리다이렉트하거나
    // 권한 오류 페이지를 준다. URL에 blogId가 남아 있는지로 1차 확인한다.
    if (!finalUrl.includes(id)) {
      throw new NaverError(
        NAVER_EXIT.SESSION,
        `NAVER_BLOG_ID(${id})의 에디터에 접근하지 못했습니다 (최종 URL: ${finalUrl}).\n`
        + '  + 프로필에 다른 계정이 로그인돼 있을 수 있습니다.\n'
        + '  + npm run naver:login 으로 올바른 계정에 로그인하세요.',
      );
    }
    return { blogId: id, url: finalUrl };
  } finally {
    await page.close().catch(() => {});
  }
}

// 감사·디버그용 스냅샷. **로그인 판정의 근거로 쓰지 않는다** — 파일 존재는
// 세션 유효를 뜻하지 않는다 (예전 구현이 정확히 그 실수를 했다).
async function saveSessionSnapshot(context, { blogId } = {}) {
  try {
    const state = await context.storageState();
    fs.writeFileSync(SESSION_SNAPSHOT, `${JSON.stringify({
      _comment: '감사/디버그용 스냅샷입니다. 로그인 판정에는 쓰이지 않습니다 (.naver-profile/이 실제 세션).',
      savedAt: new Date().toISOString(),
      blogId: blogId || null,
      storageState: state,
    }, null, 2)}\n`, 'utf8');
    return SESSION_SNAPSHOT;
  } catch (err) {
    console.warn(`[naver] 세션 스냅샷 저장 실패(무시): ${errText(err)}`);
    return null;
  }
}

module.exports = {
  DEFAULT_PROFILE_DIR,
  LOGIN_URL,
  SESSION_SNAPSHOT,
  assertBrowserInstalled,
  assertDisplayAvailable,
  assertLoggedIn,
  browserExecutable,
  displayAvailable,
  establishSession,
  hasLoginCookies,
  openContext,
  profileDir,
  requireBlogId,
  requirePlaywright,
};
