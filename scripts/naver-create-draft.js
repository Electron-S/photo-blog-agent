#!/usr/bin/env node
// 초안 HTML → 네이버 블로그.
//
// 현재 상태: **--dry-run만 동작합니다.** 에디터 조작은 셀렉터 실물 확인
// 게이트(`npm run naver:inspect`)를 통과한 뒤에 구현합니다 — 추정 셀렉터로
// 구현하면 "또 한 번도 안 돌아가는 코드"가 됩니다.
//
// --dry-run은 브라우저 없이 블록 변환·로컬 이미지 해석·평문화된 링크를
// 출력하므로, 네이버 계정 없이 콘텐츠 파이프라인 전체를 검증할 수 있습니다.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { NAVER_EXIT, NaverError, reportNaverError } = require('../lib/naver-errors');
const { isVerified, verificationStatus } = require('../lib/naver-selectors');
const { htmlToBlocks, resolveImagePaths, summarizeBlocks } = require('../lib/naver-content');
const { errExitCode, errFull } = require('../lib/err-text');

const FLAGS_WITH_VALUE = new Set([
  '--html', '--title', '--category', '--tags', '--visibility', '--image-dir', '--assets-root',
]);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--publish', '--headless']);
const VISIBILITIES = ['private', 'public'];

function printUsage() {
  console.log('Usage: node naver-create-draft.js --html <draft.html> --title "제목" [options]');
  console.log('');
  console.log('Options:');
  console.log('  --html         초안 HTML 파일 (필수)');
  console.log('  --title        글 제목 (--dry-run이 아니면 필수)');
  console.log('  --category     네이버 카테고리 (발행 레이어에서만 반영됨)');
  console.log('  --tags         태그, 쉼표 구분 (발행 레이어에서만 반영됨)');
  console.log('  --visibility   private(기본) | public');
  console.log('  --image-dir    이미지 압축본 디렉터리를 직접 지정');
  console.log('  --assets-root  압축본 루트 (기본: tmp/assets)');
  console.log('  --publish      임시저장이 아니라 발행까지 수행');
  console.log('  --dry-run      브라우저 없이 블록 변환 결과만 출력');
  console.log('  --headless     창 없이 실행 (headed로 성공을 확인한 뒤에만 사용)');
  console.log('');
  console.log('공개 발행은 --visibility public 과 NAVER_ALLOW_PUBLIC=1 을 **둘 다** 요구합니다.');
  console.log('종료 코드: 0=성공, 1=인자 오류, 10=playwright 없음, 11=세션, 12=셀렉터,');
  console.log('           16=이미지, 17=headed 불가, 18=공개 발행 거부, 19=HTML→블록 변환 실패');
  console.log('           13=카테고리, 14=태그, 15=발행 후 검증 — 발행 레이어 구현 후 사용 (현재 예약)');
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      if (values.has(a)) { console.error(`Error: 플래그 "${a}"가 중복 지정되었습니다.`); printUsage(); }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { console.error(`Error: ${a} requires a value`); printUsage(); }
      values.set(a, v); i += 1; continue;
    }
    if (BOOLEAN_FLAGS.has(a)) { flags.add(a); continue; }
    if (a.startsWith('--')) { console.error(`Error: unknown option ${a}`); printUsage(); }
    positional.push(a);
  }
  if (positional.length) {
    console.error(`Error: 위치 인자를 받지 않습니다. --html을 쓰세요. (받음: ${positional.join(', ')})`);
    printUsage();
  }
  return { get: (n) => (values.has(n) ? values.get(n) : null), has: (n) => flags.has(n) };
}

// 공개 발행 안전장치. 플래그 하나만으로는 오타/복붙 사고가 난다.
function assertPublicAllowed(visibility, title) {
  if (visibility !== 'public') return;
  if (process.env.NAVER_ALLOW_PUBLIC !== '1') {
    throw new NaverError(
      NAVER_EXIT.PUBLIC_BLOCKED,
      '공개 발행이 거부되었습니다. --visibility public 은 NAVER_ALLOW_PUBLIC=1 환경변수를 함께 요구합니다.\n'
      + '  + 플래그 하나만으로 공개 발행이 되면 오타·복붙으로 사고가 납니다.',
    );
  }
  if (/^\s*\[TEST\]/i.test(title || '')) {
    throw new NaverError(
      NAVER_EXIT.PUBLIC_BLOCKED,
      '제목이 [TEST]로 시작하는 글은 공개 발행할 수 없습니다.',
    );
  }
}

function main() {
  const { get, has } = parseArgs(process.argv.slice(2));

  const htmlPath = get('--html');
  if (!htmlPath) { console.error('Error: --html is required'); printUsage(); }

  const dryRun = has('--dry-run');
  const title = get('--title');
  if (!dryRun && !title) { console.error('Error: --title is required (--dry-run 제외)'); printUsage(); }

  const visibility = get('--visibility') || 'private';
  if (!VISIBILITIES.includes(visibility)) {
    console.error(`Error: --visibility는 ${VISIBILITIES.join(' | ')} 중 하나여야 합니다. (받음: "${visibility}")`);
    printUsage();
  }

  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (err) {
    console.error(`Error: 초안 파일을 읽을 수 없음 (${htmlPath}): ${errFull(err)}`);
    process.exit(1);
  }

  const { blocks, links } = htmlToBlocks(html);
  resolveImagePaths(blocks, {
    assetsRoot: get('--assets-root') || path.join('tmp', 'assets'),
    imageDir: get('--image-dir'),
  });

  const summary = summarizeBlocks(blocks);
  const tags = get('--tags') ? get('--tags').split(',').map((t) => t.trim()).filter(Boolean) : [];
  const category = get('--category');

  console.log('=== 블록 변환 결과 ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  // 표는 **한 블록 = 한 줄**이어야 한다. 개행을 그대로 찍으면 번호 없는 유령 행이
  // 생겨 블록 수를 눈으로 셀 수 없다. 문단만 이스케이프하고 heading·caption·링크는
  // 안 하던 것이 dry-run(유일하게 동작하는 검증 경로)의 출력을 깨뜨렸다.
  const oneLine = (t, max = 76) => {
    const flat = String(t == null ? '' : t).replace(/\n/g, ' ⏎ ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  blocks.forEach((b, i) => {
    const n = String(i + 1).padStart(2, '0');
    if (b.type === 'image') {
      console.log(`${n} [image]     ${path.basename(b.localPath)}  ← ${oneLine(b.src, 60)}`);
      console.log(`              caption: ${oneLine(b.caption) || '(없음)'}`);
      // alt가 출력되지 않아, 보이지 않는 문자나 잘못된 대체텍스트가 검증 출력에서도
      // 안 보였다. 에디터에 들어가는 값은 전부 여기서 눈으로 확인할 수 있어야 한다.
      console.log(`              alt:     ${oneLine(b.alt) || '(없음)'}`);
    } else if (b.type === 'heading') {
      console.log(`${n} [h${b.level}]        ${oneLine(b.text)}`);
    } else {
      console.log(`${n} [paragraph] ${oneLine(b.text)}`);
    }
  });

  if (links.length) {
    console.log('\n=== 평문화된 링크 (네이버 에디터의 링크 삽입은 별도 UI라 v1에서는 텍스트로 넣습니다) ===');
    for (const l of links) console.log(`  ${oneLine(l.text, 40)} → ${oneLine(l.href, 90)}`);
  }

  // 카테고리/태그는 본문 에디터가 아니라 [발행] 레이어에 있다. 임시저장만 하는
  // 경로에서는 반영할 수 없다 — 예전 구현은 이걸 조용히 무시했다.
  if ((category || tags.length) && !has('--publish')) {
    console.log('\n※ 카테고리/태그는 발행 시점(발행 설정 레이어)에만 반영됩니다.');
    console.log('  --publish 없이 임시저장만 하면 아래 값은 적용되지 않습니다:');
    if (category) console.log(`    카테고리: ${category}`);
    if (tags.length) console.log(`    태그: ${tags.join(', ')}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: 브라우저를 열지 않았습니다. 로컬 이미지 경로와 블록 순서를 확인하세요.');
    return;
  }

  assertPublicAllowed(visibility, title);

  // ★ 실물 확인 게이트 ★
  if (!isVerified()) {
    throw new NaverError(
      NAVER_EXIT.SELECTOR,
      '네이버 에디터 조작은 아직 구현되지 않았습니다 — 셀렉터가 실물로 확인되지 않았기 때문입니다.\n'
      + `  + ${verificationStatus()}\n`
      + '  + 순서: npm run naver:doctor → npm run naver:login → npm run naver:inspect -- --dump --keep-open\n'
      + '  + inspect 출력의 매칭 표를 보고 lib/naver-selectors.js의 후보 순서를 확정하고\n'
      + '    VERIFIED_AT / PLAYWRIGHT_VERIFIED 를 채운 뒤 에디터 조작 구현을 진행합니다.\n'
      + '  + 그 전까지는 --dry-run으로 콘텐츠 파이프라인만 검증할 수 있습니다.',
    );
  }

  throw new NaverError(
    NAVER_EXIT.GENERAL,
    '에디터 조작 단계(lib/naver-editor.js)가 아직 구현되지 않았습니다.',
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
