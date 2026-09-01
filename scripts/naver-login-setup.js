const { launchBrowser, loginToNaver, saveSessionState } = require('../lib/naver-blog');

async function main() {
  console.log('네이버 블로그 로그인 설정을 시작합니다.');
  console.log('');
  console.log('다음 단계가 진행됩니다:');
  console.log('1. 브라우저 창이 열릴 때까지 잠시 기다려주세요.');
  console.log('2. 열린 브라우저에서 네이버 아이디/비밀번호로 로그인해주세요.');
  console.log('3. 로그인 완료 후 자동으로 세션이 저장됩니다.');
  console.log('');
  console.log('⏱️  로그인은 최대 5분 이내에 완료해주세요.');
  console.log('');

  const browser = await launchBrowser();

  try {
    const storageState = await loginToNaver(browser);
    await saveSessionState(storageState);

    console.log('');
    console.log('✅ 로그인 성공! 세션이 저장되었습니다.');
    console.log('이제 다음 명령으로 글을 작성할 수 있습니다:');
    console.log('  npm run naver:draft -- --title "제목" --content ./draft.html');
  } catch (err) {
    console.error('❌ 로그인 실패:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(err.exitCode || 1);
});
