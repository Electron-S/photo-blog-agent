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

  // **반구 지시자가 없으면 좌표를 알 수 없다.** 예전에는 `=== 'S'`/`=== 'W'`만
  // 봐서 ref가 없거나 Buffer·배열·소문자면 전부 조용히 N/E로 간주했다.
  // 실측: {GPSLatitude:[33,52,4], GPSLongitude:[70,40,0]} → 산티아고(-33.87,-70.67)
  // 대신 파키스탄(33.87, 70.67)이 나왔고 경고도 없었다. 이 값이 gps_center로
  // 리서치 단계의 장소 식별에 들어가므로, 틀린 좌표는 글 전체를 엉뚱하게 만든다.
  // DMS 파싱 실패와 범위 초과에는 경고가 있는데 여기만 없었다.
  // NUL 제거를 **모든 분기에서** 한다. `String.prototype.trim()`은 `\u0000`을
  // 지우지 않고, exif-reader는 ASCII 필드의 **마지막 NUL 하나만** 벗긴다
  // (node_modules/exif-reader/index.js). 그래서 count=3인 `"N\0\0"`은
  // `"N\u0000"`으로 도착해 예전 코드가 좌표를 통째로 버렸다 — 정상 사진의
  // gps_center가 null이 되어 리서치 단계가 장소를 못 찾는다 (실측: 실제
  // TIFF/EXIF를 exif-reader에 통과시켜 확인).
  const clean = (v) => v.replace(/\u0000+/g, '').trim().toUpperCase();
  const refOf = (raw) => {
    if (typeof raw === 'string') return clean(raw);
    // exif-reader는 구현/버전에 따라 Buffer나 1글자 배열을 줄 수 있다.
    if (Buffer.isBuffer(raw)) return clean(raw.toString('latin1'));
    if (ArrayBuffer.isView(raw)) return clean(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1'));
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') return clean(raw[0]);
    return null;
  };
  const latRef = refOf(gpsData.GPSLatitudeRef);
  const lngRef = refOf(gpsData.GPSLongitudeRef);
  if (!['N', 'S'].includes(latRef) || !['E', 'W'].includes(lngRef)) {
    warn(`GPS 반구 지시자를 읽지 못해 좌표를 버립니다 (${label}): `
      + `GPSLatitudeRef=${JSON.stringify(gpsData.GPSLatitudeRef)} `
      + `GPSLongitudeRef=${JSON.stringify(gpsData.GPSLongitudeRef)}. `
      + 'N/E로 가정하면 남반구·서반구 좌표가 정반대 지점이 됩니다.');
    return null;
  }
  if (latRef === 'S') lat = -lat;
  if (lngRef === 'W') lng = -lng;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    warn(`GPS coordinates out of range for ${label}: lat=${lat} lng=${lng}`);
    return null;
  }
  // (0, 0)은 GPS 미측위(no fix) 센티널이다. 대서양 한가운데를 방문지로 넘기면
  // 리서치 단계가 엉뚱한 장소를 찾는다.
  if (lat === 0 && lng === 0) {
    warn(`GPS 좌표가 (0, 0)입니다 (${label}) — 측위 실패 센티널로 보고 버립니다.`);
    return null;
  }
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

// primary_date = 가장 많이 촬영된 날짜. 동률이면 가장 이른 날짜.
// 이 값이 블로그 글의 방문 날짜이자 업로드 폴더 경로의 날짜이므로,
// 사진 순서가 바뀌어도 같은 결과가 나와야 한다 (결정적).
// primary_date는 폴더 경로이자 Blogger URL이 된다. 타당하지 않은 날짜
// (date_status='implausible' — 카메라 시계 초기화 센티널 등)는 **후보에서 뺀다.**
// 값 자체는 photos[]에 남으므로 사람이 확인할 수 있다.
function summarizeDates(photos) {
  // **denylist가 아니라 allowlist로 판정한다.** 예전에는 `!== 'implausible'`만 걸렀는데
  // `date_status`는 `parse_error`·`read_error`·`missing`도 되고, 상태를 정하는
  // scripts/extract-exif.js의 우선순위가 **`parse_error`를 `implausible`보다 먼저**
  // 본다. 즉 EXIF 파싱이 깨진 사진에 1899-11-30 같은 값이 실려 오면 그 값이
  // primary_date 후보가 된다 (실측: 그 조합에 primaryDate = "1899-11-30").
  //
  // 오늘은 도달 불가다 — 파싱이 깨지면 `parsed`가 `{}`로 남아 date가 null이 되고
  // `.filter(Boolean)`이 지운다. 하지만 그건 **다른 파일의 구현 세부에 기댄 안전**이고,
  // primary_date는 블로그 본문의 방문 날짜이자 Blogger URL로 **영구 고정**되는 값이다.
  // 날짜를 신뢰할 수 있다고 명시한 상태(`ok`)만 후보로 받는다.
  //
  // `date_status`가 아예 없는 입력은 계속 받는다 — 이 필드가 도입되기 전 형식의
  // metadata JSON과 순수 함수로 쓰는 호출자를 깨뜨리지 않기 위한 것이다.
  const dateDays = (photos || [])
    .filter((p) => p?.date_status === undefined || p.date_status === 'ok')
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
