require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const exifReader = require('exif-reader');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node extract-exif.js <이미지경로1> [이미지경로2] ... [--output <path>]');
  console.log('');
  console.log('Options:');
  console.log('  --output <path>  Save JSON result to file (e.g. tmp/metadata-2026-05-09.json)');
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

function parseExifDate(dateStr) {
  if (!dateStr) return null;
  // EXIF DateTime format: "2026:05:09 14:23:00"
  const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min, s] = match;
  return `${y}-${m}-${d}T${h}:${min}:${s}+09:00`;
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
    } catch (e) {
      console.error(`EXIF parse warning for ${path.basename(imagePath)}: ${e.message}`);
      exif_status = 'parse_error';
    }
  }

  // exif-reader uses PascalCase IFD names: Image, Photo, GPSInfo
  const img = parsed.Image || parsed.image || {};
  const exif = parsed.Photo || parsed.exif || {};
  const gpsData = parsed.GPSInfo || parsed.gps || {};

  // Date: exif-reader returns Date objects (parsed as UTC from local-time EXIF strings)
  const dateObj = exif.DateTimeOriginal || exif.DateTimeDigitized || img.DateTime || null;
  let dateStr = null;
  if (dateObj instanceof Date && !isNaN(dateObj.getTime())) {
    // EXIF dates have no timezone — exif-reader puts local-time values into UTC fields.
    // Extract via getUTC* to recover the original local values, then label as KST (+09:00).
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getUTCDate()).padStart(2, '0');
    const h = String(dateObj.getUTCHours()).padStart(2, '0');
    const min = String(dateObj.getUTCMinutes()).padStart(2, '0');
    const s = String(dateObj.getUTCSeconds()).padStart(2, '0');
    dateStr = `${y}-${m}-${d}T${h}:${min}:${s}+09:00`;
  } else if (typeof dateObj === 'string') {
    dateStr = parseExifDate(dateObj);
  }

  // GPS: exif-reader returns [degrees, minutes, seconds] arrays
  let gps = null;
  const latDMS = gpsData.GPSLatitude;
  const lngDMS = gpsData.GPSLongitude;

  function finalizeGPS(latVal, lngVal) {
    if (gpsData.GPSLatitudeRef === 'S') latVal = -latVal;
    if (gpsData.GPSLongitudeRef === 'W') lngVal = -lngVal;
    if (latVal >= -90 && latVal <= 90 && lngVal >= -180 && lngVal <= 180) {
      return { lat: Number(latVal.toFixed(6)), lng: Number(lngVal.toFixed(6)) };
    }
    console.error(`GPS coordinates out of range for ${path.basename(imagePath)}: lat=${latVal} lng=${lngVal}`);
    return null;
  }

  if (Array.isArray(latDMS) && Array.isArray(lngDMS)
      && latDMS.length >= 3 && lngDMS.length >= 3
      && latDMS.every(v => typeof v === 'number' && isFinite(v))
      && lngDMS.every(v => typeof v === 'number' && isFinite(v))) {
    gps = finalizeGPS(
      latDMS[0] + latDMS[1] / 60 + latDMS[2] / 3600,
      lngDMS[0] + lngDMS[1] / 60 + lngDMS[2] / 3600,
    );
  } else if (typeof latDMS === 'number' && typeof lngDMS === 'number'
      && isFinite(latDMS) && isFinite(lngDMS)) {
    gps = finalizeGPS(latDMS, lngDMS);
  } else if (latDMS !== undefined && lngDMS !== undefined) {
    console.error(`Unexpected GPS DMS format for ${path.basename(imagePath)}: lat=${JSON.stringify(latDMS)} lng=${JSON.stringify(lngDMS)}`);
  }

  // Camera
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
  const photos = [];
  let dateRange = null;
  let primaryDate = null;
  let gpsCenter = null;

  for (const imgPath of imagePaths) {
    if (!imgPath.match(/\.(jpg|jpeg|png|webp|heic|heif)$/i)) {
      console.warn(`Skipping non-image file: ${imgPath}`);
      continue;
    }
    try {
      const info = await extractExif(imgPath);
      const date_status = info.exif_status === 'parse_error' ? 'parse_error'
        : info.date ? 'ok' : 'missing';
      photos.push({ ...info, date_status });
    } catch (err) {
      console.error(`Error reading ${imgPath}: ${err.message}`);
      photos.push({
        file: path.basename(imgPath),
        date: null,
        gps: null,
        camera: null,
        date_status: 'read_error',
      });
    }
  }

  let primaryDateSourceCount = 0;
  const dateDays = photos.map((p) => (p.date ? p.date.slice(0, 10) : null)).filter(Boolean).sort();
  if (dateDays.length > 0) {
    dateRange = dateDays[0] === dateDays[dateDays.length - 1]
      ? dateDays[0]
      : `${dateDays[0]} ~ ${dateDays[dateDays.length - 1]}`;

    // primary_date = 가장 많이 촬영된 날짜. 동률이면 가장 이른 날짜.
    const counts = new Map();
    for (const d of dateDays) counts.set(d, (counts.get(d) || 0) + 1);
    const [topDate, topCount] = [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
    primaryDate = topDate;
    primaryDateSourceCount = topCount;
  }

  const readErrors = photos.filter((p) => p.date_status === 'read_error').length;
  if (readErrors > 0) {
    console.error(`Warning: ${readErrors} photo(s) could not be read. primary_date may be unreliable.`);
  }

  const validPhotos = photos.filter((p) => p.date_status !== 'read_error');
  const photosWithDate = validPhotos.filter((p) => p.date_status === 'ok').length;
  if (validPhotos.length > 0 && photosWithDate * 2 < validPhotos.length) {
    console.error(`Warning: EXIF 날짜를 가진 사진이 ${photosWithDate}/${validPhotos.length}장에 불과합니다. primary_date 신뢰도가 낮습니다.`);
  }

  const gpsPoints = photos.map((p) => p.gps).filter(Boolean);
  if (gpsPoints.length > 0) {
    gpsCenter = {
      lat: Number((gpsPoints.reduce((s, g) => s + g.lat, 0) / gpsPoints.length).toFixed(4)),
      lng: Number((gpsPoints.reduce((s, g) => s + g.lng, 0) / gpsPoints.length).toFixed(4)),
    };
  }

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
      const dir = path.dirname(outputPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, json, 'utf-8');
      console.error(`Metadata saved to ${outputPath}`);
    } catch (err) {
      console.error(`Error: EXIF extraction succeeded but failed to write ${outputPath}: ${err.message}`);
      console.error('JSON result was not written to file or stdout — caller must check exit code (2).');
      process.exit(2);
    }
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error('EXIF extraction failed:', err.message);
  process.exit(1);
});