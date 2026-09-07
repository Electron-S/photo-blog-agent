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

const { NAVER_EXIT, NaverError, reportNaverError } = require('../lib/naver-errors');
const { SELECTORS, editorUrl, verificationStatus } = require('../lib/naver-selectors');
const { assertLoggedIn, openContext, requireBlogId } = require('../lib/naver-browser');
const { resolveEditorFrame, dismissStartupModals } = require('../lib/naver-dom');
const { dumpFailure, describeFrames } = require('../lib/naver-debug');
const { errFull, errText } = require('../lib/err-text');

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
//
// 키 목록을 **하드코딩하지 않는다.** 사람이 이 표를 보고 VERIFIED_AT을 채우는
// 구조라, 레지스트리에 키를 추가했는데 여기에 안 적으면 그 키는 표에 아예 나오지
// 않고 "전부 확인했다"고 믿은 채 게이트가 열린다. Object.keys에서 유도하고,
// 처리하지 못한 키가 남으면 그 자리에서 죽는다.
const SPECIAL_KEYS = new Set(['frame', 'startupModals', 'overlayProbe', 'visibility']);

function flattenRegistry() {
  const out = [];
  const push = (key, candidates) => {
    if (!Array.isArray(candidates) || !candidates.length) {
      throw new Error(`셀렉터 레지스트리의 "${key}"에 후보 배열이 없습니다. `
        + 'lib/naver-selectors.js를 확인하세요 (조용히 건너뛰면 확인 표에서 사라집니다).');
    }
    out.push({ key, candidates });
  };

  push('frame.root', SELECTORS.frame.rootCandidates);
  for (const m of SELECTORS.startupModals) {
    push(`modal.${m.key}.container`, m.container);
    push(`modal.${m.key}.dismiss`, m.dismiss);
  }
  push('overlayProbe', SELECTORS.overlayProbe);
  for (const sub of Object.keys(SELECTORS.visibility)) {
    push(`visibility.${sub}`, SELECTORS.visibility[sub]);
  }

  const unhandled = [];
  for (const key of Object.keys(SELECTORS)) {
    if (SPECIAL_KEYS.has(key)) continue;
    const entry = SELECTORS[key];
    if (entry && Array.isArray(entry.candidates)) push(key, entry.candidates);
    else unhandled.push(key);
  }
  if (unhandled.length) {
    throw new Error(`셀렉터 레지스트리에 확인 표가 다루지 못하는 키가 있습니다: ${unhandled.join(', ')}. `
      + 'scripts/naver-inspect.js의 flattenRegistry를 갱신하세요.');
  }
  return out;
}

async function countIn(scope, selector) {
  try {
    return await scope.locator(selector).count();
  } catch (err) {
    return `ERR(${errText(err).slice(0, 40)})`;
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
    const errors = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const n = await countIn(scope, candidates[i]);
      // 조회 실패(ERR)를 0으로 세탁하지 않는다. 0으로 바꾸면 **우리 파일의 오타**가
      // "네이버 DOM이 바뀌었으니 후보를 새로 찾으라"는 정반대 진단이 되고,
      // 사람이 그 요약을 근거로 VERIFIED_AT을 채운다.
      const isErr = typeof n !== 'number';
      if (isErr) errors.push(`candidate[${i}] ${candidates[i]} — ${n}`);
      const num = isErr ? 0 : n;
      if (num > 0 && matched === -1) matched = i;
      total += num;
      const mark = isErr ? '✗' : (num === 0 ? ' ' : (num === 1 ? '✓' : '!'));
      console.log(`${key.padEnd(26)} ${String(i).padStart(4)}  ${String(n).padStart(5)}  ${mark} ${candidates[i]}`);
    }
    summary.push({ key, matched, total, errors });
  }

  console.log('\n--- 요약 ---');
  const errored = summary.filter((s) => s.errors.length);
  const problems = [];
  for (const s of summary) {
    if (s.matched === -1 && s.errors.length) {
      problems.push(`${s.key}: 조회 실패 ${s.errors.length}건 — 매칭 여부를 **알 수 없습니다**`);
    } else if (s.matched === -1) {
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

  if (errored.length) {
    console.log('\n  ※ 조회 자체가 실패한 후보가 있습니다 (DOM 변경이 아니라 우리 셀렉터 문제일 수 있습니다):');
    for (const s of errored) for (const e of s.errors) console.log(`    ✗ ${s.key} ${e}`);
    console.log('  ※ 이 상태에서는 확인이 완료되지 않았습니다 — VERIFIED_AT을 채우지 마세요.');
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

  // 레지스트리 평탄화를 **브라우저를 띄우기 전에** 한다. 이건 정적 검사(I/O 0회)인데
  // 예전에는 로그인 성공 + page.goto + networkidle 최대 30s 뒤에야 실행됐다. 그래서
  // naver:login을 안 한 개발자에게는 레지스트리 오류가 절대 드러나지 않았다.
  let entries;
  try {
    entries = flattenRegistry();
  } catch (err) {
    // usage의 "1=인자 오류"와 겹치지 않게 SELECTOR(12)로 낸다 — 조치는 셀렉터
    // 레지스트리 수정이고, 인자를 다시 쓰는 것이 아니다.
    throw new NaverError(NAVER_EXIT.SELECTOR, errFull(err));
  }
  console.log(`셀렉터 레지스트리: key ${entries.length}개 (후보 ${entries.reduce((a, e) => a + e.candidates.length, 0)}개)\n`);

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
      console.log(`\n에디터 프레임 탐색 실패: ${errText(err)}`);
      console.log('(프레임 없이 최상위 기준으로만 매칭을 확인합니다)');
    }

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
        console.log(`  ${errText(err)}`);
      }
    }

    if (opts.dump) {
      const dir = await dumpFailure(page, { key: 'inspect', candidates: [], frame, extra: { purpose: 'selector inspection' } });
      console.log(`\nDOM 덤프: ${dir}`);
    }

    if (opts.keepOpen) {
      // stdin이 /dev/null이거나 닫힌 파이프면 'data'는 영원히 오지 않는다.
      // 그대로 두면 finally의 context.close()가 실행되지 않아 브라우저와
      // .naver-profile SingletonLock이 잡힌 채 남는다.
      if (!process.stdin.isTTY) {
        console.log('\n--keep-open은 대화형 터미널에서만 동작합니다 (stdin이 TTY가 아님). 브라우저를 닫습니다.');
      } else {
        console.log('\n브라우저를 열어 둡니다. DevTools로 직접 확인한 뒤 Enter를 누르세요...');
        await new Promise((resolve) => {
          const done = () => { process.stdin.pause(); resolve(); };
          process.stdin.resume();
          process.stdin.once('data', done);
          process.stdin.once('end', done);
          process.stdin.once('error', done);
        });
      }
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
