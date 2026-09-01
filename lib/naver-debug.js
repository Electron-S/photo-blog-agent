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
    return `프레임 트리 수집 실패: ${err.message}`;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{key: string, candidates?: string[], frame?: import('playwright').Frame, dir?: string, extra?: object}} opts
 * @returns {Promise<string|null>} 덤프 디렉터리 경로
 */
async function dumpFailure(page, opts = {}) {
  const { key = 'unknown', candidates = [], frame = null, dir = path.join('tmp', 'naver-debug'), extra = {} } = opts;
  const outDir = path.join(dir, `${timestamp()}-${key}`);

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    console.warn(`[naver-debug] 덤프 디렉터리 생성 실패 (${outDir}): ${err.message}`);
    return null;
  }

  const write = (name, content) => {
    try {
      fs.writeFileSync(path.join(outDir, name), content, 'utf8');
    } catch (err) {
      console.warn(`[naver-debug] ${name} 쓰기 실패: ${err.message}`);
    }
  };

  // 스크린샷이 실패해도 나머지 덤프는 남겨야 한다.
  try {
    await page.screenshot({ path: path.join(outDir, 'screenshot.png'), fullPage: true });
  } catch (err) {
    write('screenshot-error.txt', `스크린샷 실패: ${err.message}\n`);
  }

  try {
    write('page.html', await page.content());
  } catch (err) {
    write('page-error.txt', `top document 수집 실패: ${err.message}\n`);
  }

  if (frame) {
    try {
      write('frame.html', await frame.content());
    } catch (err) {
      write('frame-error.txt', `frame 수집 실패: ${err.message}\n`);
    }
  }

  write('frames.txt', `${describeFrames(page)}\n`);

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

  console.error(`[naver-debug] 진단 자료를 남겼습니다: ${outDir}`);
  return outDir;
}

module.exports = { describeFrames, dumpFailure, timestamp };
