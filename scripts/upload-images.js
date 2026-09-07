require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { uploadBlogImages, DEFAULT_MAX_SIZE_KB, MAX_SIZE_KB_LIMIT } = require('../lib/github-assets');
const { errFull, reportFatal } = require('../lib/err-text');
const { checkDatePlausible } = require('../lib/slug');
const { canonicalSlugError } = require('../lib/asset-paths');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node upload-images.js <image1> [image2] ... --slug <slug> [--metadata path] [--date YYYY-MM-DD] [--work-dir dir] [--max-size-kb N] [--output path] [--local-only]');
  console.log('');
  console.log('Options:');
  console.log('  --metadata      extract-exif.js 출력 JSON 경로. primary_date를 게시일로 사용');
  console.log('  --date          게시일 (--metadata의 primary_date보다 우선; 둘 다 없거나 null이면 exit 5)');
  console.log('  --slug          URL 슬러그 (필수). 영문/숫자/하이픈. 폴더 경로의 유일한 식별자다');
  console.log('  --work-dir      압축 이미지 임시 디렉토리 (기본값: ./tmp/assets/<date>-<hash>)');
  console.log(`  --max-size-kb   AdSense 이미지 크기 기준 KB (기본값: ${DEFAULT_MAX_SIZE_KB})`);
  console.log('  --output        결과 JSON 저장 경로 (예: tmp/upload-<slug>.json). lint-draft --upload-result에 사용');
  console.log('  --local-only    GitHub 업로드/검증 생략, 압축까지만 (네이버 발행 경로)');
  console.log('');
  console.log('날짜 우선순위: --date > --metadata의 primary_date > (없으면 exit 5, 멱등성 보호)');
  console.log('종료 코드: 0=전부 정상, 1=인자 오류(--slug 누락/비정규형 포함)·업로드/검증 실패,');
  console.log('           2=--output 쓰기 실패, 4=품질 저하(fallback/oversize/치수 결손/계약 위반), 5=날짜 출처 미상');
  process.exit(1);
}

const FLAGS_WITH_VALUE = new Set(['--metadata', '--date', '--slug', '--work-dir', '--max-size-kb', '--output']);
const BOOLEAN_FLAGS = new Set(['--local-only']);

// upload-images는 위치 인자(이미지 경로)를 받으므로 lib/cli-args.js의 getArg를 그대로
// 쓸 수 없다. 대신 같은 검증 규칙(값 누락·플래그 중복·미지 플래그 거부)을 여기서 지킨다.
function parseArgs() {
  const imagePaths = [];
  const values = new Map();
  const flags = new Set();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      if (values.has(a)) {
        console.error(`Error: 플래그 "${a}"가 중복 지정되었습니다.`);
        printUsage();
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`Error: ${a} requires a value`);
        printUsage();
      }
      values.set(a, value);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      flags.add(a);
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`Error: unknown option ${a}`);
      printUsage();
    }
    imagePaths.push(a);
  }

  return { imagePaths, get: (n) => (values.has(n) ? values.get(n) : null), has: (n) => flags.has(n) };
}

function parseMaxSizeKB(raw) {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_SIZE_KB_LIMIT) {
    console.error(`Error: --max-size-kb must be a positive integer (1-${MAX_SIZE_KB_LIMIT}), got "${raw}"`);
    process.exit(1);
  }
  return n;
}

// --date는 폴더 경로에 그대로 박혀 멱등성의 기준이 된다. 형식이 틀린 값이
// uploadBlogImages 깊은 곳에서 throw되면 exit 1이 되어 exit 5(날짜 출처 미상)와
// 의미가 섞이므로, CLI 단에서 먼저 거른다.
function validateExplicitDate(raw) {
  if (raw == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error(`Error: --date 형식이 YYYY-MM-DD가 아닙니다: "${raw}"`);
    process.exit(1);
  }
  const [y, mo, d] = raw.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) {
    console.error(`Error: --date "${raw}"는 유효한 달력 날짜가 아닙니다.`);
    process.exit(1);
  }
  // --date는 명시적 의사 표시이므로 타당성 밖 날짜도 허용한다. 다만 폴더 경로에
  // 그대로 박히므로 오타인지 의도인지 확인할 수 있게 경고는 남긴다.
  const implausible = checkDatePlausible(raw);
  if (implausible) {
    console.error(`Warning: --date ${implausible}`);
    console.error('  (--date를 명시했으므로 진행합니다 — 폴더 경로에 이 날짜가 그대로 들어갑니다.)');
  }
  return raw;
}

function readMetadataPrimaryDate(metadataPath) {
  if (!metadataPath) return { value: null, reason: 'no_metadata_arg' };
  let raw;
  try {
    raw = fs.readFileSync(metadataPath, 'utf-8');
  } catch (err) {
    console.error(`Error: --metadata 파일을 읽을 수 없음 (${metadataPath}): ${errFull(err)}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: --metadata JSON 파싱 실패 (${metadataPath}): ${errFull(err)}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`Error: --metadata JSON이 객체가 아님 (${metadataPath}). extract-exif.js 출력 형식이 필요.`);
    process.exit(1);
  }
  if (!('primary_date' in parsed)) {
    console.error(`Error: --metadata JSON에 primary_date 키 없음 (${metadataPath}). extract-exif.js 버전을 확인하세요.`);
    process.exit(1);
  }
  const primaryDate = parsed.primary_date;
  if (primaryDate == null) {
    // **원인을 구별한다.** primary_date가 null인 이유는 두 가지이고 조치가 다르다:
    //   (a) EXIF에 날짜가 아예 없다 → 사용자에게 방문 날짜를 물어야 한다
    //   (b) 날짜는 있는데 타당 범위를 벗어났다 (카메라 시계 초기화·미래 날짜)
    //       → 사진에 박힌 값을 보여주고 실제 날짜를 확인해야 한다
    // 예전에는 둘 다 "EXIF 날짜 없는 사진"으로 보고해 (b)에서 엉뚱한 진단이 나갔다.
    const photos = Array.isArray(parsed.photos) ? parsed.photos : [];
    const implausible = photos.filter((ph) => ph && ph.date_status === 'implausible');
    if (implausible.length) {
      return {
        value: null,
        reason: 'metadata_implausible_date',
        detail: implausible.slice(0, 3)
          .map((ph) => `${ph.file || '?'}: ${String(ph.date || '').slice(0, 10)}`)
          .join(', ') + (implausible.length > 3 ? ` … (총 ${implausible.length}장)` : ''),
      };
    }
    return { value: null, reason: 'metadata_no_date' };
  }
  if (typeof primaryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(primaryDate)) {
    console.error(`Error: --metadata primary_date 형식이 YYYY-MM-DD가 아님: "${primaryDate}"`);
    process.exit(1);
  }
  return { value: primaryDate, reason: 'metadata' };
}

async function main() {
  const { imagePaths, get, has } = parseArgs();

  // **usage를 먼저 낸다.** 예전에는 이 검사가 날짜 해석 뒤에 있어서, 인자 없이
  // 실행하면 exit 5(날짜 출처 미상)로 끝나고 usage가 나오지 않았다. 이 저장소의
  // 다른 스크립트는 전부 usage를 내고, CLAUDE.md도 "인자 없이 실행하면 나오는
  // usage로 확인"하라고 안내한다 — 특히 --slug가 필수가 된 뒤로는 usage를 못 보면
  // 무엇을 넘겨야 하는지 알 방법이 없다.
  if (imagePaths.length === 0) {
    console.error('Error: at least one image path is required');
    printUsage();
  }

  const metadata = readMetadataPrimaryDate(get('--metadata'));
  const explicitDate = validateExplicitDate(get('--date'));
  const today = new Date().toISOString().slice(0, 10);

  let date;
  let dateSource;
  if (explicitDate) {
    date = explicitDate;
    dateSource = 'explicit';
    console.error(`[upload-images] 날짜=${date} (--date 명시)`);
  } else if (metadata.value) {
    date = metadata.value;
    dateSource = 'metadata';
    console.error(`[upload-images] 날짜=${date} (EXIF primary_date)`);
  } else {
    const REASONS = {
      metadata_no_date: '--metadata는 제공됐지만 primary_date가 null (EXIF 날짜 없는 사진)',
      metadata_implausible_date: '--metadata의 사진 날짜가 타당 범위를 벗어나 primary_date가 정해지지 않음'
        + ` (카메라 시계 오류 의심: ${metadata.detail})`,
      no_metadata_arg: '--date / --metadata 둘 다 없음',
    };
    const reason = REASONS[metadata.reason] || REASONS.no_metadata_arg;
    console.error(`[upload-images] ERROR: ${reason}. 오늘(${today})로 fallback할 경우 폴더 경로가 작성 시점에 종속되어 멱등성이 깨집니다. 업로드를 중단합니다 (exit 5). 의도된 경우 --date를 명시하세요.`);
    if (metadata.reason === 'metadata_implausible_date') {
      console.error('[upload-images]   위 사진의 EXIF 날짜를 확인하고, 실제 방문 날짜를 --date YYYY-MM-DD로 넘기세요.');
    }
    process.exit(5);
  }

  const slug = get('--slug');
  // **필수이고, 정규형이어야 한다.** 예전에는 생략하면 slug가 리터럴 'post'로
  // 고정되어 같은 날짜의 모든 글이 같은 폴더를 공유했다 — 이미 발행된 글의
  // photo-NN.webp를 원격에서 제자리 덮어쓰기 한다. usage는 "첫 번째 이미지
  // 파일명에서 생성"이라고 적혀 있었지만 그런 코드 경로가 없었다.
  // 파일명 유도는 일부러 하지 않는다 — 넘긴 파일 순서에 따라 폴더가 달라져
  // CLAUDE.md가 요구하는 멱등성이 깨진다. 사람이 한 번 정하는 것이 맞다.
  //
  // 검증은 발행(publish-post)·세션(session-state)과 **같은 SLUG_RE**를 쓰고,
  // 추가로 slugify가 손대지 않는 값만 받는다. 그러지 않으면 `trip-경복궁`처럼
  // 부분만 사라지는 slug가 통과해 서로 다른 글이 같은 폴더로 수렴한다.
  const slugError = canonicalSlugError(slug);
  if (slugError) {
    console.error(`Error: --slug ${slugError}`);
    console.error('  slug은 폴더 경로 posts/{date}-{hash}의 유일한 식별자입니다.');
    console.error('  잘못되면 같은 날짜의 다른 글과 같은 폴더를 써서 이미 발행된 이미지를 덮어씁니다.');
    console.error('  예: --slug seokchon-lake-spring (세션 내 한 번 정하고 계속 사용)');
    process.exit(1);
  }
  const workDir = get('--work-dir');
  const outputPath = get('--output');
  const localOnly = has('--local-only');
  const maxSizeKB = parseMaxSizeKB(get('--max-size-kb'));

  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) {
      console.error(`Error: file not found: ${imgPath}`);
      process.exit(1);
    }
  }

  const options = { date };
  if (slug) options.slug = slug;
  if (workDir) options.workDir = workDir;
  if (maxSizeKB !== undefined) options.maxSizeKB = maxSizeKB;
  if (localOnly) options.localOnly = true;

  console.error(`${localOnly ? 'Compressing' : 'Uploading'} ${imagePaths.length} image(s)...`);
  const { images, summary } = await uploadBlogImages(imagePaths, options);

  const result = {
    date,
    dateSource,
    images: images.map((item) => ({
      index: item.index,
      originalPath: item.originalPath,
      // 로컬 압축본 경로. 네이버 발행이 에디터에 직접 올릴 파일이며,
      // 이게 없으면 하위 단계가 <date>-<hash12> 폴더명을 재계산해야 한다.
      webpPath: item.webpPath ?? null,
      webpUrl: item.webpUrl,
      url: item.url,
      // width/height는 조건부가 아니라 항상 내보낸다. 키가 없으면 초안 작성 모델이
      // "정보 없음"으로 보고 추측하지만, null은 "모른다는 것이 확인됨"이라 추측을 막는다.
      width: item.width ?? null,
      height: item.height ?? null,
      originalBytes: item.originalBytes,
      webpBytes: item.webpBytes,
      // width/height와 같은 이유로 **전부 무조건** 내보낸다. 예전에는 조건부
      // spread라 watermarkApplied가 fallbackUsed일 때만(그때는 항상 false로)
      // 등장했다 — 즉 이 JSON에 `watermarkApplied: true`가 한 번도 나오지 않아
      // `if (!img.watermarkApplied)` 같은 자연스러운 검사가 정상 이미지 100%에서
      // 오작동했다. 워터마크는 이 프로젝트의 이미지 보호 정책 자체다.
      oversize: item.oversize === true,
      fallbackUsed: item.fallbackUsed === true,
      watermarkApplied: item.watermarkApplied === true,
      orientationApplied: item.orientationApplied === true,
      dimensionsError: item.dimensionsError ?? null,
      compressionError: item.compressionError ?? null,
      // 계약 위반(치수를 못 읽음)은 폴백과 조치가 다르다 — 원본 점검이 아니라
      // sharp/파이프라인 점검이다. 이 필드를 빼면 summary.contractViolation만 남고
      // "어느 이미지가 계약 위반인지"는 stderr에만 존재해 영속화되지 않는다.
      contractError: item.contractError ?? null,
      verificationError: item.verificationError ?? null,
      error: item.error ?? null,
    })),
    summary,
  };

  const json = JSON.stringify(result, null, 2);
  console.log(json);

  if (outputPath) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json, 'utf-8');
      console.error(`Upload result saved to ${outputPath}`);
    } catch (err) {
      console.error(`Error: 업로드는 끝났으나 ${outputPath} 쓰기 실패: ${errFull(err)}`);
      console.error('결과 JSON은 stdout에만 있습니다 — 호출자는 exit 2를 확인할 것.');
      process.exit(2);
    }
  }

  if (summary.failed > 0) process.exit(1);
  if (summary.degraded > 0) process.exit(4);
}

main().catch((err) => {
  // message/stack/response.data를 모두 남긴다. 한쪽만 출력하면 결과 매핑 중
  // TypeError가 났을 때 어느 줄인지 알 수 없다.
  // **핸들러가 err를 직접 만지지 않는다** — reportFatal이 전부 가드한다.
  process.exit(reportFatal(err, 'Upload failed:'));
});
