// lib/naver-dom.js — 브라우저 없이 검증 가능한 순수 판정 로직과 조회 실패 처리.
//
// 이 파일의 헤더는 "silent skip 금지"를 선언한다. 그 선언이 실제로 코드에
// 걸려 있는지를 여기서 고정한다 — 조회 실패를 "없음"으로 뭉개면 이미지가 한 장도
// 안 올라간 글이 정상 종료로 끝난다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { countImages, isNaverHostedImage, lastImageSrc } = require('../lib/naver-dom');
const { NAVER_EXIT } = require('../lib/naver-errors');

const frameWith = (fn) => ({ locator: fn });
const okFrame = (count, src) => frameWith(() => ({
  count: async () => count,
  nth: () => ({ getAttribute: async () => src }),
}));
const failFrame = (message) => frameWith(() => ({
  count: async () => { throw new Error(message); },
}));
// **혼재 프레임.** 앞 후보는 0건을 정상 조회하고 나머지는 실패한다.
// all-ok / all-fail만 보는 테스트로는 "부분 실패를 0으로 뭉개는" 결함을 잡을 수 없다 —
// 실제 사고 시나리오가 정확히 이것이다(업로드 폴링 중 후보 순회 도중 프레임 detach).
const mixedFrame = (okSelectors, message) => frameWith((sel) => ({
  count: async () => {
    if (okSelectors.includes(sel)) return 0;
    throw new Error(message);
  },
  nth: () => ({ getAttribute: async () => null }),
}));

test('isNaverHostedImage — 호스트에 앵커된다 (플레이스홀더를 업로드 완료로 보지 않는다)', () => {
  // "실제로 네이버 서버에 올라갔다"의 유일한 증거이므로 오탐이 곧 거짓 초록이다.
  // 예전 목록의 마지막 항목 /\.pstatic\.net/ 이 앞의 두 패턴을 무의미하게 만들고
  // 문자열 어디에나 매칭됐다.
  for (const src of ['https://postfiles.pstatic.net/x.jpg', 'https://blogfiles.pstatic.net/a/b.png',
    'http://postfiles.pstatic.net:443/x', 'https://mblogthumb-phinf.postfiles.pstatic.net/y.jpg']) {
    assert.equal(isNaverHostedImage(src), true, `${src} 를 놓침`);
  }
  for (const src of [
    'https://ssl.pstatic.net/spinner.gif',        // 업로드 중 플레이스홀더
    'https://static.pstatic.net/p.png',
    'https://evil.com/?x=postfiles.pstatic.net/a', // 경로/쿼리에 섞인 문자열
    'https://notpostfiles.pstatic.net/x',
    'blob:https://blog.naver.com/abc',             // 아직 클라이언트 메모리
    'data:image/gif;base64,AAA',
    '', null, undefined,
  ]) {
    assert.equal(isNaverHostedImage(src), false, `${src} 를 업로드 완료로 오인`);
  }
});

test('countImages — 조회 성공 후의 0건과 조회 실패를 구별한다', async () => {
  assert.equal(await countImages(okFrame(0)), 0);
  assert.equal(await countImages(okFrame(3)), 3);

  // 프레임 detach·세션 만료가 "이미지 없음"과 같은 값이 되면 안 된다
  await assert.rejects(
    () => countImages(failFrame('Frame was detached')),
    (err) => err.exitCode === NAVER_EXIT.SELECTOR && /알 수 없습니다/.test(err.message),
  );
  // 우리 레지스트리의 오타는 DOM 변경과 다른 사건이다
  await assert.rejects(
    () => countImages(failFrame('Unknown engine "bogus" while parsing selector')),
    (err) => err.exitCode === NAVER_EXIT.SELECTOR && /셀렉터 문법 오류/.test(err.message),
  );
});

test('lastImageSrc — "img가 없다"와 "src가 없다"를 구별한다', async () => {
  assert.deepEqual(await lastImageSrc(okFrame(0)), { present: false, src: null });
  assert.deepEqual(await lastImageSrc(okFrame(2, 'https://postfiles.pstatic.net/x.jpg')),
    { present: true, src: 'https://postfiles.pstatic.net/x.jpg' });
  // img는 삽입됐는데 src가 아직 없다 = 업로드 진행 중. "이미지 없음"이 아니다.
  assert.deepEqual(await lastImageSrc(okFrame(1, null)), { present: true, src: null });

  await assert.rejects(
    () => lastImageSrc(failFrame('Target page, context or browser has been closed')),
    (err) => err.exitCode === NAVER_EXIT.SELECTOR,
  );
});

test('부분 조회 실패는 0건이 아니라 "모른다" — must와 같은 규칙', async () => {
  // 예전 규칙은 `probeErrors.length === candidates.length`, 즉 후보가 **전부**
  // 실패해야 죽었다. 첫 후보가 0을 정상 조회하면 조건이 거짓이 되어 0을 반환하고
  // probeErrors는 버려졌다 — 같은 입력에 must는 exit 12를 낸다.
  const { SELECTORS } = require('../lib/naver-selectors');
  const comp = mixedFrame([SELECTORS.imageComponent.candidates[0]], 'Frame was detached');
  const elem = mixedFrame([SELECTORS.imageElement.candidates[0]], 'Frame was detached');

  await assert.rejects(
    () => countImages(comp),
    (err) => err.exitCode === NAVER_EXIT.SELECTOR && /알 수 없습니다/.test(err.message),
    'countImages가 부분 실패를 0으로 뭉갬',
  );
  await assert.rejects(
    () => lastImageSrc(elem),
    (err) => err.exitCode === NAVER_EXIT.SELECTOR,
    'lastImageSrc가 부분 실패를 "이미지 없음"으로 뭉갬',
  );

  // 긍정 결과를 얻었다면 조회 실패가 섞여 있어도 답을 안다 — 여기서는 죽지 않는다
  const foundDespiteFailure = frameWith((sel) => ({
    count: async () => {
      if (sel === SELECTORS.imageComponent.candidates[0]
        || sel === SELECTORS.imageElement.candidates[0]) throw new Error('detached');
      return 2;
    },
    nth: () => ({ getAttribute: async () => 'https://postfiles.pstatic.net/x.jpg' }),
  }));
  assert.equal(await countImages(foundDespiteFailure), 2);
  assert.deepEqual(await lastImageSrc(foundDespiteFailure),
    { present: true, src: 'https://postfiles.pstatic.net/x.jpg' });
});
