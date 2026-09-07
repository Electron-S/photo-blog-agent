#!/usr/bin/env node
// Scaffolder for photo visual analysis JSON.
// Writes an empty skeleton with one entry per supported image.
// The running model is expected to Read each photo and Edit this file
// to fill scene_description / text_visible / notable_objects, then set
// analyzed_at + analyzed_by_model_capability at the top level.
// If the model has no vision, it marks analyzed_by_model_capability="text-only"
// and leaves photo entries with analysis_status="pending" (the model is
// responsible for changing status to "completed" or "skipped_no_vision").

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { errFull } = require('../lib/err-text');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node analyze-photos.js <이미지경로1> [이미지경로2] ... --output <path>');
  console.log('');
  console.log('Options:');
  console.log('  --output <path>  Save JSON skeleton to file (e.g. tmp/photo-analysis-2026-05-29.json)');
  process.exit(1);
}

const FLAGS_WITH_VALUE = new Set(['--output']);
let outputPath = null;
const imagePaths = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (FLAGS_WITH_VALUE.has(a)) {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`Error: ${a} requires a value`);
      printUsage();
    }
    if (a === '--output') outputPath = value;
    i += 1;
    continue;
  }
  if (a.startsWith('--')) {
    console.error(`Error: unknown option ${a}`);
    printUsage();
  }
  imagePaths.push(a);
}

if (imagePaths.length === 0) {
  console.error('Error: at least one image path is required');
  printUsage();
}

if (!outputPath) {
  console.error('Error: --output is required (e.g. tmp/photo-analysis-YYYY-MM-DD.json)');
  printUsage();
}

// 골격 이외의 내용이 하나라도 들어 있는지 — "이 파일에 사람(모델)의 작업이
// 담겼는가"를 판정한다.
//
// **판정 기준이 `analyzed_by_model_capability`가 문자열인지가 아니어야 한다.**
// 워크플로우는 모델에게 photos[]를 Edit으로 먼저 채우고 **그 다음** 최상위
// capability를 세팅하라고 지시한다. 그래서 가장 흔한 중단 상태가
// "capability는 null인데 scene_description은 채워짐"이고, 예전 판정은 그걸
// 빈 골격으로 보고 **백업도 경고도 없이 덮어썼다** (실측 확인).
// CLAUDE.md가 이 파일을 "모델 간 핸드오프 지점"으로 규정하는데, 핸드오프 대상
// 데이터가 exit 0으로 사라지는 셈이었다.
function hasAnalysisContent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.analyzed_by_model_capability === 'string') return true;
  if (obj.analyzed_at || obj.overall_impression) return true;
  const photos = Array.isArray(obj.photos) ? obj.photos : [];
  return photos.some((ph) => ph && typeof ph === 'object' && (
    (ph.analysis_status !== undefined && ph.analysis_status !== 'pending')
    || ph.scene_description || ph.text_visible || ph.notable_objects
    || ph.dominant_colors || ph.people_count !== null && ph.people_count !== undefined
  ));
}

// 이미 내용이 있는 파일은 **덮어쓰지 않고 병합한다.**
//
// 그냥 skip하면 사진을 추가해 재실행하는 정상 시나리오(prompts/workflow-steps.md의
// "같은 slug로 재호출")에서 **새 사진이 조용히 분석 대상에서 빠진다** (실측:
// a.jpg만 있는 파일에 a.jpg b.jpg로 재실행 → photos는 여전히 1개).
// 그렇다고 덮어쓰면 채워진 분석이 사라진다. 둘 다 조용한 손실이므로 병합이 답이다:
//   - 이미 있는 항목은 **그대로 둔다** (채워진 내용 보존)
//   - 새 사진만 골격으로 추가한다
//   - 이번 호출에 없는 기존 항목도 지우지 않는다 — 지우면 그게 또 조용한 손실이다.
//     대신 그런 항목이 있다는 사실을 알린다.
let existingState = null;
if (fs.existsSync(outputPath)) {
  try {
    existingState = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  } catch (err) {
    // 이 파일에는 비전 모델이 채운 scene_description 등이 들어 있을 수 있다.
    // 그냥 덮어쓰면 그 작업이 조용히 사라진다 (lib/session-state.js는 같은 상황에서
    // 원본을 보존하고 exit 9로 멈춘다). 여기서는 골격이 재생성 가능하므로 워크플로우를
    // 막지는 않되, 원본을 백업해 두고 그 사실을 알린다.
    let backup = null;
    try {
      backup = `${outputPath}.corrupt-${Date.now()}`;
      fs.copyFileSync(outputPath, backup);
    } catch (copyErr) {
      console.error(`Error: 손상된 ${outputPath}를 백업하지 못했습니다 (${errFull(copyErr)}). 덮어쓰지 않고 중단합니다.`);
      process.exit(2);
    }
    console.error(`Warning: existing file ${outputPath} exists but could not be parsed (${errFull(err)}).`);
    console.error(`  원본을 ${backup} 로 백업하고 새 골격으로 덮어씁니다. 비전 분석 결과가 들어 있었다면 백업을 확인하세요.`);
  }
}

const supported = [];
for (const p of imagePaths) {
  if (/\.(jpg|jpeg|png|webp|heic|heif)$/i.test(p)) {
    supported.push(p);
  } else {
    console.warn(`Skipping non-image file: ${p}`);
  }
}

if (supported.length === 0) {
  console.error('Error: no supported images found (supported: jpg/jpeg/png/webp/heic/heif)');
  process.exit(3);
}

const photos = supported.map((p) => ({
  file: path.basename(p),
  path: path.resolve(p),
  analysis_status: 'pending',
  scene_description: null,
  text_visible: null,
  people_count: null,
  dominant_colors: null,
  notable_objects: null,
}));

// --- 병합 ---
// 키는 절대 경로. 같은 파일이 다른 상대 경로로 넘어와도 하나로 본다.
const existingPhotos = existingState && Array.isArray(existingState.photos)
  ? existingState.photos.filter((ph) => ph && typeof ph === 'object')
  : [];
const existingByPath = new Map(existingPhotos.map((ph) => [ph.path || ph.file, ph]));
const incomingKeys = new Set(photos.map((ph) => ph.path));

const merged = [];
const added = [];
for (const ph of photos) {
  const prev = existingByPath.get(ph.path);
  if (prev) merged.push(prev);            // 채워진 내용을 그대로 보존한다
  else { merged.push(ph); added.push(ph.file); }
}
// 이번 호출에 없지만 파일에 있던 항목 — 지우지 않고 뒤에 붙인다.
const kept = existingPhotos.filter((ph) => !incomingKeys.has(ph.path || ph.file));
merged.push(...kept);

const alreadyDone = existingState && typeof existingState.analyzed_by_model_capability === 'string';
if (existingState && hasAnalysisContent(existingState) && added.length === 0) {
  // 새로 추가할 사진이 없다 = 재실행이 아무것도 바꾸지 않는다. 그대로 둔다.
  console.error(alreadyDone
    ? `Photo analysis already exists at ${outputPath} (capability: ${existingState.analyzed_by_model_capability}). Skipping.`
    : `Photo analysis in progress at ${outputPath} (capability는 아직 null이지만 내용이 채워져 있습니다). Skipping.`);
  if (!alreadyDone) {
    console.error('  이어서 남은 사진을 Read/Edit으로 채우고, 끝나면 analyzed_by_model_capability를 세팅하세요.');
  }
  console.error('  처음부터 다시 만들려면 이 파일을 직접 지우고 재실행하세요.');
  process.exit(0);
}

const skeleton = {
  schema_version: 1,
  analyzed_at: (existingState && existingState.analyzed_at) || null,
  analyzed_by_model_capability: (existingState && existingState.analyzed_by_model_capability) || null,
  photos: merged,
  overall_impression: (existingState && existingState.overall_impression) || null,
};

if (added.length && existingState && hasAnalysisContent(existingState)) {
  console.error(`기존 분석 ${merged.length - added.length - kept.length}건을 보존하고 새 사진 ${added.length}건을 추가했습니다: ${added.join(', ')}`);
  if (alreadyDone) {
    console.error(`  analyzed_by_model_capability가 "${existingState.analyzed_by_model_capability}"로 이미 찍혀 있습니다 — 추가된 사진을 채운 뒤 그대로 두세요.`);
  }
}
if (kept.length) {
  console.error(`Warning: 이번 호출에 없지만 파일에 있던 항목 ${kept.length}건을 그대로 남겼습니다: ${kept.map((ph) => ph.file).join(', ')}`);
  console.error('  의도한 것이 아니라면 사진 목록을 확인하세요 (조용히 지우지 않습니다).');
}

const json = JSON.stringify(skeleton, null, 2);

try {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, json, 'utf-8');
  console.error(`Photo analysis skeleton saved to ${outputPath}`);
  console.error(`Next: the running model should Read each photo and Edit the output JSON to fill scene_description/text_visible/notable_objects.`);
} catch (err) {
  console.error(`Error: failed to write ${outputPath}: ${errFull(err)}`);
  process.exit(2);
}
