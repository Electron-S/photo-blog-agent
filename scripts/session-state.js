#!/usr/bin/env node
// 세션 진행 상태 CLI. 판정·불변식은 전부 lib/session-state.js에 있다.
//
// 이 스크립트가 있는 이유: 예전에는 워크플로우 프롬프트가 모델에게 이 JSON을
// Write 도구로 직접 쓰라고 지시했다. steps_completed / steps_remaining 두 배열을
// 손으로 동기화해야 해서, 하나만 틀려도 재개가 조용히 깨졌다.

require('dotenv').config();

const {
  STEPS, SessionStateError, defaultState, listStates, markCompleted,
  readState, statePath, touch, writeStateAtomic,
} = require('../lib/session-state');
const { errExitCode, errFull } = require('../lib/err-text');

const SUBCOMMANDS = ['init', 'update', 'read', 'list'];
const FLAGS_WITH_VALUE = new Set([
  '--slug', '--dir', '--primary-date', '--metadata-path', '--analysis-path',
  '--upload-result-path', '--draft-path', '--post-id', '--post-url',
  '--complete', '--field', '--format',
]);
const BOOLEAN_FLAGS = new Set(['--force']);

function printUsage() {
  console.log('Usage: node session-state.js <init|update|read|list> [options]');
  console.log('');
  console.log('  공통   --dir  상태 파일 디렉터리 (기본값: tmp — **cwd 상대**).');
  console.log('         저장소 루트가 아닌 곳에서 실행하면 엉뚱한 위치에 생기므로 절대 경로 권장.');
  console.log('         init/update/read/list 네 서브커맨드 모두에서 쓸 수 있습니다.');
  console.log('');
  console.log('  init   --slug S [--primary-date D] [--metadata-path P] [--analysis-path P]');
  console.log('         [--upload-result-path P] [--draft-path P] [--post-id ID] [--post-url URL] [--force]');
  console.log('         --force로 덮어쓸 때 post_id/post_url을 보존하려면 함께 넘기세요');
  console.log('         이미 있으면 덮어쓰지 않고 현재 상태를 출력하며 exit 0 (--force로만 덮어씀)');
  console.log('');
  console.log('  update --slug S [--complete a,b] [--draft-path P] [--post-id ID] [--post-url URL]');
  console.log('         [--primary-date D] [--metadata-path P] [--analysis-path P] [--upload-result-path P]');
  console.log('');
  console.log('  read   --slug S [--field steps_remaining] [--format json|text]');
  console.log('         --field는 기본이 평문(배열은 콤마 조인). --format json을 명시하면 JSON.');
  console.log('         상태 파일이 손상됐으면 값을 내보내지 않고 exit 9 (조용한 오독 방지).');
  console.log('  list   [--dir tmp]');
  console.log('');
  console.log(`단계 이름: ${STEPS.join(', ')}`);
  console.log('steps_remaining은 항상 steps_completed로부터 재계산됩니다 (직접 지정 불가).');
  console.log('');
  console.log('종료 코드: 0=성공, 1=인자 오류, 9=상태 파일 없음·손상·스키마 위반');
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      if (values.has(a)) {
        console.error(`Error: 플래그 "${a}"가 중복 지정되었습니다.`);
        printUsage();
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(`Error: ${a} requires a value`);
        printUsage();
      }
      values.set(a, v);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) { flags.add(a); continue; }
    if (a.startsWith('--')) {
      console.error(`Error: unknown option ${a}`);
      printUsage();
    }
    positional.push(a);
  }
  return { positional, get: (n) => (values.has(n) ? values.get(n) : null), has: (n) => flags.has(n) };
}

function requireSlug(get) {
  const slug = get('--slug');
  if (!slug) {
    console.error('Error: --slug is required');
    printUsage();
  }
  return slug;
}

function applyFields(state, get) {
  const map = {
    '--primary-date': 'primary_date',
    '--metadata-path': 'metadata_path',
    '--analysis-path': 'analysis_path',
    '--upload-result-path': 'upload_result_path',
    '--draft-path': 'draft_path',
    '--post-id': 'post_id',
    '--post-url': 'post_url',
  };
  const out = { ...state };
  for (const [flag, key] of Object.entries(map)) {
    const v = get(flag);
    if (v !== null) out[key] = v;
  }
  return out;
}

function summarize(s) {
  return `slug=${s.slug} | completed=${s.steps_completed.join(',') || '-'}`
    + ` | remaining=${s.steps_remaining.join(',') || '-'}`
    + ` | post_id=${s.post_id ?? 'null'} | updated=${s.last_updated ?? 'null'}`;
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, get, has } = parseArgs(argv);
  const sub = positional[0];

  if (!sub || !SUBCOMMANDS.includes(sub)) {
    console.error(sub ? `Error: 알 수 없는 서브커맨드 "${sub}"` : 'Error: 서브커맨드가 필요합니다.');
    printUsage();
  }
  if (positional.length > 1) {
    console.error(`Error: 서브커맨드는 하나만 지정할 수 있습니다. (받음: ${positional.join(', ')})`);
    printUsage();
  }

  const dir = get('--dir') || 'tmp';

  if (sub === 'list') {
    const all = listStates(dir, { explicit: get('--dir') !== null });
    if (all.length === 0) {
      console.log('(진행 중 세션 없음)');
      return;
    }
    // **경고를 버리지 않는다.** `/blog` 진입 프로브(.claude/commands/blog.md)가
    // 이 출력만 보고 "이어서/처음부터"를 사용자에게 묻는다. 예전에는 warnings를
    // 손대지 않아서, steps_completed가 문자열로 손상된 파일 — CLAUDE.md가 "손으로
    // 동기화하면 재개가 조용히 깨진다"고 경고한 그 형태 — 이 `completed=-`로,
    // 즉 **완전히 새 세션으로** 요약됐다. 완료된 단계가 조용히 소멸하고 두 번째
    // 초안이 만들어진다.
    let warned = 0;
    for (const s of all) {
      console.log(s.error ? `slug=${s.slug} | 손상: ${s.error}` : summarize(s.state));
      for (const w of s.warnings || []) {
        warned += 1;
        for (const line of String(w).split('\n')) console.log(`  경고: ${line.trim()}`);
      }
    }
    if (warned) {
      console.log('');
      console.log(`※ 경고 ${warned}건 — 위 요약이 파일 내용과 다를 수 있습니다.`);
      console.log('   재개 전에 `session-state.js read --slug <slug>`로 실제 상태를 확인하세요.');
    }
    return;
  }

  const slug = requireSlug(get);

  if (sub === 'init') {
    const existing = readState(slug, dir);
    if (existing && !has('--force')) {
      // analyze-photos.js와 같은 핸드오프 패턴 — 재실행이 진행 상태를 날리지 않는다.
      console.error(`session-state가 이미 있습니다 (${existing.path}). 덮어쓰지 않습니다. 덮어쓰려면 --force.`);
      for (const w of existing.warnings) console.error(`  경고: ${w}`);
      console.log(JSON.stringify(existing.state, null, 2));
      return;
    }
    const state = touch(applyFields(defaultState(slug), get));
    const p = writeStateAtomic(slug, dir, state);
    console.error(`session-state 생성: ${p}`);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (sub === 'update') {
    // **읽기는 관대하게, 쓰기는 엄격하게.** 예전에는 여기서 strict read를 해서
    // 불변식이 깨진 상태를 **읽는 것부터** 막았다. 그런데 그 오류 메시지가
    // 안내하는 복구 방법이 바로 `--complete`로 빠진 단계를 채우는 것이라,
    // 안내받은 복구가 원리적으로 불가능했다 (남는 길은 post_id를 날리는
    // init --force뿐). 엄격 검사는 writeStateAtomic이 하므로, 고치지 않은 채
    // 저장하려 하면 여전히 exit 9다 — 손상 상태가 디스크에 남지는 않는다.
    const existing = readState(slug, dir);
    if (!existing) {
      throw new SessionStateError(
        `session-state가 없습니다 (${statePath(slug, dir)}). 먼저 init을 실행하세요.`,
      );
    }
    if (existing.warnings.length) {
      console.error('  ※ 현재 상태에 불변식 위반이 있습니다. --complete / --post-id 로 고쳐 주세요');
      console.error('    (고치지 않은 채 저장하려 하면 exit 9로 거부됩니다):');
      for (const w of existing.warnings) {
        for (const line of String(w).split('\n')) console.error(`    ${line.trim()}`);
      }
    }

    let state = applyFields(existing.state, get);
    const completeArg = get('--complete');
    if (completeArg !== null) {
      const steps = completeArg.split(',').map((s) => s.trim()).filter(Boolean);
      if (steps.length === 0) {
        console.error('Error: --complete에 단계 이름이 없습니다.');
        printUsage();
      }
      state = markCompleted(state, steps);
    }
    state = touch(state);
    const p = writeStateAtomic(slug, dir, state);
    console.error(`session-state 갱신: ${p}`);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  // read
  const existing = readState(slug, dir);
  if (!existing) {
    // update와 같은 조건에는 같은 코드를 쓴다 (예전에는 update=9, read=1로 갈렸다).
    throw new SessionStateError(`session-state가 없습니다 (${statePath(slug, dir)}).`);
  }
  for (const w of existing.warnings) console.error(`  경고: ${w}`);

  const explicitFormat = get('--format');
  const format = explicitFormat || 'json';
  if (format !== 'json' && format !== 'text') {
    // **--field보다 먼저 검증한다.** 예전에는 --field가 먼저 return해서
    // `--field slug --format bogus`가 검증을 통째로 건너뛰었다.
    console.error(`Error: --format은 json 또는 text여야 합니다. (받음: "${format}")`);
    printUsage();
  }

  const field = get('--field');
  if (field !== null) {
    // `in`은 프로토타입 체인을 탄다 — `--field toString`이 네이티브 함수를 출력했다.
    if (!Object.prototype.hasOwnProperty.call(existing.state, field)) {
      console.error(`Error: "${field}" 필드가 없습니다. 사용 가능: ${Object.keys(existing.state).join(', ')}`);
      process.exit(1);
    }
    // **손상 상태에서는 값을 내보내지 않는다.** `X=$(… --field steps_completed)`로
    // 받는 호출자는 빈 문자열을 "갓 init한 새 세션"과 구별할 수 없다.
    if (existing.degraded) {
      console.error('Error: 상태 파일이 손상되어 이 값을 신뢰할 수 없습니다 (위 경고 참조).');
      console.error(`  + 전체 상태는 \`read --slug ${slug}\`로 확인하고, 고친 뒤 다시 시도하세요.`);
      process.exit(9);
    }
    const v = existing.state[field];
    // 기본은 셸에서 쓰기 좋은 평문(`X=$(… --field steps_remaining)`).
    // `--format json`을 **명시**하면 배열·객체를 뭉개지 않고 그대로 준다
    // (예전에는 배열이 콤마 조인, 객체가 [object Object]로 소실됐다).
    if (explicitFormat === 'json') console.log(JSON.stringify(v));
    else console.log(Array.isArray(v) ? v.join(',') : String(v));
    return;
  }

  if (format === 'text') {
    console.log(summarize(existing.state));
  } else {
    console.log(JSON.stringify(existing.state, null, 2));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`session-state 실패: ${errFull(err)}`);
    process.exit(errExitCode(err) || 1);
  }
}
