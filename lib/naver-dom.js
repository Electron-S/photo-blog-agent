// 에디터 DOM 접근 헬퍼.
//
// 핵심 원칙: **silent skip 금지.** 예전 구현은 `if (await x.isVisible())`로
// 감싸서, 요소를 못 찾으면 조용히 건너뛰고 "성공"을 반환했다. 이미지가 하나도
// 안 올라간 글이 정상 종료로 끝나는 구조였다. 여기서는 못 찾으면 덤프를 남기고
// exit 12로 죽는다.

const { NAVER_EXIT, NaverError } = require('./naver-errors');
const { SELECTORS, NAVER_IMAGE_HOSTS } = require('./naver-selectors');
const { dumpFailure } = require('./naver-debug');
const { errFull } = require('./err-text');

const DEFAULT_TIMEOUT = 10000;

// 셀렉터 문법 오류는 DOM 변경이 아니다 — 우리 레지스트리의 오타다.
const SELECTOR_SYNTAX_RE = /selector|Unexpected token|Unknown engine|malformed/i;

async function firstMatch(scope, candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = [];
  // 조회 자체가 실패한 사유를 모은다. "요소가 없었다"와 "조회를 못 했다"는
  // 다른 사건이고, 후자를 0으로 뭉개면 must()가 엉뚱한 진단을 내린다
  // (예: 세션 만료로 컨텍스트가 파괴됐는데 "셀렉터를 갱신하세요"라고 안내).
  const probeErrors = [];
  do {
    lastCount = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const loc = scope.locator(candidates[i]);
      let count = 0;
      try {
        count = await loc.count();
      } catch (err) {
        // err가 Error가 아닐 수 있다 (문자열 throw, undefined reject).
        // 가드가 없으면 "없는 것이 정상"인 tryFind 경로가 TypeError로 깨진다.
        const msg = errFull(err);
        if (SELECTOR_SYNTAX_RE.test(msg)) {
          throw new NaverError(
            NAVER_EXIT.SELECTOR,
            `셀렉터 문법 오류입니다 (네이버 DOM 변경이 아닙니다): "${candidates[i]}"\n`
            + `  + ${msg}\n`
            + '  + lib/naver-selectors.js를 수정하세요.',
          );
        }
        probeErrors.push(`${candidates[i]}: ${msg.split('\n')[0]}`);
        count = 0;
      }
      lastCount.push(count);
      if (count > 0) return { locator: loc.first(), index: i, count, counts: lastCount, probeErrors };
    }
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  return { locator: null, index: -1, count: 0, counts: lastCount, probeErrors };
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
      + (found.probeErrors.length
        ? `  + 조회 자체가 실패한 후보가 있습니다 (요소 부재가 아닐 수 있음):\n`
          + found.probeErrors.map((e) => `      ${e}`).join('\n')
          + '\n    세션 만료나 프레임 detach일 수 있으니 npm run naver:doctor를 먼저 확인하세요.\n'
        : '')
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
 * 알려진 모달은 닫고, 모르는 dimmed 오버레이가 남아 있으면 exit 12로 실패한다.
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
      // 닫기 버튼은 반드시 **모달 컨테이너 안에서** 찾는다. scope 전체에서 찾으면
      // 툴바/사이드바의 "취소" 버튼이 문서 순서상 먼저 걸려 엉뚱한 곳을 클릭하고,
      // 모달은 그대로 남아 이후 모든 클릭이 무효가 된다.
      // 컨테이너 후보에 [class*="popup"] 같은 넓은 셀렉터가 있어, 로케이터는 호출할
      // 때마다 재해석된다. 모달이 사라진 뒤 .first()가 **다른 요소**로 재해석되면
      // 정상 동작이 "모달이 안 닫혔다"로 보고된다 — 핸들로 고정한다.
      let handle = null;
      try { handle = await container.elementHandle({ timeout: 1000 }); } catch { handle = null; }
      const stillUp = async () => {
        try { return handle ? await handle.isVisible() : await container.isVisible(); } catch { return false; }
      };

      const btn = await tryFind(container, modal.dismiss, { timeoutMs: 2000 });
      if (!btn) {
        // 폴링하는 2초 사이에 모달이 스스로 사라졌을 수 있다. 그건 정상 경로다.
        if (!(await stillUp())) {
          console.log(`[modal] ${modal.description}이 스스로 닫혔습니다.`);
          if (handle) await handle.dispose().catch(() => {});
          continue;
        }
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

      // 실제로 닫혔는지 확인한다. 클릭이 먹지 않았는데 성공으로 반환하면
      // 이 함수가 막으려던 상황(가려진 화면에서 조용히 진행)이 그대로 재현된다.
      // 판정은 클릭 전에 확보한 핸들로 한다 (셀렉터 재해석 오탐 방지).
      const stillVisible = await stillUp();
      if (handle) await handle.dispose().catch(() => {});
      if (stillVisible) {
        const dumpDir = await dumpFailure(page, { key: `modal-${modal.key}-not-closed`, candidates: modal.dismiss, frame });
        throw new NaverError(
          NAVER_EXIT.SELECTOR,
          `${modal.description}의 닫기 버튼을 눌렀지만 모달이 그대로 남아 있습니다.\n`
          + '  + 이 상태로는 이후 모든 클릭이 무효가 됩니다.\n'
          + (dumpDir ? `  + 진단 자료: ${dumpDir}` : ''),
          { dumpDir },
        );
      }
    }
  }

  // 레지스트리에 없는 **dimmed 배경 오버레이**가 화면을 덮고 있으면 실패한다.
  // (SELECTORS.overlayProbe가 dimmed 계열만 보므로, 배경을 어둡게 하지 않는
  // 모달은 여기서 잡히지 않는다 — startupModals에 등록해야 한다.)
  for (const sel of SELECTORS.overlayProbe) {
    let n = 0;
    try {
      n = await page.locator(`${sel}:visible`).count();
    } catch (err) {
      // 안전장치가 자기 실패를 "통과"로 바꾸면 안 된다. 확인 못 했으면 실패다.
      const dumpDir = await dumpFailure(page, { key: 'overlay-probe-failed', candidates: [sel], frame });
      throw new NaverError(
        NAVER_EXIT.SELECTOR,
        `오버레이 프로브(${sel}) 실행에 실패해 화면이 가려졌는지 확인할 수 없습니다: ${errFull(err)}\n`
        + '  + 확인하지 못한 채 진행하면 이후 클릭이 조용히 무효가 됩니다.\n'
        + (dumpDir ? `  + 진단 자료: ${dumpDir}` : ''),
        { dumpDir },
      );
    }
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

// 후보를 순회하며 조회한다. **조회 실패를 "없음"으로 뭉개지 않는다** —
// 프레임 detach·세션 만료·우리 레지스트리의 셀렉터 오타가 전부 "이미지가 하나도
// 없다"와 같은 값이 되면, 이미지가 한 장도 안 올라간 글이 정상으로 통과한다.
// (이 파일 헤더가 금지하는 바로 그 silent skip이다. firstMatch가 probeErrors를
//  모으는 이유와 같다.)
async function probeCandidates(frame, candidates, key, visit) {
  const probeErrors = [];
  for (const sel of candidates) {
    let outcome;
    try {
      outcome = await visit(frame.locator(sel));
    } catch (err) {
      const msg = errFull(err);
      if (SELECTOR_SYNTAX_RE.test(msg)) {
        throw new NaverError(
          NAVER_EXIT.SELECTOR,
          `셀렉터 문법 오류입니다 (네이버 DOM 변경이 아닙니다): "${sel}"\n`
          + `  + ${msg}\n`
          + '  + lib/naver-selectors.js를 수정하세요.',
        );
      }
      probeErrors.push(`${sel}: ${msg.split('\n')[0]}`);
      continue;
    }
    if (outcome !== undefined) return outcome;
  }
  // **must와 같은 규칙을 쓴다.** 예전에는 `probeErrors.length === candidates.length`,
  // 즉 후보가 **전부** 실패해야 죽었다. 그래서 후보 A가 0건을 정상 조회하고 B가
  // detach로 실패하면 조건이 거짓이 되어 0을 반환하고 probeErrors는 버려졌다 —
  // 같은 입력에 must는 exit 12를 내는데 여기는 조용히 "이미지 없음"이었다.
  // 실제 시나리오: 업로드 폴링 중 세션이 만료돼 후보 순회 **도중** 프레임이 detach.
  // 첫 후보가 이미 0을 돌려줬으므로 "한 장도 안 올라갔다"로 판정된다.
  //
  // 긍정 결과를 얻었다면 조회 실패가 섞여 있어도 답을 안다. 못 얻었는데 실패가
  // 하나라도 있으면 "0건"이 아니라 **모른다**.
  if (probeErrors.length) {
    throw new NaverError(
      NAVER_EXIT.SELECTOR,
      `${key} 조회가 실패해 상태를 알 수 없습니다 (요소가 없다는 뜻이 아닙니다).\n`
      + probeErrors.map((e) => `  + ${e}`).join('\n')
      + '\n  + 프레임이 detach됐거나 세션이 끊겼을 수 있습니다.',
      { probeErrors },
    );
  }
  return undefined;
}

/**
 * 에디터에 삽입된 이미지 컴포넌트 수.
 * @returns {Promise<number>} 모든 후보를 정상 조회했고 요소가 없으면 0.
 * @throws {NaverError} SELECTOR — 모든 후보의 **조회 자체**가 실패한 경우.
 */
async function countImages(frame) {
  const n = await probeCandidates(
    frame, SELECTORS.imageComponent.candidates, 'imageComponent',
    async (loc) => {
      const c = await loc.count();
      return c > 0 ? c : undefined;   // 0이면 다음 후보를 본다
    },
  );
  return n === undefined ? 0 : n;
}

/**
 * 마지막 이미지의 src — "실제로 네이버 서버에 올라갔다"의 유일한 증거.
 * blob:/data:면 아직 클라이언트 메모리에만 있다.
 *
 * `present`와 `src`를 분리한다. 예전에는 "img 요소가 없다"와 "img는 있는데 src가
 * 없다"가 똑같이 null이라, 업로드가 아직 안 끝난 상태를 "이미지 없음"으로 오인했다.
 * @returns {Promise<{present: boolean, src: string|null}>}
 * @throws {NaverError} SELECTOR — 모든 후보의 조회 자체가 실패한 경우.
 */
async function lastImageSrc(frame) {
  const found = await probeCandidates(
    frame, SELECTORS.imageElement.candidates, 'imageElement',
    async (loc) => {
      const n = await loc.count();
      if (n === 0) return undefined;   // 다음 후보를 본다
      return { present: true, src: await loc.nth(n - 1).getAttribute('src') };
    },
  );
  return found === undefined ? { present: false, src: null } : found;
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
