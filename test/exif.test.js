const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dmsToDecimal,
  exifDateToKstString,
  normalizeGps,
  parseArgv,
  parseExifDate,
  summarizeDates,
} = require('../lib/exif');

test('parseExifDate — EXIF 문자열 포맷', () => {
  assert.equal(parseExifDate('2026:05:09 14:23:00'), '2026-05-09T14:23:00+09:00');
  assert.equal(parseExifDate('2026-05-09 14:23:00'), null);
  assert.equal(parseExifDate('2026:05:09'), null);
  assert.equal(parseExifDate(''), null);
  assert.equal(parseExifDate(null), null);
  assert.equal(parseExifDate(undefined), null);
  assert.equal(parseExifDate(new Date()), null);
});

test('exifDateToKstString — 실행 머신 타임존에 영향받지 않음', () => {
  // exif-reader는 로컬시각 값을 UTC 필드에 담아준다. 그 벽시계 값을 그대로
  // 되꺼내야 하며, 실행 머신 타임존이 개입하면 안 된다.
  const d = new Date(Date.UTC(2026, 4, 9, 14, 23, 0));
  assert.equal(exifDateToKstString(d), '2026-05-09T14:23:00+09:00');

  // zero-padding
  assert.equal(
    exifDateToKstString(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))),
    '2026-01-02T03:04:05+09:00',
  );

  assert.equal(exifDateToKstString(new Date('invalid')), null);
  assert.equal(exifDateToKstString(null), null);
  assert.equal(exifDateToKstString('2026:05:09 14:23:00'), null);
});

test('dmsToDecimal', () => {
  assert.equal(dmsToDecimal([37, 30, 0]), 37.5);
  assert.equal(dmsToDecimal([0, 0, 3600]), 1);
  assert.equal(dmsToDecimal(37.5), 37.5);
  assert.equal(dmsToDecimal([37, 30]), null);
  assert.equal(dmsToDecimal(['37', 30, 0]), null);
  assert.equal(dmsToDecimal([NaN, 0, 0]), null);
  assert.equal(dmsToDecimal(Infinity), null);
  assert.equal(dmsToDecimal(null), null);
});

test('normalizeGps — 배열형/숫자형 둘 다', () => {
  assert.deepEqual(
    normalizeGps({ GPSLatitude: [37, 30, 0], GPSLongitude: [127, 6, 0] }),
    { lat: 37.5, lng: 127.1 },
  );
  assert.deepEqual(
    normalizeGps({ GPSLatitude: 37.5, GPSLongitude: 127.1 }),
    { lat: 37.5, lng: 127.1 },
  );
});

test('normalizeGps — S/W 부호 반전', () => {
  assert.deepEqual(
    normalizeGps({
      GPSLatitude: [33, 51, 0], GPSLatitudeRef: 'S',
      GPSLongitude: [151, 12, 0], GPSLongitudeRef: 'E',
    }),
    { lat: -33.85, lng: 151.2 },
  );
  assert.deepEqual(
    normalizeGps({
      GPSLatitude: [40, 0, 0], GPSLatitudeRef: 'N',
      GPSLongitude: [74, 0, 0], GPSLongitudeRef: 'W',
    }),
    { lat: 40, lng: -74 },
  );
});

test('normalizeGps — 범위 초과와 결측은 null', () => {
  const warned = [];
  const warn = (m) => warned.push(m);

  assert.equal(normalizeGps({ GPSLatitude: [200, 0, 0], GPSLongitude: [0, 0, 0] }, 'x', warn), null);
  assert.match(warned[0], /out of range/);

  assert.equal(normalizeGps({ GPSLatitude: [0, 0, 0], GPSLongitude: [200, 0, 0] }), null);
  assert.equal(normalizeGps({}), null);
  assert.equal(normalizeGps(null), null);

  warned.length = 0;
  assert.equal(normalizeGps({ GPSLatitude: 'bad', GPSLongitude: 'bad' }, 'y', warn), null);
  assert.match(warned[0], /Unexpected GPS DMS format/);
});

test('summarizeDates — 최빈 날짜, 동률이면 이른 날짜', () => {
  assert.deepEqual(
    summarizeDates([
      { date: '2026-05-11T10:00:00+09:00' },
      { date: '2026-05-10T10:00:00+09:00' },
      { date: '2026-05-10T11:00:00+09:00' },
    ]),
    { primaryDate: '2026-05-10', primaryDateSourceCount: 2, dateRange: '2026-05-10 ~ 2026-05-11' },
  );

  // 동률 → 이른 날짜. 사진 순서가 바뀌어도 같은 결과여야 한다 (멱등성).
  const tie = [{ date: '2026-05-11T00:00:00+09:00' }, { date: '2026-05-10T00:00:00+09:00' }];
  assert.equal(summarizeDates(tie).primaryDate, '2026-05-10');
  assert.equal(summarizeDates([...tie].reverse()).primaryDate, '2026-05-10');
});

test('summarizeDates — 단일/빈 입력과 날짜 없는 사진', () => {
  assert.deepEqual(
    summarizeDates([{ date: '2026-05-10T10:00:00+09:00' }]),
    { primaryDate: '2026-05-10', primaryDateSourceCount: 1, dateRange: '2026-05-10' },
  );
  assert.deepEqual(
    summarizeDates([]),
    { primaryDate: null, primaryDateSourceCount: 0, dateRange: null },
  );
  assert.deepEqual(
    summarizeDates([{ date: null }, { date: null }]),
    { primaryDate: null, primaryDateSourceCount: 0, dateRange: null },
  );
  // 일부만 날짜가 있는 경우
  assert.equal(summarizeDates([{ date: null }, { date: '2026-05-10T00:00:00+09:00' }]).primaryDate, '2026-05-10');
});

test('parseArgv', () => {
  assert.deepEqual(
    parseArgv(['a.jpg', 'b.jpg', '--output', 'out.json']),
    { imagePaths: ['a.jpg', 'b.jpg'], values: { '--output': 'out.json' }, outputPath: 'out.json', error: null },
  );
  assert.equal(parseArgv(['a.jpg']).outputPath, null);
  assert.match(parseArgv(['a.jpg', '--output']).error, /requires a value/);
  assert.match(parseArgv(['a.jpg', '--output', '--x']).error, /requires a value/);
  assert.match(parseArgv(['a.jpg', '--nope']).error, /unknown option/);
  // 플래그 뒤 위치 인자도 수집된다
  assert.deepEqual(parseArgv(['--output', 'o.json', 'a.jpg']).imagePaths, ['a.jpg']);
});
