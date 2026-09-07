#!/usr/bin/env node
// 네이버 세션 수립.
//
// 예전 구현은 headless로 브라우저를 띄우고 "브라우저에서 로그인을 완료해주세요"라며
// 5분을 기다렸다. 창이 안 뜨므로 로그인이 원리적으로 불가능했고, 네이버가 로그인
// 페이지를 한 번 리로드하기만 해도 waitForNavigation이 반응해 **"로그인 성공"을
// 출력**했다. 그렇게 저장된 .naver-session.json은 인증 근거가 아니라서 doctor는
// 계속 "세션 없음"을 냈고, 사용자는 성공과 실패 사이에 갇혔다.
//
// 지금은 headed 강제 + 인증 쿠키 폴링 + 실제 에디터 접근 확인까지 마쳐야
// 성공으로 본다.

require('dotenv').config();

const { NAVER_EXIT, reportNaverError } = require('../lib/naver-errors');
const { errExitCode } = require('../lib/err-text');
const {
  assertDisplayAvailable, establishSession, openContext, profileDir,
  requireBlogId, saveSessionSnapshot,
} = require('../lib/naver-browser');

function printUsage() {
  console.log('Usage: node naver-login-setup.js');
  console.log('');
  console.log('네이버 로그인 창을 띄우고, 로그인이 실제로 완료됐는지 확인한 뒤');
  console.log('.naver-profile/ 에 세션을 유지합니다.');
  console.log('');
  console.log('종료 코드: 0=성공, 1=인자/설정 오류, 10=playwright·브라우저 없음, 11=로그인 미완료, 17=headed 불가');
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length) {
    console.error(`Error: 인자를 받지 않습니다. (받음: ${argv.join(', ')})`);
    printUsage();
  }

  const blogId = requireBlogId();
  // 디스플레이가 없으면 5분 기다렸다 타임아웃 내지 말고 즉시 거부한다.
  const display = assertDisplayAvailable();

  console.log('네이버 블로그 로그인 설정을 시작합니다.');
  console.log(`  블로그 ID: ${blogId}`);
  console.log(`  디스플레이: ${display.via}`);
  console.log(`  프로필: ${profileDir()}`);
  console.log('');
  console.log('브라우저 창이 열리면 네이버 아이디/비밀번호로 직접 로그인해 주세요.');
  console.log('');

  const context = await openContext({ headless: false });
  try {
    const info = await establishSession(context, { blogId });
    const snapshot = await saveSessionSnapshot(context, { blogId: info.blogId });

    console.log('');
    console.log(`로그인 확인 완료 (blogId=${info.blogId}).`);
    console.log(`세션은 ${profileDir()}/ 에 유지됩니다.`);
    if (snapshot) console.log(`감사용 스냅샷: ${snapshot} (로그인 판정에는 쓰이지 않습니다)`);
    console.log('');
    console.log('다음 단계:');
    console.log('  npm run naver:doctor                          # 전 항목 통과 확인');
    console.log('  npm run naver:inspect -- --dump --keep-open   # 셀렉터 실물 확인');
  } finally {
    // process.exit로 빠져나가면 이 정리가 실행되지 않아 chromium이 남는다.
    // 그래서 오류는 throw로 올려 main().catch가 처리하게 한다.
    await context.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    reportNaverError(err);
    process.exit(errExitCode(err) || NAVER_EXIT.GENERAL);
  });
}
