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
  const NE = { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' };
  assert.deepEqual(
    normalizeGps({ GPSLatitude: [37, 30, 0], GPSLongitude: [127, 6, 0], ...NE }),
    { lat: 37.5, lng: 127.1 },
  );
  assert.deepEqual(
    normalizeGps({ GPSLatitude: 37.5, GPSLongitude: 127.1, ...NE }),
    { lat: 37.5, lng: 127.1 },
  );
});

test('normalizeGps — 반구 지시자가 없으면 N/E로 가정하지 않고 버린다', () => {
  // `=== 'S'`/`=== 'W'`만 보던 예전 코드는 ref 누락·Buffer·소문자를 전부 조용히
  // N/E로 간주했다. 실측: 산티아고(-33.87,-70.67) 좌표가 파키스탄(33.87,70.67)이
  // 되고 경고도 없었다. 이 값이 gps_center로 리서치 단계의 장소 식별에 들어간다.
  const warned = [];
  const warn = (m) => warned.push(m);
  const SANTIAGO = { GPSLatitude: [33, 52, 4], GPSLongitude: [70, 40, 0] };

  assert.equal(normalizeGps({ ...SANTIAGO }, 'x', warn), null, 'ref 없이 통과');
  assert.match(warned[0], /반구 지시자/);
  assert.equal(normalizeGps({ ...SANTIAGO, GPSLatitudeRef: 'S' }), null, '한쪽만 있어도 통과');
  assert.equal(normalizeGps({ ...SANTIAGO, GPSLatitudeRef: 'X', GPSLongitudeRef: 'Y' }), null);

  // 실제 EXIF 리더가 주는 여러 표현을 모두 받는다
  for (const [latRef, lngRef] of [['S', 'W'], ['s', 'w'], [' S ', ' W '],
    [Buffer.from('S'), Buffer.from('W')], [['S'], ['W']]]) {
    assert.deepEqual(
      normalizeGps({ ...SANTIAGO, GPSLatitudeRef: latRef, GPSLongitudeRef: lngRef }),
      { lat: -33.867778, lng: -70.666667 },
      `ref 표현 ${JSON.stringify(String(latRef))} 처리 실패`,
    );
  }
});

test('normalizeGps — (0,0)은 측위 실패 센티널이라 버린다', () => {
  // 대서양 한가운데를 방문지로 넘기면 리서치가 엉뚱한 장소를 찾는다.
  const warned = [];
  assert.equal(normalizeGps({
    GPSLatitude: [0, 0, 0], GPSLongitude: [0, 0, 0],
    GPSLatitudeRef: 'N', GPSLongitudeRef: 'E',
  }, 'z', (m) => warned.push(m)), null);
  assert.match(warned[0], /측위 실패/);
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

  const NE = { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' };
  assert.equal(normalizeGps({ GPSLatitude: [200, 0, 0], GPSLongitude: [1, 0, 0], ...NE }, 'x', warn), null);
  assert.match(warned[0], /out of range/);

  assert.equal(normalizeGps({ GPSLatitude: [1, 0, 0], GPSLongitude: [200, 0, 0], ...NE }), null);
  assert.equal(normalizeGps({}), null);
  assert.equal(normalizeGps(null), null);

  warned.length = 0;
  assert.equal(normalizeGps({ GPSLatitude: 'bad', GPSLongitude: 'bad', ...NE }, 'y', warn), null);
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
