// 셀렉터 실패 시 진단 자료를 남긴다.
//
// 네이버 DOM은 예고 없이 바뀐다. "찾지 못했다"만 출력하면 사람이 원인을 알 수
// 없으므로, 실패 순간의 스크린샷·HTML·프레임 트리를 tmp/naver-debug/에 덤프하고
// 에러 메시지에 그 경로를 실어 보낸다.
//
// tmp/는 gitignore 대상이라 계정 정보가 담긴 HTML이 커밋될 위험이 없다.
// 모든 파일 쓰기에 'utf8'을 명시한다 — 한국어 DOM 덤프가 깨지면 디버깅이 불가능하다.

const fs = require('fs');
const path = require('path');
const { errText } = require('./err-text');

function timestamp(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

function describeFrames(page) {
  try {
    return page.frames().map((f, i) => {
      let depth = 0;
      for (let p = f.parentFrame(); p; p = p.parentFrame()) depth += 1;
      return `${String(i).padStart(2, '0')} depth=${depth} name=${JSON.stringify(f.name())} url=${f.url()}`;
    }).join('\n');
  } catch (err) {
    return `프레임 트리 수집 실패: ${errText(err)}`;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{key: string, candidates?: string[], frame?: import('playwright').Frame, dir?: string, extra?: object}} opts
 * @returns {Promise<string|null>} 덤프 디렉터리 경로
 */
async function dumpFailure(page, opts = {}) {
  // 호출부는 전부 "NaverError를 만들기 전에" 이 함수를 await한다. 여기서 예외가
  // 새어 나가면 exit 12·후보 목록·조치 안내가 통째로 사라지고 exit 1이 된다
  // (진단이 진단을 파괴한다). 무슨 일이 있어도 던지지 않는다.
  try {
    return await dumpFailureUnsafe(page, opts);
  } catch (err) {
    console.warn(`[naver-debug] 덤프 자체가 실패했습니다(원래 오류를 가리지 않고 진행): ${errText(err)}`);
    return null;
  }
}

async function dumpFailureUnsafe(page, opts = {}) {
  const { key = 'unknown', candidates = [], frame = null, dir = path.join('tmp', 'naver-debug'), extra = {} } = opts;
  const outDir = path.join(dir, `${timestamp()}-${key}`);

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    console.warn(`[naver-debug] 덤프 디렉터리 생성 실패 (${outDir}): ${errText(err)}`);
    return null;
  }

  // 쓰기가 전부 실패했는데 경로를 돌려주면, 호출자가 "진단 자료: <dir>"을 출력하고
  // 사용자는 **빈 폴더**를 연다. 디렉터리가 이미 있고 쓰기 권한만 없으면
  // mkdirSync(recursive)는 성공하므로 위 가드에도 안 걸린다.
  const failures = [];
  let written = 0;
  // **"쓰기 성공 건수"가 아니라 "실제로 캡처된 진단"을 센다.** page.* 전부가
  // 던지는 상태(세션이 끊긴 뒤)에서도 screenshot-error.txt·page-error.txt·
  // frames.txt는 정상적으로 **쓰이므로** written=4가 되어 "진단 자료를
  // 남겼습니다"가 나갔다. 사용자는 must()의 안내를 보고 폴더를 열지만
  // 스크린샷도 HTML도 프레임 트리도 없다.
  let captured = 0;
  const write = (name, content) => {
    try {
      fs.writeFileSync(path.join(outDir, name), content, 'utf8');
      written += 1;
    } catch (err) {
      failures.push(`${name}: ${errText(err)}`);
      console.warn(`[naver-debug] ${name} 쓰기 실패: ${errText(err)}`);
    }
  };

  // 스크린샷이 실패해도 나머지 덤프는 남겨야 한다.
  try {
    await page.screenshot({ path: path.join(outDir, 'screenshot.png'), fullPage: true });
    captured += 1;
  } catch (err) {
    write('screenshot-error.txt', `스크린샷 실패: ${errText(err)}\n`);
  }

  try {
    write('page.html', await page.content());
    captured += 1;
  } catch (err) {
    write('page-error.txt', `top document 수집 실패: ${errText(err)}\n`);
  }

  if (frame) {
    try {
      write('frame.html', await frame.content());
      captured += 1;
    } catch (err) {
      write('frame-error.txt', `frame 수집 실패: ${errText(err)}\n`);
    }
  }

  const frameTree = describeFrames(page);
  write('frames.txt', `${frameTree}\n`);
  if (!/^프레임 트리 수집 실패/.test(frameTree)) captured += 1;

  let playwrightVersion = 'unknown';
  try {
    playwrightVersion = require('playwright/package.json').version;
  } catch { /* 설치 안 된 경우는 여기 오지 않는다 */ }

  const { VERIFIED_AT, PLAYWRIGHT_VERIFIED } = require('./naver-selectors');
  write('context.json', `${JSON.stringify({
    key,
    candidates,
    url: (() => { try { return page.url(); } catch { return null; } })(),
    frameUrl: frame ? (() => { try { return frame.url(); } catch { return null; } })() : null,
    node: process.version,
    playwright: playwrightVersion,
    selectorsVerifiedAt: VERIFIED_AT,
    selectorsPlaywrightVerified: PLAYWRIGHT_VERIFIED,
    capturedAt: new Date().toISOString(),
    ...extra,
  }, null, 2)}\n`);

  if (written === 0) {
    console.error(`[naver-debug] 덤프를 한 건도 쓰지 못했습니다 (${outDir}):`);
    for (const f of failures) console.error(`  + ${f}`);
    return null;
  }
  if (captured === 0) {
    // 파일은 쓰였지만 내용이 전부 "…수집 실패"다. 경로를 돌려주면 사용자가
    // 빈 폴더를 여는 것과 같으므로, 무엇을 봐야 하는지 알려주고 null을 준다.
    console.error(`[naver-debug] 진단을 하나도 캡처하지 못했습니다 (${outDir}에 오류 기록만 있습니다).`);
    console.error('  + 세션이 끊겼거나 브라우저가 닫힌 뒤일 수 있습니다 — npm run naver:doctor로 확인하세요.');
    return null;
  }
  if (failures.length) {
    console.error(`[naver-debug] 진단 자료를 남겼습니다 (일부 실패 ${failures.length}건): ${outDir}`);
    for (const f of failures) console.error(`  + ${f}`);
  } else {
    console.error(`[naver-debug] 진단 자료를 남겼습니다: ${outDir}`);
  }
  return outDir;
}

module.exports = { describeFrames, dumpFailure, timestamp };
