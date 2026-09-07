#!/usr/bin/env node
// 네이버 자동화 프리플라이트.
//
// "첫 줄에서 크래시"를 "무엇을 해야 하는지 알려주는 실패"로 바꾼다.
// 항목별로 OK/FAIL을 표로 보여주고, 가장 먼저 조치해야 할 것의 exit 코드를 낸다.

require('dotenv').config();

const fs = require('fs');
const { NAVER_EXIT, reportNaverError } = require('../lib/naver-errors');
const { errFull, errText } = require('../lib/err-text');
const { isVerified, verificationStatus } = require('../lib/naver-selectors');
const {
  assertLoggedIn, browserExecutable, displayAvailable, openContext, profileDir, requirePlaywright,
} = require('../lib/naver-browser');

function printUsage() {
  console.log('Usage: node naver-doctor.js [--headless-smoke]');
  console.log('');
  console.log('  --headless-smoke  headed 창 대신 headless로만 브라우저 기동을 확인 (CI/원격용)');
  console.log('');
  console.log('종료 코드: 0=전부 통과(발행 가능), 10=playwright/브라우저 없음, 11=세션 없음/만료,');
  console.log('           12=셀렉터 실물 미검증, 17=headed 불가, 1=기타');
  process.exit(1);
}

const rows = [];
function record(name, ok, detail) {
  rows.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a !== '--headless-smoke') {
      console.error(`Error: unknown option ${a}`);
      printUsage();
    }
  }
  const headlessSmoke = argv.includes('--headless-smoke');

  console.log('네이버 자동화 프리플라이트\n');
  let firstFailure = null;
  const fail = (code) => { if (firstFailure === null) firstFailure = code; };

  // 1. playwright 모듈
  let pw = null;
  try {
    pw = requirePlaywright();
    record('playwright 모듈', true, `v${require('playwright/package.json').version}`);
  } catch (err) {
    // 원인을 버리고 항상 "설치하라"고만 하면, 이미 설치됐는데 로드가 깨진 경우
    // (ABI 불일치 등) 사용자가 같은 명령을 반복하며 원인을 영영 못 본다.
    record('playwright 모듈', false, `${errText(err)} — npm install --include=optional`);
    fail(NAVER_EXIT.MISSING_PLAYWRIGHT);
  }

  // 2. 브라우저 바이너리
  let browserOk = false;
  if (pw) {
    const b = browserExecutable();
    browserOk = b.exists;
    record('chromium 바이너리', b.exists, b.exists ? b.path : `없음 (${b.path}) — npx playwright install chromium`);
    if (!b.exists) fail(NAVER_EXIT.MISSING_PLAYWRIGHT);
  }

  // 3. 디스플레이
  const d = displayAvailable();
  if (headlessSmoke) {
    record('디스플레이 (headed 가능)', true, '--headless-smoke로 건너뜀');
  } else {
    record('디스플레이 (headed 가능)', d.ok, d.ok ? d.via
      : `DISPLAY/WAYLAND_DISPLAY 없음${d.socketOnly ? ' (X 소켓만 있음 — export DISPLAY=:0 시도)' : ''} — WSLg 확인 필요`);
    if (!d.ok) fail(NAVER_EXIT.NO_DISPLAY);
  }

  // 4. 실제 창 기동 스모크 — 여기가 M1이다. 창이 안 뜨면 이후 단계가 전부 무의미하다.
  let smokeOk = false;
  if (browserOk && (headlessSmoke || d.ok)) {
    try {
      const { chromium } = pw;
      const browser = await chromium.launch({ headless: headlessSmoke });
      const page = await browser.newPage();
      await page.setContent('<h1>naver-doctor smoke</h1>');
      if (!headlessSmoke) {
        console.log('     (브라우저 창이 5초간 표시됩니다 — 화면에 보이는지 확인하세요)');
        await page.waitForTimeout(5000);
      }
      await browser.close();
      smokeOk = true;
      record(`브라우저 기동 (${headlessSmoke ? 'headless' : 'headed'})`, true);
    } catch (err) {
      // exit 코드를 모드가 아니라 **원인**으로 정한다. 시스템 라이브러리 결손을
      // 17(headed 불가 → WSLg 확인)로 보내면 실제 조치(install-deps)와 무관한
      // 안내가 나간다.
      const full = errFull(err);
      const msg = errText(err);
      const missingLib = /error while loading shared libraries|cannot open shared object|Host system is missing dependencies|\.so[.0-9]*: cannot open/i.test(full);
      const noDisplay = /Missing X server|cannot open display|DISPLAY|Target page, context or browser has been closed/i.test(full);
      // 분류되지 않은 실패를 **모드**로 코드를 정해 내보내지 않는다. 폴백이
      // headless면 10(=playwright/브라우저 없음), headed면 17(=WSLg 확인)이었는데,
      // 바로 위 1·2행이 playwright·chromium을 OK로 찍은 직후라 자기모순이었다.
      // 컨테이너/CI에서 흔한 "Running as root without --no-sandbox" 같은 실패가
      // 정확히 여기로 온다 — 조치가 install도 WSLg도 아니다.
      const hint = missingLib ? ' — sudo npx playwright install-deps chromium' : '';
      record(`브라우저 기동 (${headlessSmoke ? 'headless' : 'headed'})`, false, msg + hint);
      if (missingLib) fail(NAVER_EXIT.MISSING_PLAYWRIGHT);
      else if (noDisplay && !headlessSmoke) fail(NAVER_EXIT.NO_DISPLAY);
      else {
        console.log('        (원인을 분류하지 못했습니다 — 위 메시지가 유일한 단서입니다)');
        fail(NAVER_EXIT.GENERAL);
      }
    }
  }

  // 5. NAVER_BLOG_ID
  const blogId = (process.env.NAVER_BLOG_ID || '').trim();
  record('NAVER_BLOG_ID', Boolean(blogId), blogId || '.env에 설정 필요 (blog.naver.com/{여기})');
  if (!blogId) fail(NAVER_EXIT.GENERAL);

  // 6. 공개 발행 안전장치 상태 (실패가 아니라 현재 상태 보고)
  const allowPublic = process.env.NAVER_ALLOW_PUBLIC === '1';
  record('공개 발행 허용 (NAVER_ALLOW_PUBLIC)', true, allowPublic
    ? '1 — --visibility public 사용 가능'
    : '미설정 — --visibility public은 exit 18로 거부됩니다 (기본 private는 정상 동작)');

  // 7. 프로필 + 세션 유효성
  const dir = profileDir();
  const profileExists = fs.existsSync(dir);
  if (!profileExists) {
    record('네이버 프로필', false, `${dir} 없음 — npm run naver:login`);
    fail(NAVER_EXIT.SESSION);
  } else if (!smokeOk || !blogId) {
    record('네이버 세션', false, '앞 단계 실패로 확인 불가');
    fail(NAVER_EXIT.SESSION);
  } else {
    let context = null;
    try {
      context = await openContext({ headless: true, dir });
      const info = await assertLoggedIn(context, { blogId });
      record('네이버 세션', true, `blogId=${info.blogId}`);
    } catch (err) {
      // 첫 줄만 쓰면 naver-browser가 붙인 조치 안내("세션 만료와는 다르므로
      // 재로그인이 답이 아닐 수 있습니다")가 사라지고, 행 이름이 "네이버 세션 —
      // FAIL"이라 사용자는 결국 재로그인을 시도한다. GENERAL(1)을 고른 이유 자체가
      // 그 오안내를 막는 것이었으므로, 남은 줄을 들여쓰기해 그대로 보여준다.
      record('네이버 세션', false, errText(err));
      for (const line of errFull(err).split('\n').slice(1)) {
        if (line.trim()) console.log(`      ${line.trim()}`);
      }
      fail(err.exitCode || NAVER_EXIT.SESSION);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // 8. 셀렉터 확인 여부 — **실패로 센다.**
  // 예전에는 경고만 하고 exit 0이었는데, 셀렉터 미검증 상태에서 실제 발행 경로는
  // 무조건 exit 12로 죽는다. `npm run naver:doctor && npm run naver:draft` 체이닝에서
  // doctor가 게이트 역할을 전혀 못 했다.
  record('셀렉터 실물 확인', isVerified(), verificationStatus());
  if (!isVerified()) fail(NAVER_EXIT.SELECTOR);

  console.log('');
  if (firstFailure === null) {
    console.log('전부 통과. 네이버 발행을 진행할 수 있습니다.');
    return;
  }
  console.log(`가장 먼저 조치할 항목의 exit 코드: ${firstFailure}`);
  process.exit(firstFailure);
}

if (require.main === module) {
  main().catch((err) => {
    reportNaverError(err);
    process.exit(err.exitCode || 1);
  });
}
