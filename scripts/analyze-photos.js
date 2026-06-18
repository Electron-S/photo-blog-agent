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

// 다른 세션/모델이 이미 채운 파일이면 재분석하지 않는다 (모델 간 핸드오프 지점).
if (fs.existsSync(outputPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    if (existing && typeof existing.analyzed_by_model_capability === 'string') {
      console.error(`Photo analysis already exists at ${outputPath} (capability: ${existing.analyzed_by_model_capability}). Skipping.`);
      process.exit(0);
    }
  } catch (err) {
    console.error(`Warning: existing file ${outputPath} exists but could not be parsed (${err.message}). Proceeding to overwrite.`);
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
  console.error(`Error: failed to write ${outputPath}: ${err.message}`);
  process.exit(2);
}
