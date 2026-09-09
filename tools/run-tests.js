#!/usr/bin/env node
// 테스트 러너. `node --test`에 **파일 목록을 명시적으로** 넘긴다.
//
// 왜 필요한가 — 다른 방법이 전부 깨진다:
//
//   `node --test test/`   Node 20은 디렉터리를 재귀 탐색하지만 **Node 22는 인자를
//                         파일로 해석**해 `Cannot find module '.../test'`로 죽는다.
//                         (CI를 처음 돌려서 알았다. 그 전까지 Node 22 leg는 한 번도
//                          실행된 적이 없었다.)
//   `node --test`          인자를 생략하면 Node의 기본 탐색 규칙이 적용되는데, 그것이
//                         `scripts/test-blogger-api.js`·`scripts/test-github-assets.js`를
//                         테스트로 잡는다 — **실제 Blogger API를 호출하고 GitHub에
//                         업로드하는 수동 점검 스크립트다.** 절대 쓸 수 없다.
//   `node --test test/*.test.js`
//                         Unix 셸은 확장하지만 npm이 Windows에서 쓰는 `cmd`는
//                         확장하지 않아 리터럴 문자열이 넘어간다.
//   `node --test "test/**/*.test.js"`
//                         Node 22는 글롭을 이해하지만 Node 20은 못 한다.
//
// 파일 목록을 직접 만들어 넘기면 Node 20/22 × Linux/Windows 네 조합에서 같게 돈다
// (실측 확인). 추가 인자는 그대로 전달하므로 `--test-name-pattern` 등도 쓸 수 있다.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

// test/ 하위의 *.test.js만 (test/fixtures/·test/support/ 같은 보조 파일은 제외).
function findTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // fixtures는 테스트가 읽는 데이터다 — 실행 대상이 아니다.
      if (entry.name === 'fixtures') continue;
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

const files = findTestFiles(TEST_DIR);
if (files.length === 0) {
  // **조용히 통과하지 않는다.** 파일을 못 찾으면 `node --test`가 0건으로 성공하고
  // CI가 초록으로 끝난다 — 테스트가 하나도 안 돌았는데 통과로 읽히는 상태다.
  console.error(`run-tests: ${TEST_DIR} 에서 *.test.js를 찾지 못했습니다.`);
  console.error('  테스트가 0건인 채로 성공하지 않도록 여기서 중단합니다.');
  process.exit(1);
}

// test-preload는 항상 넣는다 (sharp 파일 캐시를 끈다 — Windows 정리 훅 EPERM 방지).
// CLOCK_OFFSET_MS가 있으면 시계 shim도 함께 (npm run test:clock).
const preload = ['--require', path.join(__dirname, 'test-preload.js')];
if (process.env.CLOCK_OFFSET_MS) {
  preload.push('--require', path.join(__dirname, 'clock-shim.js'));
}

const args = ['--test', ...preload, ...process.argv.slice(2), ...files];
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });

if (r.error) {
  console.error(`run-tests: 테스트 프로세스를 시작할 수 없습니다: ${r.error.message}`);
  process.exit(1);
}
// 시그널로 죽은 경우 status는 null이다 — 0으로 떨어뜨려 성공으로 읽히면 안 된다.
process.exit(r.status === null ? 1 : r.status);
