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

test('GPS ref의 NUL 패딩을 전 분기에서 벗긴다 (정상 좌표를 버리지 않는다)', () => {
  // exif-reader는 ASCII 필드의 **마지막 NUL 하나만** 벗기고, String.trim()은
  // NUL을 지우지 않는다. 그래서 count=3인 세 바이트 ref가 NUL을 달고 도착해
  // 예전 코드가 좌표를 통째로 버렸다 — 정상 사진의 gps_center가 null이 되어
  // 리서치 단계가 장소를 못 찾는다. 그것도 회귀다.
  const NUL = String.fromCodePoint(0);
  const SEOUL = { GPSLatitude: [37, 33, 36], GPSLongitude: [126, 58, 40] };
  const EXPECT = { lat: 37.56, lng: 126.977778 };

  const variants = [
    ['NUL 없음', 'N', 'E'],
    ['NUL 1개', `N${NUL}`, `E${NUL}`],
    ['NUL 2개', `N${NUL}${NUL}`, `E${NUL}${NUL}`],
    ['공백+NUL', `N ${NUL}`, `E ${NUL}`],
    ['Buffer', Buffer.from(`N${NUL}${NUL}`, 'latin1'), Buffer.from(`E${NUL}${NUL}`, 'latin1')],
    ['Uint8Array', new Uint8Array([0x4E, 0, 0]), new Uint8Array([0x45, 0, 0])],
    ['배열', [`N${NUL}`], [`E${NUL}`]],
  ];
  for (const [label, latRef, lngRef] of variants) {
    assert.deepEqual(
      normalizeGps({ ...SEOUL, GPSLatitudeRef: latRef, GPSLongitudeRef: lngRef }),
      EXPECT,
      `${label}: 정상 좌표를 버림`,
    );
  }
  // 부호 반전도 유지
  assert.deepEqual(
    normalizeGps({
      GPSLatitude: [33, 52, 4],
      GPSLongitude: [70, 40, 0],
      GPSLatitudeRef: `S${NUL}${NUL}`,
      GPSLongitudeRef: `W${NUL}${NUL}`,
    }),
    { lat: -33.867778, lng: -70.666667 },
  );
  // 여전히 잘못된 ref는 거부한다
  assert.equal(normalizeGps({ ...SEOUL, GPSLatitudeRef: 'X', GPSLongitudeRef: 'Y' }), null);
  assert.equal(normalizeGps({ ...SEOUL, GPSLatitudeRef: NUL, GPSLongitudeRef: NUL }), null);
});

// --- 22차 리뷰 회귀 ---

test('checkDatePlausible — 존재하지 않는 날짜를 타당하다고 하지 않는다', () => {
  // 이 파일에 이미 isValidCalendarDate가 있는데 checkDatePlausible만 그것을 부르지
  // 않아, 달력에 없는 날짜가 "타당"으로 통과했다 (실측: 2026-02-30·2026-04-31·
  // 2026-02-29 전부 null = 타당).
  //
  // 이 함수는 **EXIF 경로의 검증기**다 — extract-exif가 이걸로 date_status를 정하므로
  // 통과한 값은 `ok`가 되어 primary_date가 되고, 폴더 경로로 공개 저장소에 push되고,
  // 본문에 "지난 2월 30일"로 쓰이고, --slug-from-date로 Blogger URL에 **영구 고정**된다.
  const { checkDatePlausible } = require('../lib/slug');
  for (const bad of ['2026-02-30', '2026-04-31', '2026-02-29', '2026-06-31', '2026-13-01', '2026-00-10', '2026-05-00']) {
    assert.match(String(checkDatePlausible(bad)), /(존재하지 않는|형식)/,
      `${bad}를 타당하다고 판정함`);
  }
  // 이 테스트의 관심사는 **달력 유효성**이지 타당 범위가 아니므로 now를 고정한다.
  // (첫 시도는 '2026-05-10'을 하드코딩해서, npm run test:clock이 시계를 2년 뒤로
  //  돌리자 "미래 날짜"로 거부돼 실패했다 — 코드가 아니라 테스트의 시간 종속이었다.)
  const at = { now: new Date('2026-06-01T00:00:00Z') };
  // 윤년은 정확히 구별한다
  assert.equal(checkDatePlausible('2024-02-29', at), null, '2024년은 윤년인데 거부함');
  assert.match(String(checkDatePlausible('2026-02-29', at)), /존재하지 않는/, '2026년은 윤년이 아님');
  // 정상 날짜는 그대로 통과
  assert.equal(checkDatePlausible('2026-05-10', at), null);
});

test('checkDatePlausible — 세 검증기가 같은 판정을 낸다', () => {
  // 달력 검사가 lib/slug.js·lib/session-state.js·scripts/upload-images.js에 각각
  // 손으로 복제돼 있었고, 그 사이에 checkDatePlausible만 검사가 없었다. 그래서
  // **되돌릴 수 없는 단계(공개 저장소 push·URL 고정)가 통과하고 되돌릴 수 있는
  // 단계(session-state)가 exit 9로 죽는** 순서가 났다. SLUG_RE를 하나로 모은 것과
  // 같은 이유로 같은 실수를 막는다 — 정본은 isValidCalendarDate 하나다.
  const { checkDatePlausible, isValidCalendarDate } = require('../lib/slug');
  const { defaultState } = require('../lib/session-state');

  for (const d of ['2026-02-30', '2026-04-31', '2026-02-29', '2024-02-29', '2026-05-10']) {
    const [y, mo, dd] = d.split('-').map(Number);
    const calendarOk = isValidCalendarDate(y, mo, dd);
    // checkDatePlausible이 달력 사유로 거부하는지
    const plausibleMsg = checkDatePlausible(d);
    const rejectedForCalendar = plausibleMsg !== null && /존재하지 않는/.test(plausibleMsg);
    assert.equal(rejectedForCalendar, !calendarOk,
      `${d}: isValidCalendarDate=${calendarOk} 인데 checkDatePlausible은 ${JSON.stringify(plausibleMsg)}`);

    // session-state의 assertPrimaryDate도 같은 판정이어야 한다.
    // **날짜 이외의 사유로 던진 것을 "날짜 거부"로 오독하지 않는다** — 첫 시도에서
    // normalizeState가 다른 필수 필드 때문에 던져 2024-02-29를 거부한 것으로 보였다.
    let stateError = null;
    try {
      defaultState('t', { primary_date: d });
    } catch (e) { stateError = e.message; }
    const stateRejectedForDate = stateError !== null && /달력 날짜/.test(stateError);
    assert.equal(stateRejectedForDate, !calendarOk,
      `${d}: session-state 판정이 다름 (error=${JSON.stringify(stateError)})`);
  }
});

test('summarizeDates — date_status가 ok인 사진만 primary_date 후보다', () => {
  // 예전에는 `!== 'implausible'` denylist였는데 date_status는 parse_error·read_error·
  // missing도 된다. 그리고 상태를 정하는 extract-exif의 우선순위가 **parse_error를
  // implausible보다 먼저** 보므로, 파싱이 깨진 사진에 1899-11-30이 실려 오면 그 값이
  // primary_date가 됐다 (실측: 그 조합에 primaryDate = "1899-11-30").
  //
  // 오늘은 도달 불가지만(파싱이 깨지면 date가 null이 된다) 그건 다른 파일의 구현
  // 세부에 기댄 안전이고, primary_date는 Blogger URL로 영구 고정되는 값이다.
  const BAD = '1899-11-30T00:00:00+09:00';
  for (const status of ['implausible', 'parse_error', 'read_error', 'missing']) {
    assert.equal(
      summarizeDates([{ date: BAD, date_status: status }]).primaryDate,
      null,
      `date_status="${status}"인 사진이 primary_date 후보가 됨`,
    );
  }
  // ok는 후보다 (summarizeDates는 선언된 상태를 신뢰한다 — 타당성 판정은 호출자 몫)
  assert.equal(summarizeDates([{ date: BAD, date_status: 'ok' }]).primaryDate, '1899-11-30');

  // date_status가 없는 입력은 계속 받는다 (필드 도입 전 형식의 metadata JSON 호환)
  assert.equal(summarizeDates([{ date: '2026-05-10T10:00:00+09:00' }]).primaryDate, '2026-05-10');

  // 섞였을 때 ok만 센다
  assert.equal(summarizeDates([
    { date: BAD, date_status: 'parse_error' },
    { date: '2026-05-10T10:00:00+09:00', date_status: 'ok' },
  ]).primaryDate, '2026-05-10');
});
