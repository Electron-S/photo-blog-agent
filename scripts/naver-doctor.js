#!/usr/bin/env node
// 네이버 자동화 프리플라이트.
//
// "첫 줄에서 크래시"를 "무엇을 해야 하는지 알려주는 실패"로 바꾼다.
// 항목별로 OK/FAIL을 표로 보여주고, 가장 먼저 조치해야 할 것의 exit 코드를 낸다.

require('dotenv').config();

const fs = require('fs');
const { NAVER_EXIT, reportNaverError } = require('../lib/naver-errors');
const { isVerified, verificationStatus } = require('../lib/naver-selectors');
const {
  assertLoggedIn, browserExecutable, displayAvailable, openContext, profileDir, requirePlaywright,
} = require('../lib/naver-browser');

function printUsage() {
  console.log('Usage: node naver-doctor.js [--headless-smoke]');
  console.log('');
  console.log('  --headless-smoke  headed 창 대신 headless로만 브라우저 기동을 확인 (CI/원격용)');
  console.log('');
  console.log('종료 코드: 0=전부 통과, 10=playwright/브라우저 없음, 11=세션 없음/만료, 17=headed 불가, 1=기타');
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
    record('playwright 모듈', false, 'npm install --include=optional');
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
    record('디스플레이 (headed 가능)', d.ok, d.ok ? d.via : 'DISPLAY/WAYLAND_DISPLAY/X 소켓 없음 — WSLg 확인 필요');
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
      record(`브라우저 기동 (${headlessSmoke ? 'headless' : 'headed'})`, false, err.message.split('\n')[0]);
      fail(headlessSmoke ? NAVER_EXIT.MISSING_PLAYWRIGHT : NAVER_EXIT.NO_DISPLAY);
    }
  }

  // 5. NAVER_BLOG_ID
  const blogId = (process.env.NAVER_BLOG_ID || '').trim();
  record('NAVER_BLOG_ID', Boolean(blogId), blogId || '.env에 설정 필요 (blog.naver.com/{여기})');
  if (!blogId) fail(NAVER_EXIT.GENERAL);

  // 6. 프로필 + 세션 유효성
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
      record('네이버 세션', false, err.message.split('\n')[0]);
      fail(err.exitCode || NAVER_EXIT.SESSION);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // 7. 셀렉터 확인 여부 — 경고일 뿐 실패는 아니다
  record('셀렉터 실물 확인', isVerified(), verificationStatus());

  console.log('');
  if (firstFailure === null) {
    console.log(isVerified()
      ? '전부 통과. 네이버 발행을 진행할 수 있습니다.'
      : '기동 조건은 통과했습니다. 다만 셀렉터가 미검증이므로 `npm run naver:inspect`를 먼저 실행하세요.');
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
