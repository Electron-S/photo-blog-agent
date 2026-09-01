// EXIF 값 정규화 — 외부 의존성 없음.
// sharp/exif-reader의 I/O는 scripts/extract-exif.js가 담당하고, 여기에는
// "읽어온 값을 어떻게 해석하는가"만 둔다 (테스트 가능한 순수 함수).

const KST_OFFSET = '+09:00';

// EXIF DateTime 문자열 포맷: "2026:05:09 14:23:00"
function parseExifDate(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min, s] = match;
  return `${y}-${m}-${d}T${h}:${min}:${s}${KST_OFFSET}`;
}

// EXIF 날짜에는 타임존이 없다. exif-reader는 로컬시각 값을 UTC 필드에 그대로
// 담아 Date로 준다. 따라서 getUTC*로 원래 벽시계 값을 되꺼낸 뒤 KST로 라벨링한다.
// (Date를 그냥 toISOString()하면 실행 머신의 타임존만큼 어긋난다.)
function exifDateToKstString(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${dateObj.getUTCFullYear()}-${p(dateObj.getUTCMonth() + 1)}-${p(dateObj.getUTCDate())}`
    + `T${p(dateObj.getUTCHours())}:${p(dateObj.getUTCMinutes())}:${p(dateObj.getUTCSeconds())}${KST_OFFSET}`;
}

// exif-reader의 GPS 좌표는 [도, 분, 초] 배열이거나 이미 10진수인 숫자다.
function dmsToDecimal(dms) {
  if (typeof dms === 'number' && Number.isFinite(dms)) return dms;
  if (Array.isArray(dms) && dms.length >= 3
      && dms.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return dms[0] + dms[1] / 60 + dms[2] / 3600;
  }
  return null;
}

// GPSInfo → { lat, lng } 또는 null.
// warn은 선택적 로거 (기본은 무음 — 순수하게 쓰고 싶은 호출자를 위해).
function normalizeGps(gpsData, label = '', warn = () => {}) {
  if (!gpsData || typeof gpsData !== 'object') return null;
  const rawLat = gpsData.GPSLatitude;
  const rawLng = gpsData.GPSLongitude;
  if (rawLat === undefined || rawLng === undefined) return null;

  let lat = dmsToDecimal(rawLat);
  let lng = dmsToDecimal(rawLng);
  if (lat === null || lng === null) {
    warn(`Unexpected GPS DMS format for ${label}: lat=${JSON.stringify(rawLat)} lng=${JSON.stringify(rawLng)}`);
    return null;
  }

  if (gpsData.GPSLatitudeRef === 'S') lat = -lat;
  if (gpsData.GPSLongitudeRef === 'W') lng = -lng;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    warn(`GPS coordinates out of range for ${label}: lat=${lat} lng=${lng}`);
    return null;
  }
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

// primary_date = 가장 많이 촬영된 날짜. 동률이면 가장 이른 날짜.
// 이 값이 블로그 글의 방문 날짜이자 업로드 폴더 경로의 날짜이므로,
// 사진 순서가 바뀌어도 같은 결과가 나와야 한다 (결정적).
function summarizeDates(photos) {
  const dateDays = (photos || [])
    .map((p) => (typeof p?.date === 'string' ? p.date.slice(0, 10) : null))
    .filter(Boolean)
    .sort();

  if (dateDays.length === 0) {
    return { primaryDate: null, primaryDateSourceCount: 0, dateRange: null };
  }

  const dateRange = dateDays[0] === dateDays[dateDays.length - 1]
    ? dateDays[0]
    : `${dateDays[0]} ~ ${dateDays[dateDays.length - 1]}`;

  const counts = new Map();
  for (const d of dateDays) counts.set(d, (counts.get(d) || 0) + 1);
  const [topDate, topCount] = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];

  return { primaryDate: topDate, primaryDateSourceCount: topCount, dateRange };
}

const SUPPORTED_IMAGE_RE = /\.(jpg|jpeg|png|webp|heic|heif)$/i;

// CLI 인자 파싱 (순수). { imagePaths, outputPath, error } 반환.
function parseArgv(argv, flagsWithValue = ['--output']) {
  const imagePaths = [];
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flagsWithValue.includes(a)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        return { imagePaths, values, error: `Error: ${a} requires a value` };
      }
      values[a] = value;
      i += 1;
      continue;
    }
    if (a.startsWith('--')) {
      return { imagePaths, values, error: `Error: unknown option ${a}` };
    }
    imagePaths.push(a);
  }
  return { imagePaths, values, outputPath: values['--output'] || null, error: null };
}

module.exports = {
  KST_OFFSET,
  SUPPORTED_IMAGE_RE,
  dmsToDecimal,
  exifDateToKstString,
  normalizeGps,
  parseArgv,
  parseExifDate,
  summarizeDates,
};
