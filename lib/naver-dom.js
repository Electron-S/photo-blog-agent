// 에디터 DOM 접근 헬퍼.
//
// 핵심 원칙: **silent skip 금지.** 예전 구현은 `if (await x.isVisible())`로
// 감싸서, 요소를 못 찾으면 조용히 건너뛰고 "성공"을 반환했다. 이미지가 하나도
// 안 올라간 글이 정상 종료로 끝나는 구조였다. 여기서는 못 찾으면 덤프를 남기고
// exit 12로 죽는다.

const { NAVER_EXIT, NaverError } = require('./naver-errors');
const { SELECTORS, NAVER_IMAGE_HOSTS } = require('./naver-selectors');
const { dumpFailure } = require('./naver-debug');

const DEFAULT_TIMEOUT = 10000;

async function firstMatch(scope, candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = [];
  do {
    lastCount = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const loc = scope.locator(candidates[i]);
      let count = 0;
      try {
        count = await loc.count();
      } catch { count = 0; }
      lastCount.push(count);
      if (count > 0) return { locator: loc.first(), index: i, count, counts: lastCount };
    }
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  return { locator: null, index: -1, count: 0, counts: lastCount };
}

/**
 * 후보 배열에서 첫 매칭을 찾는다. 못 찾으면 덤프 후 exit 12.
 * 매칭된 후보 인덱스를 로그로 남긴다 — 0이 아니면 1순위 셀렉터가 drift한 것이라
 * DOM 변경의 조기 경보가 된다.
 */
async function must(scope, spec, { key, page, frame, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const candidates = Array.isArray(spec) ? spec : spec.candidates;
  const found = await firstMatch(scope, candidates, timeoutMs);

  if (!found.locator) {
    const dumpDir = page ? await dumpFailure(page, { key, candidates, frame }) : null;
    throw new NaverError(
      NAVER_EXIT.SELECTOR,
      `"${key}" 요소를 찾지 못했습니다. 네이버 DOM이 바뀌었을 수 있습니다.\n`
      + `  + 시도한 후보: ${candidates.join(' | ')}\n`
      + (dumpDir ? `  + 진단 자료: ${dumpDir}\n` : '')
      + '  + `npm run naver:inspect -- --dump --keep-open`으로 실물을 확인한 뒤\n'
      + '    lib/naver-selectors.js의 후보를 갱신하세요.',
      { key, candidates, dumpDir },
    );
  }

  if (found.index > 0) {
    console.warn(`[selector] ${key} → candidate[${found.index}] 매칭 (1순위 셀렉터가 drift했을 수 있습니다)`);
  }
  if (found.count > 1) {
    console.warn(`[selector] ${key} → ${found.count}개 매칭. 첫 번째를 사용합니다 (모호할 수 있음).`);
  }
  return found.locator;
}

/**
 * 없을 수도 있는 요소. **호출부가 null을 명시적으로 분기 처리하는 곳에서만** 쓴다.
 * (시작 모달처럼 "없는 것이 정상 경로"인 경우)
 */
async function tryFind(scope, spec, { timeoutMs = 1500 } = {}) {
  const candidates = Array.isArray(spec) ? spec : spec.candidates;
  const found = await firstMatch(scope, candidates, timeoutMs);
  return found.locator;
}

/**
 * 에디터가 들어 있는 Frame을 찾는다.
 *
 * frameLocator('#mainFrame') 단독으로는 부족하다 — iframe id가 바뀌거나
 * 최상위에 직접 뜨는 경우를 못 잡는다. 반환 타입도 FrameLocator가 아니라
 * Frame이어야 한다 (사후 검증에 evaluate/content가 필요한데 FrameLocator엔 없다).
 */
async function resolveEditorFrame(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const { urlPattern, rootCandidates } = SELECTORS.frame;

  do {
    // 1) 최상위 문서에 에디터 루트가 있으면 iframe이 아니다
    const top = page.mainFrame();
    for (const sel of rootCandidates) {
      try {
        if (await top.locator(sel).count() > 0) return top;
      } catch { /* 네비게이션 중일 수 있다 */ }
    }

    // 2) 프레임 순회 — URL이 맞고 그 안에 에디터 루트가 있는 프레임
    for (const f of page.frames()) {
      if (f === top) continue;
      let url = '';
      try { url = f.url(); } catch { continue; }
      if (!urlPattern.test(url)) continue;
      for (const sel of rootCandidates) {
        try {
          if (await f.locator(sel).count() > 0) return f;
        } catch { /* 프레임이 사라졌을 수 있다 */ }
      }
    }

    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < deadline);

  const dumpDir = await dumpFailure(page, { key: 'editorFrame', candidates: rootCandidates });
  throw new NaverError(
    NAVER_EXIT.SELECTOR,
    '에디터 프레임을 찾지 못했습니다.\n'
    + `  + 최상위와 모든 iframe에서 ${rootCandidates.join(' | ')} 를 찾지 못했습니다.\n`
    + (dumpDir ? `  + 진단 자료(프레임 트리 포함): ${dumpDir}\n` : '')
    + '  + 로그인 페이지로 리다이렉트됐을 수도 있습니다 — npm run naver:doctor로 세션을 확인하세요.',
    { dumpDir },
  );
}

/**
 * 진입 시 뜨는 모달을 처리한다.
 *
 * "작성 중인 글이 있습니다" 복구 팝업이 떠 있으면 이후 **모든 클릭이 조용히
 * 아무 데도 안 간다** — 예전 구현이 무너질 1순위 후보였다.
 * 알려진 모달은 닫고, 모르는 오버레이가 남아 있으면 exit 12로 실패한다.
 * "모달이 없으면 통과, 모르는 모달이면 실패"가 핵심이다.
 */
async function dismissStartupModals(page, frame) {
  for (const modal of SELECTORS.startupModals) {
    for (const scope of [page, frame]) {
      if (!scope) continue;
      const container = await tryFind(scope, modal.container, { timeoutMs: 800 });
      if (!container) continue; // 없는 것이 정상 경로다
      let visible = false;
      try { visible = await container.isVisible(); } catch { visible = false; }
      if (!visible) continue;

      console.log(`[modal] ${modal.description} 감지 — 닫는 중`);
      const btn = await tryFind(scope, modal.dismiss, { timeoutMs: 2000 });
      if (!btn) {
        const dumpDir = await dumpFailure(page, { key: `modal-${modal.key}`, candidates: modal.dismiss, frame });
        throw new NaverError(
          NAVER_EXIT.SELECTOR,
          `${modal.description}이 떠 있는데 닫기 버튼을 찾지 못했습니다. `
          + '이 상태로는 이후 모든 클릭이 무효가 됩니다.\n'
          + (dumpDir ? `  + 진단 자료: ${dumpDir}` : ''),
          { dumpDir },
        );
      }
      await btn.click();
      await page.waitForTimeout(300);
    }
  }

  // 레지스트리에 없는 오버레이가 화면을 덮고 있으면 실패한다.
  for (const sel of SELECTORS.overlayProbe) {
    let n = 0;
    try { n = await page.locator(`${sel}:visible`).count(); } catch { n = 0; }
    if (n > 0) {
      const dumpDir = await dumpFailure(page, { key: 'unknown-overlay', candidates: [sel], frame });
      throw new NaverError(
        NAVER_EXIT.SELECTOR,
        `알 수 없는 오버레이가 화면을 덮고 있습니다 (${sel}). 이 상태로는 클릭이 무효가 됩니다.\n`
        + '  + lib/naver-selectors.js의 startupModals에 이 모달을 등록하세요.\n'
        + (dumpDir ? `  + 진단 자료: ${dumpDir}` : ''),
        { dumpDir },
      );
    }
  }
}

async function countImages(frame) {
  for (const sel of SELECTORS.imageComponent.candidates) {
    try {
      const n = await frame.locator(sel).count();
      if (n > 0) return n;
    } catch { /* 다음 후보 */ }
  }
  return 0;
}

// 마지막 이미지의 src가 네이버 CDN인지 — "실제로 서버에 올라갔다"의 유일한 증거.
// blob:/data:면 아직 클라이언트 메모리에만 있다.
async function lastImageSrc(frame) {
  for (const sel of SELECTORS.imageElement.candidates) {
    try {
      const loc = frame.locator(sel);
      const n = await loc.count();
      if (n === 0) continue;
      return await loc.nth(n - 1).getAttribute('src');
    } catch { /* 다음 후보 */ }
  }
  return null;
}

function isNaverHostedImage(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^(blob:|data:)/i.test(src)) return false;
  return NAVER_IMAGE_HOSTS.some((re) => re.test(src));
}

// 이미지 삽입 후 caret 위치를 알 수 없으므로, 매 블록 시작 전에 문서 끝으로 정규화한다.
async function focusEditorEnd(page, frame) {
  const body = await must(frame, SELECTORS.body, { key: 'body', page, frame });
  await body.click();
  await page.keyboard.press('Control+End');
  return body;
}

module.exports = {
  DEFAULT_TIMEOUT,
  countImages,
  dismissStartupModals,
  focusEditorEnd,
  isNaverHostedImage,
  lastImageSrc,
  must,
  resolveEditorFrame,
  tryFind,
};
