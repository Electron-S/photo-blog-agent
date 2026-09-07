require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const exifReader = require('exif-reader');
const {
  SUPPORTED_IMAGE_RE,
  exifDateToKstString,
  normalizeGps,
  parseArgv,
  parseExifDate,
  summarizeDates,
} = require('../lib/exif');
const { checkDatePlausible } = require('../lib/slug');
const { errFull } = require('../lib/err-text');

function printUsage() {
  console.log('Usage: node extract-exif.js <이미지경로1> [이미지경로2] ... [--output <path>]');
  console.log('');
  console.log('Options:');
  console.log('  --output <path>  Save JSON result to file (e.g. tmp/metadata-2026-05-09.json)');
  console.log('');
  console.log('종료 코드: 0=성공, 1=일반 실패, 2=--output 쓰기 실패, 3=지원 이미지 없음');
  process.exit(1);
}

async function extractExif(imagePath) {
  const metadata = await sharp(imagePath).metadata();

  // sharp returns metadata.exif as a raw Buffer — parse it with exif-reader
  let parsed = {};
  let exif_status = 'none';
  if (metadata.exif) {
    try {
      parsed = exifReader(metadata.exif);
      exif_status = 'ok';
    } catch (err) {
      console.error(`EXIF parse warning for ${path.basename(imagePath)}: ${errFull(err)}`);
      exif_status = 'parse_error';
    }
  }

  // exif-reader uses PascalCase IFD names: Image, Photo, GPSInfo
  const img = parsed.Image || parsed.image || {};
  const exif = parsed.Photo || parsed.exif || {};
  const gpsData = parsed.GPSInfo || parsed.gps || {};

  const dateObj = exif.DateTimeOriginal || exif.DateTimeDigitized || img.DateTime || null;
  const dateStr = typeof dateObj === 'string'
    ? parseExifDate(dateObj)
    : exifDateToKstString(dateObj);

  const gps = normalizeGps(gpsData, path.basename(imagePath), (msg) => console.error(msg));

  const make = String(img.Make || '').trim();
  const model = String(img.Model || '').trim();
  const camera = [make, model].filter(Boolean).join(' ') || null;

  return {
    file: path.basename(imagePath),
    date: dateStr,
    gps,
    camera,
    exif_status,
    timezone_assumed: dateStr ? 'Asia/Seoul (+09:00)' : null,
  };
}

async function main() {
  // argv 파싱은 main() 안에서 한다. 모듈 최상위에서 파싱하고 process.exit()을
  // 부르면 이 파일을 require하는 것만으로 프로세스가 죽어 테스트가 불가능해진다.
  const { imagePaths, outputPath, error } = parseArgv(process.argv.slice(2));
  if (error) {
    console.error(error);
    printUsage();
  }
  if (imagePaths.length === 0) {
    console.error('Error: at least one image path is required');
    printUsage();
  }

  const photos = [];

  for (const imgPath of imagePaths) {
    if (!SUPPORTED_IMAGE_RE.test(imgPath)) {
      console.warn(`Skipping non-image file: ${imgPath}`);
      continue;
    }
    try {
      const info = await extractExif(imgPath);
      // 카메라 시계가 초기화되면 exif-reader가 `0000:00:00`을 **1899-11-30**으로
      // 준다. 달력상 유효하므로 예전에는 date_status "ok"가 되어 그 날짜가
      // primary_date → Blogger URL로 영구 고정됐다. 값을 버리지 않고
      // implausible로 표시해, summarizeDates가 primary_date로 뽑지 않게 한다.
      const plausibilityError = info.date ? checkDatePlausible(info.date.slice(0, 10)) : null;
      const date_status = info.exif_status === 'parse_error' ? 'parse_error'
        : (plausibilityError ? 'implausible' : (info.date ? 'ok' : 'missing'));
      if (plausibilityError) {
        console.error(`Warning: ${path.basename(imgPath)}의 EXIF 날짜가 타당하지 않습니다 — ${plausibilityError}`);
      }
      photos.push({ ...info, date_status });
    } catch (err) {
      console.error(`Error reading ${imgPath}: ${errFull(err)}`);
      photos.push({
        file: path.basename(imgPath),
        date: null,
        gps: null,
        camera: null,
        date_status: 'read_error',
      });
    }
  }

  const { primaryDate, primaryDateSourceCount, dateRange } = summarizeDates(photos);

  const readErrors = photos.filter((p) => p.date_status === 'read_error').length;
  if (readErrors > 0) {
    console.error(`Warning: ${readErrors} photo(s) could not be read. primary_date may be unreliable.`);
  }

  const implausible = photos.filter((p) => p.date_status === 'implausible').length;
  if (implausible > 0) {
    console.error(`Warning: ${implausible}장의 EXIF 날짜가 타당 범위를 벗어나 primary_date 계산에서 제외했습니다.`);
  }

  const validPhotos = photos.filter((p) => p.date_status !== 'read_error');
  const photosWithDate = validPhotos.filter((p) => p.date_status === 'ok').length;
  if (validPhotos.length > 0 && photosWithDate * 2 < validPhotos.length) {
    console.error(`Warning: EXIF 날짜를 가진 사진이 ${photosWithDate}/${validPhotos.length}장에 불과합니다. primary_date 신뢰도가 낮습니다.`);
  }

  const gpsPoints = photos.map((p) => p.gps).filter(Boolean);
  const gpsCenter = gpsPoints.length > 0 ? {
    lat: Number((gpsPoints.reduce((s, g) => s + g.lat, 0) / gpsPoints.length).toFixed(4)),
    lng: Number((gpsPoints.reduce((s, g) => s + g.lng, 0) / gpsPoints.length).toFixed(4)),
  } : null;

  const result = {
    photos,
    primary_date: primaryDate,
    primary_date_source_count: primaryDateSourceCount,
    primary_date_total_photos: photos.length,
    date_range: dateRange,
    gps_center: gpsCenter,
  };

  if (photos.length === 0) {
    console.error('Error: no supported images found (supported: jpg/jpeg/png/webp/heic/heif)');
    if (outputPath) {
      console.error(`Skipped writing empty result to ${outputPath}`);
    }
    process.exit(3);
  }

  const json = JSON.stringify(result, null, 2);

  if (outputPath) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json, 'utf-8');
      console.error(`Metadata saved to ${outputPath}`);
    } catch (err) {
      console.error(`Error: EXIF extraction succeeded but failed to write ${outputPath}: ${errFull(err)}`);
      console.error('JSON result was not written to file or stdout — caller must check exit code (2).');
      process.exit(2);
    }
  } else {
    console.log(json);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('EXIF extraction failed:', errFull(err));
    process.exit(1);
  });
}

module.exports = { extractExif };
