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
  console.log('  init   --slug S [--primary-date D] [--metadata-path P] [--analysis-path P]');
  console.log('         [--upload-result-path P] [--force]');
  console.log('         이미 있으면 덮어쓰지 않고 현재 상태를 출력하며 exit 0 (--force로만 덮어씀)');
  console.log('');
  console.log('  update --slug S [--complete a,b] [--draft-path P] [--post-id ID] [--post-url URL]');
  console.log('         [--primary-date D] [--metadata-path P] [--analysis-path P] [--upload-result-path P]');
  console.log('');
  console.log('  read   --slug S [--field steps_remaining] [--format json|text]');
  console.log('  list   [--dir tmp]');
  console.log('');
  console.log(`단계 이름: ${STEPS.join(', ')}`);
  console.log('steps_remaining은 항상 steps_completed로부터 재계산됩니다 (직접 지정 불가).');
  console.log('');
  console.log('종료 코드: 0=성공, 1=인자 오류, 9=상태 파일 손상 또는 스키마 위반');
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
    const all = listStates(dir);
    if (all.length === 0) {
      console.log('(진행 중 세션 없음)');
      return;
    }
    for (const s of all) {
      console.log(s.error ? `slug=${s.slug} | 손상: ${s.error}` : summarize(s.state));
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
    // update는 엄격 모드 — 깨진 상태를 더 깨진 상태로 저장하지 않는다.
    const existing = readState(slug, dir, { strict: true });
    if (!existing) {
      throw new SessionStateError(
        `session-state가 없습니다 (${statePath(slug, dir)}). 먼저 init을 실행하세요.`,
      );
    }
    for (const w of existing.warnings) console.error(`  경고: ${w}`);

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
    console.error(`session-state가 없습니다 (${statePath(slug, dir)}).`);
    process.exit(1);
  }
  for (const w of existing.warnings) console.error(`  경고: ${w}`);

  const field = get('--field');
  if (field !== null) {
    if (!(field in existing.state)) {
      console.error(`Error: "${field}" 필드가 없습니다. 사용 가능: ${Object.keys(existing.state).join(', ')}`);
      process.exit(1);
    }
    const v = existing.state[field];
    console.log(Array.isArray(v) ? v.join(',') : String(v));
    return;
  }

  const format = get('--format') || 'json';
  if (format === 'text') {
    console.log(summarize(existing.state));
  } else if (format === 'json') {
    console.log(JSON.stringify(existing.state, null, 2));
  } else {
    console.error(`Error: --format은 json 또는 text여야 합니다. (받음: "${format}")`);
    printUsage();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`session-state 실패: ${err.message}`);
    process.exit(err.exitCode || 1);
  }
}
