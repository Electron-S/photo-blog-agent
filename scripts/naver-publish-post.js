#!/usr/bin/env node
// 네이버 발행.
//
// 예전 구현은 `context.newPage()`로 **빈 about:blank 페이지**를 열고 "발행"
// 버튼을 찾았다. 에디터 상태는 브라우저 프로세스가 죽으면 사라지는 클라이언트
// 상태이고, 서버에 "현재 에디터를 발행하라"는 엔드포인트가 없으므로 이 구조는
// 원리적으로 성립하지 않는다.
//
// 대체 경로: naver-create-draft.js --publish (작성과 발행을 한 프로세스로).
// 임시저장 목록에서 글을 열어 발행하는 경로(--draft-title)는 목록 UI를 실물로
// 확인한 뒤에만 구현한다.

require('dotenv').config();

const { NAVER_EXIT, NaverError, reportNaverError } = require('../lib/naver-errors');
const { isVerified, verificationStatus } = require('../lib/naver-selectors');
const { errExitCode } = require('../lib/err-text');

function printUsage() {
  console.log('Usage: node naver-publish-post.js --draft-title "제목" [--visibility private|public]');
  console.log('');
  console.log('  임시저장 목록에서 제목이 정확히 일치하는 글을 열어 발행합니다.');
  console.log('  **아직 구현되지 않았습니다** — 임시저장 목록 UI가 실물로 확인되지 않았습니다.');
  console.log('');
  console.log('  지금은 대신 이 명령을 쓰세요:');
  console.log('    npm run naver:draft -- --html <draft.html> --title "제목" --publish --visibility private');
  console.log('');
  console.log('종료 코드: 1=인자 오류, 12=셀렉터 미확인');
  process.exit(1);
}

const FLAGS_WITH_VALUE = new Set(['--draft-title', '--visibility']);
const BOOLEAN_FLAGS = new Set(['--help', '-h']);

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) printUsage();

  // **알 수 없는 플래그를 조용히 무시하지 않는다.** 이 저장소의 다른 스크립트는
  // 전부 거부하는데 여기만 빠져 있었다 — `--bogus zzz --draft-title t`가 그대로
  // 통과했다. 발행 스크립트에서 오타가 무시되면 의도와 다른 글이 공개될 수 있다.
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--') && !a.startsWith('-')) continue;   // 값
    if (FLAGS_WITH_VALUE.has(a)) { i += 1; continue; }
    if (BOOLEAN_FLAGS.has(a)) continue;
    console.error(`Error: unknown option ${a}`);
    printUsage();
  }

  // 무인자 "현재 에디터 발행"은 폐기했다. 어떤 글을 발행할지 지정하지 않으면
  // 엉뚱한 임시저장이 공개될 수 있다.
  const idx = argv.indexOf('--draft-title');
  const draftTitle = idx !== -1 ? argv[idx + 1] : null;
  if (!draftTitle || draftTitle.startsWith('--')) {
    console.error('Error: --draft-title이 필요합니다. 어떤 임시저장을 발행할지 명시해야 합니다.');
    console.error('  (예전의 무인자 "현재 에디터 발행"은 원리적으로 동작하지 않아 폐기했습니다.)');
    printUsage();
  }

  throw new NaverError(
    NAVER_EXIT.SELECTOR,
    '임시저장 재개 발행은 아직 구현되지 않았습니다.\n'
    + `  + ${verificationStatus()}\n`
    + '  + 임시저장 목록 UI를 npm run naver:inspect 로 확인한 뒤에 구현합니다.\n'
    + '  + 지금은 작성과 발행을 한 번에 하세요:\n'
    + '      npm run naver:draft -- --html <draft.html> --title "제목" --publish --visibility private\n'
    + `  + (셀렉터 확인 상태: ${isVerified() ? '확인됨' : '미확인'})`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    reportNaverError(err);
    process.exit(errExitCode(err) || 1);
  }
}
