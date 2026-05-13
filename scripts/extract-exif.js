require('dotenv').config();

const path = require('path');
const sharp = require('sharp');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node extract-exif.js <이미지경로1> [이미지경로2] ...');
  console.log('');
  console.log('Outputs JSON with EXIF metadata (date, GPS, camera) for each image.');
  process.exit(1);
}

if (args.length === 0) {
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

function parseGPS(metadata) {
  const gps = metadata.gps || {};
  const lat = gps.latitude;
  const lng = gps.longitude;
  if (lat == null || lng == null) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

async function extractExif(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  const exif = metadata.exif || {};
  const dateStr = parseExifDate(metadata.date) || parseExifDate(exif.DateTimeOriginal) || parseExifDate(exif.DateTime);
  const gps = parseGPS(metadata);
  const camera = [metadata.make, metadata.model].filter(Boolean).join(' ') || null;

  return {
    file: path.basename(imagePath),
    date: dateStr,
    gps,
    camera,
  };
}

async function main() {
  const photos = [];
  let dateRange = null;
  let gpsCenter = null;

  for (const imgPath of args) {
    if (!imgPath.match(/\.(jpg|jpeg|png|webp|heic|heif)$/i)) {
      console.warn(`Skipping non-image file: ${imgPath}`);
      continue;
    }
    try {
      const info = await extractExif(imgPath);
      photos.push(info);
    } catch (err) {
      console.error(`Error reading ${imgPath}: ${err.message}`);
      photos.push({ file: path.basename(imgPath), date: null, gps: null, camera: null });
    }
  }

  // Calculate date range
  const dates = photos.map(p => p.date).filter(Boolean).sort();
  if (dates.length > 0) {
    dateRange = dates.length === 1 ? dates[0].slice(0, 10) : `${dates[0].slice(0, 10)} ~ ${dates[dates.length - 1].slice(0, 10)}`;
  }

  // Calculate GPS center point
  const gpsPoints = photos.map(p => p.gps).filter(Boolean);
  if (gpsPoints.length > 0) {
    gpsCenter = {
      lat: Number((gpsPoints.reduce((s, g) => s + g.lat, 0) / gpsPoints.length).toFixed(4)),
      lng: Number((gpsPoints.reduce((s, g) => s + g.lng, 0) / gpsPoints.length).toFixed(4)),
    };
  }

  const result = {
    photos,
    date_range: dateRange,
    gps_center: gpsCenter,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('EXIF extraction failed:', err.message);
  process.exit(1);
});