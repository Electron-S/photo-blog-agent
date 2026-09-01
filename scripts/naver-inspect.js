#!/usr/bin/env node
// 실물 DOM 확인 도구 — 이 계획 전체의 리스크 완화 장치.
//
// lib/naver-selectors.js의 셀렉터는 전부 추정값이다. 실제 네이버 SmartEditor
// DOM을 보지 않고 작성했기 때문에, 그대로 본 구현을 돌리면 "또 한 번도 안
// 돌아가는 코드"가 될 위험이 크다.
//
// 이 스크립트는 에디터를 열고 레지스트리의 모든 키에 대해 각 후보의 매칭
// 개수를 표로 출력한다. 사람이 그 표를 보고 후보 순서를 확정하고 VERIFIED_AT을
// 채운 뒤에야 P4(에디터 조작) 구현을 시작할 수 있다.

require('dotenv').config();

const { NAVER_EXIT, reportNaverError } = require('../lib/naver-errors');
const { SELECTORS, editorUrl, verificationStatus } = require('../lib/naver-selectors');
const { assertLoggedIn, openContext, requireBlogId } = require('../lib/naver-browser');
const { resolveEditorFrame, dismissStartupModals } = require('../lib/naver-dom');
const { dumpFailure, describeFrames } = require('../lib/naver-debug');

const BOOLEAN_FLAGS = new Set(['--dump', '--keep-open', '--skip-modals', '--headless']);

function printUsage() {
  console.log('Usage: node naver-inspect.js [--dump] [--keep-open] [--skip-modals] [--headless]');
  console.log('');
  console.log('  --dump         DOM 전체를 tmp/naver-debug/inspect-<ts>/ 에 저장');
  console.log('  --keep-open    Enter를 누를 때까지 브라우저를 열어 둠 (DevTools로 직접 확인)');
  console.log('  --skip-modals  시작 모달 처리를 건너뜀 (모달 자체를 관찰하고 싶을 때)');
  console.log('  --headless     창 없이 실행 (모달 관찰에는 부적합)');
  console.log('');
  console.log('출력의 매칭 표를 보고 lib/naver-selectors.js의 후보 순서를 확정한 뒤');
  console.log('VERIFIED_AT / PLAYWRIGHT_VERIFIED 를 채우세요.');
  process.exit(1);
}

// 레지스트리를 (key, candidates[]) 목록으로 평탄화한다.
function flattenRegistry() {
  const out = [];
  const push = (key, candidates) => {
    if (Array.isArray(candidates) && candidates.length) out.push({ key, candidates });
  };

  push('frame.root', SELECTORS.frame.rootCandidates);
  for (const m of SELECTORS.startupModals) {
    push(`modal.${m.key}.container`, m.container);
    push(`modal.${m.key}.dismiss`, m.dismiss);
  }
  push('overlayProbe', SELECTORS.overlayProbe);

  for (const key of ['title', 'body', 'imageComponent', 'imageElement', 'photoButton', 'fileInput',
    'saveDraft', 'saveDraftDone', 'publishOpen', 'publishLayer', 'categoryOpen',
    'categoryItems', 'categorySelected', 'tagInput', 'tagChips', 'publishConfirm']) {
    push(key, SELECTORS[key] && SELECTORS[key].candidates);
  }
  push('visibility.private', SELECTORS.visibility.private);
  push('visibility.public', SELECTORS.visibility.public);
  push('visibility.selected', SELECTORS.visibility.selected);
  return out;
}

async function countIn(scope, selector) {
  try {
    return await scope.locator(selector).count();
  } catch (err) {
    return `ERR(${err.message.split('\n')[0].slice(0, 40)})`;
  }
}

async function report(scope, label, entries) {
  console.log(`\n=== ${label} 기준 매칭 ===`);
  console.log('key                        cand#  count  selector');
  console.log('-'.repeat(100));
  const summary = [];
  for (const { key, candidates } of entries) {
    let matched = -1;
    let total = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const n = await countIn(scope, candidates[i]);
      const num = typeof n === 'number' ? n : 0;
      if (num > 0 && matched === -1) matched = i;
      total += num;
      const mark = num === 0 ? ' ' : (num === 1 ? '✓' : '!');
      console.log(`${key.padEnd(26)} ${String(i).padStart(4)}  ${String(n).padStart(5)}  ${mark} ${candidates[i]}`);
    }
    summary.push({ key, matched, total });
  }

  console.log('\n--- 요약 ---');
  const problems = [];
  for (const s of summary) {
    if (s.matched === -1) {
      problems.push(`${s.key}: 매칭 0건 — 후보를 새로 찾아야 합니다`);
    } else if (s.matched > 0) {
      problems.push(`${s.key}: candidate[${s.matched}]이 첫 매칭 — 이 후보를 1순위로 올리세요`);
    }
  }
  if (problems.length === 0) {
    console.log('  모든 key가 1순위 후보로 매칭됩니다.');
  } else {
    for (const p of problems) console.log(`  - ${p}`);
  }
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (!BOOLEAN_FLAGS.has(a)) {
      console.error(`Error: unknown option ${a}`);
      printUsage();
    }
  }
  const opts = {
    dump: argv.includes('--dump'),
    keepOpen: argv.includes('--keep-open'),
    skipModals: argv.includes('--skip-modals'),
    headless: argv.includes('--headless'),
  };

  const blogId = requireBlogId();
  console.log(verificationStatus());
  console.log(`대상: ${editorUrl(blogId)}\n`);

  const context = await openContext({ headless: opts.headless });
  let page = null;
  try {
    await assertLoggedIn(context, { blogId });
    console.log('세션 확인 완료.\n');

    page = await context.newPage();
    await page.goto(editorUrl(blogId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 에디터 초기화에 시간이 걸린다 — 네트워크가 잠잠해질 때까지 기다린다.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    console.log('=== 프레임 트리 ===');
    console.log(describeFrames(page));

    let frame = null;
    try {
      frame = await resolveEditorFrame(page, { timeoutMs: 15000 });
      console.log(`\n에디터 프레임: ${frame === page.mainFrame() ? '최상위 문서' : frame.url()}`);
    } catch (err) {
      console.log(`\n에디터 프레임 탐색 실패: ${err.message.split('\n')[0]}`);
      console.log('(프레임 없이 최상위 기준으로만 매칭을 확인합니다)');
    }

    const entries = flattenRegistry();
    await report(page.mainFrame(), '최상위 문서', entries);
    if (frame && frame !== page.mainFrame()) {
      await report(frame, '에디터 프레임', entries);
    }

    // 사진 버튼이 filechooser를 여는지, 별도 팝업을 여는지 — R2의 1순위 확인 항목.
    console.log('\n=== 확인이 필요한 항목 ===');
    console.log('  1. 사진 버튼이 표준 파일 선택창을 여는가, 아니면 별도 팝업 윈도우("네이버 포토업로더")를 여는가?');
    console.log('     → 팝업이면 context.waitForEvent("page") 트랙을 추가해야 합니다.');
    console.log('  2. 카테고리/태그/공개범위가 본문 에디터에 있는가, [발행] 버튼을 누른 뒤 레이어에 있는가?');
    console.log('     → 레이어에 있다면 임시저장만 하는 경로에서는 설정할 수 없습니다.');
    console.log('  3. "작성 중인 글이 있습니다" 복구 팝업이 뜨는가?');
    console.log('  4. 임시저장 목록 UI가 어떻게 생겼는가? (재개 발행 경로 구현 가능 여부)');

    if (!opts.skipModals && frame) {
      console.log('\n=== 시작 모달 처리 시도 ===');
      try {
        await dismissStartupModals(page, frame);
        console.log('  모달 처리 통과.');
      } catch (err) {
        console.log(`  ${err.message.split('\n')[0]}`);
      }
    }

    if (opts.dump) {
      const dir = await dumpFailure(page, { key: 'inspect', candidates: [], frame, extra: { purpose: 'selector inspection' } });
      console.log(`\nDOM 덤프: ${dir}`);
    }

    if (opts.keepOpen) {
      console.log('\n브라우저를 열어 둡니다. DevTools로 직접 확인한 뒤 Enter를 누르세요...');
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
      });
    }

    console.log('\n다음 단계: 위 표를 보고 lib/naver-selectors.js의 후보 순서를 확정하고');
    console.log('VERIFIED_AT / PLAYWRIGHT_VERIFIED 를 채우세요. 그 전까지 발행 경로는 구현하지 않습니다.');
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    reportNaverError(err);
    process.exit(err.exitCode || NAVER_EXIT.GENERAL);
  });
}
