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

// 다른 세션/모델이 이미 채운 파일이면 재분석하지 않는다 (모델 간 핸드오프 지점).
if (fs.existsSync(outputPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    if (existing && typeof existing.analyzed_by_model_capability === 'string') {
      console.error(`Photo analysis already exists at ${outputPath} (capability: ${existing.analyzed_by_model_capability}). Skipping.`);
      process.exit(0);
    }
    if (hasAnalysisContent(existing)) {
      // capability는 아직 안 찍혔지만 내용이 들어 있다 = 진행 중인 분석이다.
      // 덮어쓰지 않고 그대로 둔다 — 이어서 채우는 것이 맞다.
      console.error(`Photo analysis in progress at ${outputPath} (analyzed_by_model_capability가 아직 null이지만 내용이 채워져 있습니다). Skipping.`);
      console.error('  이어서 남은 사진을 Read/Edit으로 채우고, 끝나면 analyzed_by_model_capability를 세팅하세요.');
      console.error('  처음부터 다시 만들려면 이 파일을 직접 지우고 재실행하세요.');
      process.exit(0);
    }
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

const skeleton = {
  schema_version: 1,
  analyzed_at: null,
  analyzed_by_model_capability: null,
  photos,
  overall_impression: null,
};

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
