#!/usr/bin/env node
// 초안 HTML 정적 검증 CLI. 규칙과 판정은 전부 lib/lint-draft.js에 있고
// 여기는 인자 파싱 + 파일 읽기 + 포맷 + exit 코드만 담당한다.

require('dotenv').config();

const fs = require('fs');
const { lintDraftHtml, formatLintReport, validateUploadResult } = require('../lib/lint-draft');

const FLAGS_WITH_VALUE = new Set(['--upload-result', '--format']);
const BOOLEAN_FLAGS = new Set(['--strict']);

function printUsage() {
  console.log('Usage: node lint-draft.js <draft.html> [--upload-result <upload.json>] [--format text|json] [--strict]');
  console.log('');
  console.log('Options:');
  console.log('  --upload-result  upload-images.js --output 결과 JSON. img의 width/height를 실제 치수와 대조');
  console.log('  --format         text(기본) 또는 json. json은 모델이 findings 전체를 한 번에 읽고 고칠 때 사용');
  console.log('  --strict         warn을 error로 승격 (CI 전용 — 규칙을 강화하는 방향)');
  console.log('');
  console.log('우회 플래그는 제공하지 않습니다. error는 발행을 차단합니다.');
  console.log('종료 코드: 0=통과, 1=인자/파일 오류, 8=lint 규칙 위반(error 1건 이상)');
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

function readJson(path, label) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Error: ${label} 파일을 읽을 수 없음 (${path}): ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error: ${label} JSON 파싱 실패 (${path}): ${err.message}`);
    process.exit(1);
  }
  return null;
}

function main() {
  const { positional, get, has } = parseArgs(process.argv.slice(2));

  if (positional.length === 0) {
    console.error('Error: 초안 HTML 파일 경로가 필요합니다.');
    printUsage();
  }
  if (positional.length > 1) {
    console.error(`Error: 파일은 하나만 지정할 수 있습니다. (받음: ${positional.join(', ')})`);
    printUsage();
  }

  const draftPath = positional[0];
  let html;
  try {
    html = fs.readFileSync(draftPath, 'utf8');
  } catch (err) {
    console.error(`Error: 초안 파일을 읽을 수 없음 (${draftPath}): ${err.message}`);
    process.exit(1);
  }

  const uploadPath = get('--upload-result');
  let uploadResult;
  if (uploadPath) {
    uploadResult = readJson(uploadPath, '--upload-result');
    const shape = validateUploadResult(uploadResult, `--upload-result "${uploadPath}"`);
    if (!shape.ok) {
      console.error(`Error: ${shape.error}`);
      process.exit(1);
    }
  }

  const format = get('--format') || 'text';
  if (format !== 'text' && format !== 'json') {
    console.error(`Error: --format은 text 또는 json이어야 합니다. (받음: "${format}")`);
    printUsage();
  }

  const result = lintDraftHtml(html, { uploadResult, strict: has('--strict') });

  if (format === 'json') {
    console.log(JSON.stringify({ file: draftPath, ...result }, null, 2));
  } else {
    const report = formatLintReport(result);
    if (report) console.log(report);
    console.log(`stats: ${JSON.stringify(result.stats)}`);
    if (result.stats.dimensionCheck === 'skipped') {
      console.log('참고: --upload-result 미지정 — img width/height 실제 치수 대조를 건너뛰었습니다.');
    } else if (result.stats.dimensionCheck !== 'ok') {
      console.log(`참고: 치수 대조 커버리지 ${result.stats.dimensionCheck} — 일부 이미지가 업로드 결과와 매칭되지 않았습니다.`);
    }
    if (result.ok) {
      console.log(`통과 (error 0건, warn ${result.warnings.length}건)`);
    }
  }

  if (!result.ok) process.exit(8);
}

if (require.main === module) {
  main();
}
