const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { lintDraftHtml, parseStyle } = require('../lib/lint-draft');

const FIG_STYLE = 'margin:1.5em 0;text-align:center;position:relative;';
const IMG_ATTRS = 'loading="lazy" width="1024" height="768" style="max-width:100%;height:auto;"';

function figure(n = 1, extra = '') {
  return `<figure style="${FIG_STYLE}">`
    + `<img ${IMG_ATTRS} src="https://x/photo-0${n}.webp" alt="구체적인 장면 설명" ${extra}>`
    + '<figcaption>골목 끝에서 마주친 간판이 인상적이었다.</figcaption>'
    + '</figure>';
}

// 1,800자를 넘기는 본문 채우기 (문장 경계가 있는 자연스러운 형태)
function filler(sentences = 40) {
  const s = '이 골목은 낮과 밤의 표정이 꽤 다르다. 낮에는 조용하고 밤에는 사람이 몰린다. ';
  return `<p>${s.repeat(Math.ceil(sentences / 2))}</p>`;
}

function doc(body) {
  return `<p>지난 오월 초에 다녀온 기록이다. 사진부터 정리해 둔다.</p>${body}`;
}

function rulesOf(result) {
  return {
    errors: result.errors.map((e) => e.rule),
    warnings: [...new Set(result.warnings.map((w) => w.rule))],
  };
}

function lintFull(body) {
  return lintDraftHtml(doc(`${body}${filler(60)}<h3>다녀와서 남은 생각</h3>${filler(20)}<h3>다시 간다면</h3>${filler(20)}<h3>알고 가면 좋다</h3>${filler(20)}`));
}

test('parseStyle — 공백 차이를 흡수한다', () => {
  // parseStyle은 프로토타입 오염을 막으려 null-prototype 객체를 반환하므로
  // deepEqual 대신 항목을 비교한다.
  const entries = (v) => Object.entries(parseStyle(v)).sort();
  assert.deepEqual(entries('max-width:100%;height:auto;'), [['height', 'auto'], ['max-width', '100%']]);
  assert.deepEqual(entries('max-width: 100% ; height : auto'), [['height', 'auto'], ['max-width', '100%']]);
  assert.deepEqual(entries(''), []);
});

// --- 필수 회귀 3건 (계획에 명시) ---

test('회귀: "확인 필요"는 금칙어가 아니다 (권장 표기)', () => {
  // system-rules.md가 불확실한 정보를 "확인 필요"로 표기하라고 요구한다.
  // 부분 매치로 잡으면 프롬프트가 요구한 올바른 동작을 lint가 막는다.
  const r = lintFull(`${figure(1)}<p>가격은 확인 필요. 영업시간도 확인 필요하다. 공식 페이지를 참고하자.</p>`);
  assert.ok(!r.errors.some((e) => e.rule === 'no-placeholder'), JSON.stringify(rulesOf(r)));

  // 반면 플레이스홀더 전체 문자열은 차단된다
  const bad = lintFull(`${figure(1)}<p>확인 필요: AI 초안 생성 결과 라고 남아 있다. 고쳐야 한다.</p>`);
  assert.ok(bad.errors.some((e) => e.rule === 'no-placeholder'));
});

test('회귀: "방금 튀겨낸"은 통과, "방금 다녀왔다"는 위반', () => {
  // 잡으려는 건 작성 시점을 방문 시점으로 혼동한 표현이지 부사 "방금"이 아니다.
  const ok = lintFull(`${figure(1)}<p>방금 튀겨낸 치킨텐더가 나왔다. 막 구운 빵도 함께였다.</p>`);
  assert.ok(!ok.errors.some((e) => e.rule === 'no-writing-date-expression'), JSON.stringify(rulesOf(ok)));

  for (const bad of ['오늘 다녀왔다', '방금 다녀왔다', '오늘 방문했다', '방금 전에 다녀왔다']) {
    const r = lintFull(`${figure(1)}<p>${bad}. 기록을 남긴다.</p>`);
    assert.ok(
      r.errors.some((e) => e.rule === 'no-writing-date-expression'),
      `"${bad}"를 잡지 못함`,
    );
  }
});

test('회귀: style 공백 차이는 error가 아니다', () => {
  // "max-width: 100%; height: auto;"는 브라우저 관점에서 정규형과 완전히 동일하다.
  // 실질 위반이 아닌 것으로 발행을 막으면 안 된다. 공백만 다르면 warn조차 없다.
  const spaced = `<figure style="margin: 1.5em 0; text-align: center; position: relative;">`
    + `<img loading="lazy" width="1024" height="768" style="max-width: 100%; height: auto;" src="https://x/photo-01.webp" alt="설명">`
    + '<figcaption>공백만 다른 표기다.</figcaption></figure>';
  const r = lintFull(`${spaced}<p>이어지는 문장이다. 두 문장 이상이다.</p>`);
  assert.ok(!r.errors.some((e) => e.rule === 'img-style-required'), JSON.stringify(rulesOf(r)));
  assert.ok(!r.errors.some((e) => e.rule === 'figure-style-required'));
  assert.ok(!r.warnings.some((w) => w.rule === 'style-canonical-form'));
});

test('선언 순서가 다르거나 선언이 추가되면 warn (동작은 동일)', () => {
  const reordered = `<figure style="${FIG_STYLE}">`
    + `<img loading="lazy" width="1024" height="768" style="height:auto;max-width:100%;" src="https://x/photo-01.webp" alt="설명">`
    + '<figcaption>순서만 다른 표기다.</figcaption></figure>';
  const r = lintFull(`${reordered}<p>이어지는 문장이다. 두 문장 이상이다.</p>`);
  assert.ok(!r.errors.some((e) => e.rule === 'img-style-required'));
  assert.ok(r.warnings.some((w) => w.rule === 'style-canonical-form'), JSON.stringify(rulesOf(r)));
});

// --- img 속성 ---

test('img 필수 속성 누락은 각각 error', () => {
  const cases = [
    ['loading="lazy"를 뺀 경우', 'img-loading-lazy', `<img width="1024" height="768" style="max-width:100%;height:auto;" src="https://x/photo-01.webp" alt="설명">`],
    ['width/height 없음', 'img-width-height', `<img loading="lazy" style="max-width:100%;height:auto;" src="https://x/photo-01.webp" alt="설명">`],
    ['width가 정수가 아님', 'img-width-height', `<img loading="lazy" width="auto" height="768" style="max-width:100%;height:auto;" src="https://x/photo-01.webp" alt="설명">`],
    ['style 없음', 'img-style-required', `<img loading="lazy" width="1024" height="768" src="https://x/photo-01.webp" alt="설명">`],
    ['alt 없음', 'img-alt-nonempty', `<img ${IMG_ATTRS} src="https://x/photo-01.webp">`],
    ['alt 공백', 'img-alt-nonempty', `<img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="   ">`],
    ['webp 아님', 'img-src-webp', `<img ${IMG_ATTRS} src="https://x/photo-01.jpg" alt="설명">`],
  ];
  for (const [label, rule, img] of cases) {
    const body = `<figure style="${FIG_STYLE}">${img}<figcaption>캡션 문장이다.</figcaption></figure><p>다음 문장이다. 두 문장이다.</p>`;
    const r = lintFull(body);
    assert.ok(r.errors.some((e) => e.rule === rule), `${label}: ${rule} 미검출 — ${JSON.stringify(rulesOf(r))}`);
  }
});

test('width="0"은 양의 정수가 아니므로 error (CLS 방지에 무의미)', () => {
  const body = `<figure style="${FIG_STYLE}"><img loading="lazy" width="0" height="0" style="max-width:100%;height:auto;" src="https://x/photo-01.webp" alt="설명"><figcaption>캡션.</figcaption></figure><p>문장. 또 문장.</p>`;
  assert.ok(lintFull(body).errors.some((e) => e.rule === 'img-width-height'));
});

test('쿼리스트링이 붙은 webp는 통과', () => {
  const body = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp?v=2" alt="설명"><figcaption>캡션이다.</figcaption></figure><p>다음 문장. 또 문장.</p>`;
  assert.ok(!lintFull(body).errors.some((e) => e.rule === 'img-src-webp'));
});

test('img가 figure 밖에 있으면 error', () => {
  const r = lintFull(`<img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"><p>문장이다. 또 문장이다.</p>`);
  assert.ok(r.errors.some((e) => e.rule === 'img-in-figure'));
});

// --- figure 구조 ---

test('figure에 position:relative가 없으면 error', () => {
  const body = `<figure style="margin:1.5em 0;text-align:center;"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"><figcaption>캡션.</figcaption></figure><p>문장. 또 문장.</p>`;
  const r = lintFull(body);
  const f = r.errors.find((e) => e.rule === 'figure-style-required');
  assert.ok(f);
  assert.match(f.message, /position:relative/);
});

test('figcaption은 정확히 1개', () => {
  const none = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"></figure><p>문장. 또 문장.</p>`;
  assert.ok(lintFull(none).errors.some((e) => e.rule === 'figure-figcaption-once'));

  const two = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"><figcaption>하나.</figcaption><figcaption>둘.</figcaption></figure><p>문장. 또 문장.</p>`;
  assert.ok(lintFull(two).errors.some((e) => e.rule === 'figure-figcaption-once'));
});

test('제네릭 캡션 차단', () => {
  for (const cap of ['사진 1', '사진1', 'photo 2', '이미지 3', '사진 1.']) {
    const body = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"><figcaption>${cap}</figcaption></figure><p>문장. 또 문장.</p>`;
    assert.ok(lintFull(body).errors.some((e) => e.rule === 'figcaption-generic'), `"${cap}" 미검출`);
  }
  // 숫자가 들어가도 문장이면 통과
  const okBody = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명"><figcaption>사진 1층 로비에서 본 풍경이다.</figcaption></figure><p>문장. 또 문장.</p>`;
  assert.ok(!lintFull(okBody).errors.some((e) => e.rule === 'figcaption-generic'));
});

// --- AdSense 배치 ---

test('이미지 직후 h3는 error이고, 같은 figure를 text-after-figure가 중복 보고하지 않는다', () => {
  const r = lintFull(`${figure(1)}<h3>바로 오는 부제목</h3><p>문장. 또 문장.</p>`);
  assert.ok(r.errors.some((e) => e.rule === 'no-h3-after-figure'));
  assert.ok(!r.errors.some((e) => e.rule === 'text-after-figure'), '중복 보고됨');
});

test('이미지 다음 텍스트가 2문장 미만이면 error', () => {
  // 누적은 다음 figure/h3에서 멈추므로 h3로 끊어 1문장만 남긴다.
  const r = lintFull(`${figure(1)}<p>한 문장뿐이다</p><h3>여기서 끊긴다</h3>`);
  assert.ok(r.errors.some((e) => e.rule === 'text-after-figure'), JSON.stringify(rulesOf(r)));

  const ok = lintFull(`${figure(1)}<p>첫 문장이다. 둘째 문장이다.</p><h3>여기서 끊긴다</h3>`);
  assert.ok(!ok.errors.some((e) => e.rule === 'text-after-figure'), JSON.stringify(rulesOf(ok)));
});

test('picture/source 태그 금지', () => {
  const r = lintFull(`<picture><source srcset="a.webp"></picture>${figure(1)}<p>문장. 또 문장.</p>`);
  const hits = r.errors.filter((e) => e.rule === 'no-picture-source');
  assert.equal(hits.length, 2);
});

// --- 분량 ---

test('본문 1,800자 미만은 error', () => {
  const r = lintDraftHtml(doc(`${figure(1)}<p>짧은 글이다. 정말 짧다.</p>`));
  assert.ok(r.errors.some((e) => e.rule === 'body-min-chars'));
});

test('본문 2,500자 초과는 warn (차단 아님)', () => {
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장이다. 또 문장이다.</p>${filler(200)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`));
  assert.ok(r.stats.bodyChars > 2500);
  assert.ok(r.warnings.some((w) => w.rule === 'body-max-chars'));
  assert.ok(!r.errors.some((e) => e.rule === 'body-max-chars'));
});

test('1,500자 이상인데 h3가 3개 미만이면 error', () => {
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>하나</h3>${filler(30)}`));
  assert.ok(r.stats.bodyChars >= 1500);
  assert.ok(r.errors.some((e) => e.rule === 'h3-min-count'));
});

// --- 텍스트 금칙 ---

test('이모지는 본문/캡션/alt 어디에 있어도 error', () => {
  const emoji = String.fromCodePoint(0x1F600);
  assert.ok(lintFull(`${figure(1)}<p>좋았다 ${emoji}. 또 문장이다.</p>`).errors.some((e) => e.rule === 'no-emoji'));

  const inAlt = `<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명 ${emoji}"><figcaption>캡션.</figcaption></figure><p>문장. 또 문장.</p>`;
  assert.ok(lintFull(inAlt).errors.some((e) => e.rule === 'no-emoji'));
});

test('warn 문구들', () => {
  const r = lintFull(`${figure(1)}<p>강력 추천하는 곳이다. 개인적으로는 만족스러운 경험이었다. 부인과 함께 갔다.</p>`);
  const w = rulesOf(r).warnings;
  assert.ok(w.includes('overclaim-phrase'));
  assert.ok(w.includes('ai-tell-phrase'));
  assert.ok(w.includes('spouse-wording'));
  assert.ok(r.ok, '이 문구들은 차단하지 않아야 한다');
});

test('a 태그 target/rel warn', () => {
  const r = lintFull(`${figure(1)}<p><a href="https://x.com">공식 홈페이지</a>를 참고하자. 또 문장이다.</p>`);
  assert.ok(r.warnings.some((w) => w.rule === 'link-target-rel'));

  const ok = lintFull(`${figure(1)}<p><a href="https://x.com" target="_blank" rel="noopener noreferrer">공식 홈페이지</a>. 또 문장.</p>`);
  assert.ok(!ok.warnings.some((w) => w.rule === 'link-target-rel'));
});

test('이미지 순서 역전은 warn', () => {
  const r = lintFull(`${figure(2)}<p>문장. 또 문장.</p>${figure(1)}<p>문장. 또 문장.</p>`);
  assert.ok(r.warnings.some((w) => w.rule === 'image-order'));
});

// --- 구조 오류 ---

test('미닫힘 태그는 html-structure error', () => {
  const r = lintDraftHtml(`<figure style="${FIG_STYLE}"><img ${IMG_ATTRS} src="https://x/photo-01.webp" alt="설명">`);
  assert.ok(r.errors.some((e) => e.rule === 'html-structure'));
});

// --- 치수 대조 ---

test('--upload-result 미지정이면 치수 규칙을 건너뛰고 그 사실을 표면화한다', () => {
  const r = lintFull(`${figure(1)}<p>문장. 또 문장.</p>`);
  assert.equal(r.stats.dimensionCheck, 'skipped');
  assert.ok(!r.errors.some((e) => e.rule.startsWith('img-dimensions')));
});

test('치수 불일치는 error', () => {
  const uploadResult = { images: [{ index: 1, url: 'https://x/photo-01.webp', webpUrl: 'https://x/photo-01.webp', width: 768, height: 1024 }] };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  const f = r.errors.find((e) => e.rule === 'img-dimensions-match');
  assert.ok(f, JSON.stringify(rulesOf(r)));
  assert.match(f.message, /1024x768.*768x1024/);
  assert.equal(r.stats.dimensionCheck, 'ok');
});

test('업로드 결과의 치수가 null이면 error (추측한 값이라는 뜻)', () => {
  const uploadResult = { images: [{ index: 1, url: 'https://x/photo-01.webp', width: null, height: null }] };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  assert.ok(r.errors.some((e) => e.rule === 'img-dimensions-unknown'));
});

test('tail 폴백 — 호스트가 달라도 같은 postDir/파일명이면 매칭', () => {
  // uploadAsset이 경로에 encodeURIComponent를 적용하거나 baseUrl이 바뀌어도
  // `{postDir}/photo-NN.webp` 단위로는 같으므로 매칭되어야 한다.
  const uploadResult = {
    images: [{ index: 1, url: 'https://other-host/deep/path/x/photo-01.webp', width: 1024, height: 768 }],
  };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  assert.ok(!r.errors.some((e) => e.rule === 'img-dimensions-match'), JSON.stringify(rulesOf(r)));
  assert.ok(!r.warnings.some((w) => w.rule === 'img-not-in-upload-result'));
  assert.equal(r.stats.dimensionCheck, 'ok');
});

test('폴더가 다르면 매칭하지 않는다 (파일명만 보면 모든 포스트가 서로 매칭된다)', () => {
  // 모든 포스트의 이미지가 photo-01.webp … 이므로 basename만으로 매칭하면
  // 다른 포스트 이미지가 항상 매칭되어, img-not-in-upload-result가 영원히
  // 발동하지 않고 img-dimensions-match는 엉뚱한 사진과 대조해 오진한다.
  const uploadResult = {
    images: [{ index: 1, url: 'https://x/posts/9999-01-01-DIFFERENT/photo-01.webp', width: 1, height: 1 }],
  };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  assert.ok(!r.errors.some((e) => e.rule === 'img-dimensions-match'), '엉뚱한 사진과 대조하면 안 된다');
  assert.ok(r.warnings.some((w) => w.rule === 'img-not-in-upload-result'));
  assert.ok(r.errors.some((e) => e.rule === 'upload-result-no-match'), '한 장도 대조 못 하면 error');
});

test('dimensionCheck는 커버리지를 숫자로 보고한다', () => {
  const body = `${figure(1)}<p>문장. 또 문장.</p>${figure(2)}<p>문장. 또 문장.</p>`;
  const tail = `${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`;
  // 2장 중 1장만 업로드 결과에 있음
  const uploadResult = {
    images: [{ index: 1, url: 'https://x/photo-01.webp', width: 1024, height: 768 }],
  };
  const r = lintDraftHtml(doc(body + tail), { uploadResult });
  assert.equal(r.stats.dimensionCheck, 'partial (1/2)');
  assert.equal(r.stats.dimensionsMatched, 1);
  // 일부라도 대조됐으면 upload-result-no-match는 안 뜬다
  assert.ok(!r.errors.some((e) => e.rule === 'upload-result-no-match'));
});

test('validateUploadResult — 인자 없음과 형식 오류를 구분한다', () => {
  const { validateUploadResult } = require('../lib/lint-draft');
  assert.equal(validateUploadResult({ images: [] }, 'x').ok, true);
  // metadata-*.json을 잘못 넘긴 경우
  assert.equal(validateUploadResult({ photos: [], primary_date: '2026-05-10' }, 'x').ok, false);
  assert.match(validateUploadResult({ photos: [] }, 'x').error, /images 배열이 없습니다/);
  assert.equal(validateUploadResult(null, 'x').ok, false);
  assert.equal(validateUploadResult([], 'x').ok, false);
  assert.equal(validateUploadResult('str', 'x').ok, false);
});

test('업로드 결과에 없는 이미지는 warn', () => {
  const uploadResult = { images: [{ index: 9, url: 'https://x/photo-09.webp', width: 1024, height: 768 }] };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  assert.ok(r.warnings.some((w) => w.rule === 'img-not-in-upload-result'));
});

// --- strict ---

test('--strict는 warn을 error로 승격한다 (우회가 아니라 강화)', () => {
  const body = `${figure(1)}<p>강력 추천한다. 또 문장이다.</p>`;
  assert.ok(lintFull(body).ok);
  const strict = lintDraftHtml(doc(`${body}${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { strict: true });
  assert.ok(!strict.ok);
  assert.equal(strict.warnings.length, 0);
});

// --- 실제 초안 회귀 ---

test('실제 초안 6건 — 계량 회귀 고정', () => {
  const dir = path.join(__dirname, 'fixtures', 'drafts');
  const expected = {
    'current-toscano.html': { chars: 2372, errors: [] },
    'draft-dongdaemun-toy-lantern.html': { chars: 2148, errors: [] },
    'draft-dongdaemun-visit.html': { chars: 1396, errors: ['body-min-chars'] },
    'draft-pancake-house.html': { chars: 2992, errors: [] },
    'draft-seokchon-jbout.html': { chars: 2018, errors: ['h3-min-count'] },
    'draft-toscano.html': { chars: 2356, errors: [] },
  };
  for (const [file, exp] of Object.entries(expected)) {
    const r = lintDraftHtml(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(r.stats.bodyChars, exp.chars, `${file} 글자수`);
    assert.deepEqual(r.errors.map((e) => e.rule), exp.errors, `${file} error 규칙`);
    // 정상 초안에서 figure 뒤 문장 수는 전부 2문장 이상이어야 한다 (오탐 0건)
    for (const n of r.stats.sentencesAfterFigure) {
      assert.ok(n >= 2, `${file}: figure 뒤 문장이 ${n}개`);
    }
  }
});

test('실제 초안에는 구조 오류가 없다', () => {
  const dir = path.join(__dirname, 'fixtures', 'drafts');
  for (const file of fs.readdirSync(dir)) {
    const r = lintDraftHtml(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(!r.errors.some((e) => e.rule === 'html-structure'), `${file}에 구조 오류`);
  }
});

test('bodyChars는 script/style 내용을 세지 않는다', () => {
  // CLAUDE.md가 권장하는 이미지 보호 CSS/JS 블록이 분량으로 세이면
  // "캡션만 길게 써서 1,800자 채우기"와 똑같은 우회로가 열린다.
  const plain = '<p>가나다라마바사아자차카타파하.</p>';
  const withStyle = `${plain}<style>.se-x{position:absolute;top:0;left:0;width:100%;height:100%}</style>`;
  const withScript = `${plain}<script>document.addEventListener('contextmenu', function (e) { e.preventDefault(); });</script>`;
  const base = lintDraftHtml(plain).stats.bodyChars;
  assert.equal(lintDraftHtml(withStyle).stats.bodyChars, base, 'style 내용이 세어짐');
  assert.equal(lintDraftHtml(withScript).stats.bodyChars, base, 'script 내용이 세어짐');
});

test('tailKeyOf — Windows 경로 구분자도 나눈다 (--local-only 매칭)', () => {
  // webpPath는 path.join으로 만들어져 Windows에서 역슬래시가 된다.
  // `/`로만 나누면 전량 미매칭 → upload-result-no-match(error)로 차단됐다.
  const uploadResult = {
    images: [{ index: 1, webpUrl: null, url: null, webpPath: 'C:\\dev\\tmp\\assets\\x\\photo-01.webp', width: 1024, height: 768 }],
  };
  const r = lintDraftHtml(doc(`${figure(1)}<p>문장. 또 문장.</p>${filler(60)}<h3>가</h3>${filler(20)}<h3>나</h3>${filler(20)}<h3>다</h3>${filler(20)}`), { uploadResult });
  assert.equal(r.stats.dimensionCheck, 'ok', JSON.stringify(rulesOf(r)));
  assert.ok(!r.errors.some((e) => e.rule === 'upload-result-no-match'));
});

// --- 7차 리뷰 회귀 ---

test('속성값의 엔티티도 디코드한다 — alt="&nbsp;"가 통과하던 것', () => {
  // 텍스트 쪽 규칙은 전부 decodeEntities를 거치는데 **속성만 예외**였다.
  // 그래서 사실상 빈 alt가 img-alt-nonempty(접근성/AdSense 때문에 존재하는
  // 규칙)를 통과했다. 이제 규칙은 getAttr을 직접 부르지 않고 ctx.attr만 쓴다.
  const FIG = (alt) => '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + `<img src="https://x/p.webp" width="1024" height="768" loading="lazy" alt="${alt}" `
    + 'style="max-width:100%;height:auto;">'
    + '<figcaption>가게 앞에서 본 장면입니다</figcaption></figure>';
  const hasAltError = (alt) => lintDraftHtml(FIG(alt), {}).errors
    .some((e) => e.rule === 'img-alt-nonempty');

  for (const blank of ['&nbsp;', '&#32;', '&#9;', '&#160;', '&#xa0;', ' ', '']) {
    assert.equal(hasAltError(blank), true, `alt="${blank}" 가 통과함`);
  }
  assert.equal(hasAltError('가게 외관 사진'), false);
});

test('src의 엔티티가 디코드돼 브라우저가 요청하는 URL과 같아진다', () => {
  // 브라우저는 `a&amp;b.webp`를 `a&b.webp`로 요청한다. 원문을 HEAD하면
  // 살아 있는 이미지를 깨진 것으로, 혹은 그 반대로 본다.
  const { extractImageUrls } = require('../lib/verify-images');
  assert.deepEqual(extractImageUrls('<img src="https://x/a&amp;b.webp">'), ['https://x/a&b.webp']);
  assert.deepEqual(extractImageUrls('<img src="https://x/a.webp">'), ['https://x/a.webp']);
});

test('규칙이 getAttr을 직접 부르지 않는다 (ctx.attr 봉쇄를 코드로 강제)', () => {
  // `ctx.attr`로 속성 디코드를 통일했지만, `getAttr`이 여전히 import돼 있어
  // 모든 규칙의 렉시컬 스코프 안에 있다. 관례일 뿐 강제가 아니면 같은 클래스가
  // 조용히 다시 열린다 — 라운드마다 반복된 형태다.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lint-draft.js'), 'utf8');

  // 주석은 설명이다. 개행은 보존해 줄 번호를 맞춘다.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  // RULES 배열 이후(=규칙 본문 전체)에서만 검사한다. ctx.attr 자신의 정의는
  // buildContext 안에 있고 거기서는 getAttr을 써야 한다.
  const rulesAt = code.indexOf('const RULES = [');
  assert.ok(rulesAt > 0, 'RULES 배열을 찾지 못했습니다 — 이 테스트를 갱신하세요.');
  const rulesBody = code.slice(rulesAt);

  const offenders = [];
  for (const m of rulesBody.matchAll(/\bgetAttr\s*\(/g)) {
    const line = code.slice(0, rulesAt + m.index).split('\n').length;
    offenders.push(`lib/lint-draft.js:${line}`);
  }
  assert.deepEqual(offenders, [],
    `규칙 안에서 getAttr을 직접 부르고 있습니다. ctx.attr을 쓰세요 (엔티티 디코드가 빠집니다):\n${offenders.join('\n')}`);

  // buildContext 안에서는 정확히 한 번 쓰인다 (ctx.attr의 구현)
  const beforeRules = code.slice(0, rulesAt);
  assert.equal((beforeRules.match(/\bgetAttr\s*\(/g) || []).length, 1,
    'ctx.attr 구현 외의 getAttr 호출이 buildContext에 있습니다.');
});

test('업로드 결과와 파일 경로로만 매칭되면 표면화한다 (호스트 교차)', () => {
  // tail 매칭은 {postDir}/photo-NN.webp 두 조각만 본다. 그 관용성은 의도된
  // 것이지만(URL 인코딩·에셋 base URL 변경 흡수) 조용하면 초안이 **옛 에셋
  // 호스트**를 가리켜도 치수 검증이 통과한다.
  const FIG = (src) => '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + `<img src="${src}" width="1024" height="768" loading="lazy" alt="가게 외관" `
    + 'style="max-width:100%;height:auto;">'
    + '<figcaption>해질녘에 본 가게 앞 풍경입니다</figcaption></figure>';
  // **픽스처는 실제 산출물 형태여야 한다.** 처음에는 `{index, webpUrl, width,
  // height}`만 넣었는데, upload-images.js는 `webpPath`(로컬 절대 경로)를 모든
  // 항목에 무조건 내보낸다. 그 필드가 있으면 예전 hostOf 비교가 무조건
  // "같은 호스트"로 판정해 이 규칙이 **실제로는 한 번도 발동하지 않았다** —
  // 픽스처가 구멍을 정답으로 고정한 셈이다.
  const LOCAL = '/home/x/photo-blog-agent/tmp/assets/2026-05-10-abc/photo-01.webp';
  const MINE = 'https://mine.github.io/posts/2026-05-10-abc/photo-01.webp';
  const realShape = {
    images: [{
      index: 1,
      originalPath: '/home/x/photos/IMG_1234.jpg',
      webpPath: LOCAL,
      webpUrl: MINE,
      url: MINE,
      width: 1024,
      height: 768,
      originalBytes: 3_200_000,
      webpBytes: 140_000,
      oversize: false,
      fallbackUsed: false,
      watermarkApplied: true,
      orientationApplied: true,
      dimensionsError: null,
      compressionError: null,
      contractError: null,
      verificationError: null,
      error: null,
    }],
  };
  const warnsFor = (src, uploadResult = realShape) => lintDraftHtml(FIG(src), { uploadResult })
    .warnings.map((w) => w.rule);

  assert.ok(!warnsFor(MINE).includes('upload-match-by-filename'), '같은 호스트인데 경고');
  assert.ok(warnsFor('https://old.example/posts/2026-05-10-abc/photo-01.webp')
    .includes('upload-match-by-filename'), '호스트가 다른데 조용함 (webpPath가 판정을 삼킴)');

  // webpUrl만 있는 축약 형태에서도 같아야 한다
  assert.ok(warnsFor('https://old.example/posts/2026-05-10-abc/photo-01.webp',
    { images: [{ index: 1, webpUrl: MINE, width: 1024, height: 768 }] })
    .includes('upload-match-by-filename'));

  // 상대 경로는 호스트를 비교할 수 없으므로 관용 매칭을 유지한다 (경고 없음)
  assert.ok(!warnsFor('/posts/2026-05-10-abc/photo-01.webp')
    .includes('upload-match-by-filename'));
  // --local-only 산출물은 URL이 없으므로 비교 대상이 없다
  assert.ok(!warnsFor('https://old.example/posts/2026-05-10-abc/photo-01.webp',
    { images: [{ index: 1, webpPath: LOCAL, webpUrl: null, url: null, width: 1024, height: 768 }] })
    .includes('upload-match-by-filename'));
  // --upload-result가 없으면 이 규칙은 아예 돌지 않는다
  assert.deepEqual(
    lintDraftHtml(FIG('https://x/a.webp'), {}).warnings
      .filter((w) => w.rule === 'upload-match-by-filename'),
    [],
  );
});

test('작성 시점 표현을 열거가 아니라 근접 매칭으로 잡는다', () => {
  // CLAUDE.md의 절대 규칙을 강제하는 유일한 게이트인데, 리터럴 조합 3개여서
  // 조사 하나만 끼거나 어미가 달라도 전부 통과했다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const bad of [
    '오늘 다녀왔습니다', '오늘은 다녀왔습니다', '오늘 아침 다녀왔습니다',
    '오늘 오랜만에 방문했습니다', '오늘 가봤습니다', '오늘 들러봤습니다',
    '어제 다녀왔습니다', '조금 전에 다녀왔습니다', '이번 주말에 다녀왔습니다',
    '방금 다녀왔어요', '아까 갔다 왔습니다', '지금 방문 중입니다',
  ]) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }

  // 정당한 표현은 막지 않는다 — 이 규칙이 원래 피하려던 오탐이다
  for (const ok of [
    '방금 튀겨낸 치킨텐더가 나왔다', '막 구운 빵 냄새가 좋았다',
    '지난 5월 10일에 다녀왔다', '오늘 같은 날씨였으면 좋았겠다',
    '어제오늘 이야기가 아니다', '오늘의 메뉴는 파스타였다',
    '지난달에 방문했던 곳이다', '5월 초에 갔던 카페다',
  ]) {
    assert.equal(hit(ok), false, `오탐: ${ok}`);
  }
});

test('작성 시점 표현 — 시제 지시어가 다른 서술어에 걸린 문장을 막지 않는다', () => {
  // 근접 매칭만으로는 너무 넓어 정당한 문장을 error로 막았다 (우회 플래그가
  // 없으므로 곧 발행 불가). 절 연결어미와 부정어를 신호로 걸러낸다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const ok of [
    '지금 생각해보면 방문한 게 잘한 일이었다',   // -면 (절 연결)
    '이번 주 내내 비가 와서 못 갔다',            // -서 + 부정어
    '오늘 못 갔다',                            // 부정어만 (절 연결 없음)
    '오늘 안 갔다',
    '방금 못 들렀다',
    '어제까지 예약이 안 돼서 오늘 가려고 했다',
    '지금은 자리가 없어서 다음에 방문하기로 했다',
    '아까 본 그 가게를 다시 찾았다',             // '찾았'은 방문 어간이 아니다
    '오늘의 추천 메뉴를 물어봤다',
    '어제 내린 비 때문에 길이 젖어 있었다',
  ]) {
    assert.equal(hit(ok), false, `오탐(발행 불가): ${ok}`);
  }

  // 직접 수식하는 경우는 여전히 잡는다
  for (const bad of [
    '오늘 다녀왔습니다', '오늘은 다녀왔습니다', '어제 다녀왔습니다',
    '방금 다녀왔어요', '이번 주말에 다녀왔습니다', '아까 갔다 왔습니다',
    // 10차에서 정당하다고 잘못 분류했던 것 — "오늘 … 갔다"는 작성 시점 서술이다
    '오늘 날씨가 좋아서 공원에 갔다',
  ]) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }
});

test('작성 시점 표현 — 조사·어미가 사이에 껴도 잡는다 (가드가 규칙을 지우지 않는다)', () => {
  // 10차에 오탐을 막으려고 넣은 절 연결어미 가드가 **규칙을 통째로 무력화**했다.
  // `-서/-고/-러/-려고`는 앞 절을 뒤 절에 **종속**시키므로 주절 서술어가 곧
  // 방문 동사인데, 가드가 정확히 그것을 면제했다. 게다가 음절만 보느라
  // 조사 `-에서`/`-하고`와 명사 "라면"까지 걸렸다.
  //
  // 테스트가 왜 못 잡았나: 금지 케이스 12건 중 시제 지시어와 동사 사이에
  // **조사나 어미가 들어간 것이 하나도 없었다.** 가드의 사정거리를 통과하는
  // 입력만 코퍼스에 있었다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const bad of [
    '오늘 부산에서 다녀왔습니다',        // 처소격 -에서
    '오늘 아내하고 다녀왔습니다',        // 공동격 -하고
    '오늘 점심 먹으러 다녀왔습니다',      // 목적 -으러
    '오늘 커피 마시려고 들렀습니다',      // 목적 -려고
    '아까 밥 먹고 다녀왔습니다',         // 순차 -고
    '지금 막 도착해서 들렀습니다',        // -해서
    '오늘 라면 다녀왔다',              // 명사 '라면'
    '어제 남편하고 다녀왔어요',
    '오늘 날씨가 좋아서 공원에 갔다',
    '오늘 안 갔다가 결국 다시 다녀왔습니다', // 부정어 skip이 뒤의 위반을 삼켰다
  ]) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }
});

test('작성 시점 표현 — 미래 의도는 작성 시점 혼동이 아니다', () => {
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');
  for (const ok of [
    '지금은 자리가 없어서 다음에 방문하기로 했다',
    '오늘은 문을 닫아서 나중에 방문할 예정이다',
  ]) {
    assert.equal(hit(ok), false, `오탐(발행 불가): ${ok}`);
  }
});

test('figure가 컨테이너 안에 있어도 뒤 문장을 센다 (error 오탐 방지)', () => {
  // `fig.parent.children`만 훑으면 래퍼 하나에 판정이 무너진다. Blogger 웹
  // 에디터는 이미지를 <div class="separator">로 감싸는 것이 기본 동작이라,
  // 사용자가 에디터를 한 번 거치면 바로 도달한다. 그때 text-after-figure가
  // "0문장뿐입니다"라고 하는데 초안을 열면 문장이 보인다 — 능동적 오도다.
  const FIGURE = '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + '<img src="https://x/photo-01.webp" width="1024" height="768" loading="lazy" '
    + 'alt="가게 외관" style="max-width:100%;height:auto;">'
    + '<figcaption>해질녘 가게 앞 풍경입니다</figcaption></figure>';
  const P3 = '<p>첫 문장이다. 둘째 문장이다. 셋째 문장이다.</p>';
  const stats = (html) => lintDraftHtml(html, {}).stats.sentencesAfterFigure;
  const figErrors = (html) => lintDraftHtml(html, {}).errors
    .map((e) => e.rule).filter((r) => /figure/.test(r));

  // 래퍼 유무와 무관하게 같은 판정
  assert.deepEqual(stats(FIGURE + P3), [3]);
  assert.deepEqual(stats(`<div class="separator">${FIGURE}</div>${P3}`), [3]);
  assert.deepEqual(stats(`<div><section>${FIGURE}</section></div>${P3}`), [3]);
  assert.deepEqual(stats(`<div>${FIGURE}${P3}</div>`), [3]);
  for (const html of [FIGURE + P3, `<div class="separator">${FIGURE}</div>${P3}`]) {
    assert.deepEqual(figErrors(html), [], 'text-after-figure 오탐');
  }

  // h3 직후 판정도 래퍼를 넘어서 본다
  assert.deepEqual(figErrors(`${FIGURE}<h3>제목</h3>${P3}`), ['no-h3-after-figure']);
  assert.deepEqual(figErrors(`<div class="separator">${FIGURE}</div><h3>제목</h3>${P3}`),
    ['no-h3-after-figure']);
  // 진짜로 뒤에 아무것도 없으면 여전히 잡는다
  assert.deepEqual(figErrors(FIGURE), ['text-after-figure']);
});

test('래퍼로 감싼 figure/h3도 경계로 인식한다 (오탐을 미탐으로 바꾸지 않는다)', () => {
  // followingSiblings가 래퍼를 **넘어가기만** 하고 래퍼 노드를 그대로 내보내면,
  // `n.tag === 'figure'` 경계 판정이 `div`를 보고 break하지 않는다. 그러면 스캔이
  // 다음 이미지를 넘어 문서 끝까지 가서 text-after-figure(error)가 진짜 위반을
  // 놓친다 — Blogger 웹 에디터는 **모든** 이미지를 래핑하므로, 그 경우 이 규칙이
  // 마지막 figure를 빼고 사실상 무력해진다. 오탐을 미탐으로 바꾸는 것은 더 나쁘다.
  const FIGURE = (n) => '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + `<img src="https://x/photo-0${n}.webp" width="1024" height="768" loading="lazy" `
    + `alt="사진 ${n} 설명" style="max-width:100%;height:auto;">`
    + `<figcaption>해질녘 가게 앞 풍경 ${n}입니다</figcaption></figure>`;

  const body = (wrap) => {
    const w = (x) => (wrap ? `<div class="separator">${x}</div>` : x);
    return `${w(FIGURE(1))}<p>한 문장뿐.</p>${w(FIGURE(2))}<p>문장A. 문장B. 문장C.</p>`;
  };
  const plain = lintDraftHtml(body(false), {});
  const wrapped = lintDraftHtml(body(true), {});

  // 래핑 유무와 무관하게 **같은** 판정이어야 한다
  assert.deepEqual(wrapped.stats.sentencesAfterFigure, plain.stats.sentencesAfterFigure);
  assert.deepEqual(wrapped.stats.sentencesAfterFigure, [1, 3]);
  assert.ok(wrapped.errors.some((e) => e.rule === 'text-after-figure'),
    '래핑하면 진짜 위반을 놓침');

  // h3 경계도 래퍼를 넘어서 본다
  const h3 = (wrap) => {
    const w = (x) => (wrap ? `<div class="separator">${x}</div>` : x);
    return `${FIGURE(1)}${w('<h3>바로 다음 제목</h3>')}<p>본문. 둘째.</p>`;
  };
  for (const wrap of [false, true]) {
    assert.ok(lintDraftHtml(h3(wrap), {}).errors.some((e) => e.rule === 'no-h3-after-figure'),
      `${wrap ? '래핑된' : '평면'} h3를 놓침`);
  }
});

test('방문 동사는 단어 시작이어야 한다 (합성 이동동사 오탐 방지)', () => {
  // `갔`은 합성 이동동사의 뒷음절로도 나타난다 — 내려갔/지나갔/넘어갔/돌아갔.
  // 사정거리를 넓히면서 그것들이 창에 들어와 정당한 문장을 error로 막았다.
  // stem 목록에 예외를 열거하는 대신 **경계**를 요구한다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const ok of [
    '오늘 기준 가격이 조금 내려갔어요.',
    '어제 밤에 기온이 영하로 내려갔다고 뉴스에 나왔습니다.',
    '지금은 리모델링으로 간판이 내려갔다고 합니다.',
    '오늘 하루가 어떻게 지나갔는지 모르겠다.',
    '어제 그 앞을 몇 번이나 지나갔다.',
    '오늘 계단을 걸어 내려갔다.',
  ]) {
    assert.equal(hit(ok), false, `오탐(발행 불가): ${ok}`);
  }

  // 단어 시작인 진짜 위반은 여전히 잡는다
  for (const bad of ['오늘 날씨가 좋아서 공원에 갔다', '어제 그 카페에 갔다', '오늘 다녀왔습니다']) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }
});

test('작성 시점 표현 — 경계 요구는 갔에만 (재방문/첫방문을 놓치지 않는다)', () => {
  // 12차에서 `갔`의 합성 이동동사 오탐(내려갔/지나갔)을 막으려고 단어 경계를
  // 요구했는데, **모든 stem에 일괄 적용**해서 정반대 사고가 났다. `방문`은
  // 접두사가 붙어도 뜻이 같은 명사 어근이라 **재방문/첫방문**이 통째로 샜다 —
  // 카페·식당 재방문기가 이 프로젝트의 주 장르이고 "오늘 재방문했습니다"는
  // 이 규칙이 막아야 할 표현 그 자체다.
  //
  // 오탐은 발행이 막혀 즉시 드러나지만 미탐은 아무도 모르는 채 LIVE로 나간다.
  // 테스트가 못 잡은 이유: 방문 동사 케이스가 전부 "공백 + stem" 형태였다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const bad of [
    '오늘 재방문했습니다.',
    '어제 재방문해서 새 메뉴를 먹었습니다.',
    '지금 막 재방문했어요.',
    '오늘 아이와 함께 재방문했어요.',
    '오늘 첫방문이라 설렜습니다.',
    '오늘 다시 방문했습니다.',
    // 구두점 뒤도 경계로 인정한다 — "공백이 우연히 있었는가"에 의존하지 않는다.
    // `갔`은 경계를 요구하는 유일한 stem이므로 구두점 케이스를 여기로 검사한다.
    '오늘 "다녀왔습니다".',
    '오늘,다녀왔습니다.',
    '오늘(혼자) 다녀왔습니다.',
    '오늘갔다.',
    '오늘,갔다.',
    '오늘 "갔다".',
    '어제(아내와)갔다.',
  ]) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }

  // `갔`의 경계 요구는 유지된다 — 합성 이동동사 오탐이 돌아오면 안 된다
  for (const ok of [
    '오늘 기준 가격이 조금 내려갔어요.',
    '어제 밤에 기온이 영하로 내려갔다고 뉴스에 나왔습니다.',
    '지금은 리모델링으로 간판이 내려갔다고 합니다.',
    '오늘 하루가 어떻게 지나갔는지 모르겠다.',
  ]) {
    assert.equal(hit(ok), false, `오탐(발행 불가): ${ok}`);
  }
});

test('캡션만으로는 이미지 다음 문장 요건을 채울 수 없다 (평탄화 우회 차단)', () => {
  // 평탄화로 figcaption이 **루트**로 올라오면 textOf의 skip이 걸러주지 않는다
  // (`n !== node` 조건 때문에 루트 자신은 skip 대상이 아니다). 그러면
  // style-guide가 금지한 "캡션을 길게 써서 분량 채우기"가 열린다.
  const FIGURE = '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + '<img src="https://x/p.webp" width="1024" height="768" loading="lazy" '
    + 'alt="가게 외관" style="max-width:100%;height:auto;">'
    + '<figcaption>정상 캡션입니다</figcaption></figure>';
  const stats = (html) => lintDraftHtml(html, {}).stats.sentencesAfterFigure;
  const blocked = (html) => lintDraftHtml(html, {}).errors
    .some((e) => e.rule === 'text-after-figure');

  const capOnly = `${FIGURE}<div><figcaption>캡션 문장입니다. 둘째 문장입니다. 셋째 문장입니다.</figcaption></div>`;
  assert.deepEqual(stats(capOnly), [0], '캡션이 본문 문장으로 셈됨');
  assert.equal(blocked(capOnly), true);

  // 진짜 본문은 래퍼 유무와 무관하게 세어진다
  const P3 = '<p>첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.</p>';
  assert.deepEqual(stats(FIGURE + P3), [3]);
  assert.deepEqual(stats(`${FIGURE}<div>${P3}</div>`), [3]);
  // 캡션이 섞여 있어도 본문만 센다
  assert.deepEqual(stats(`${FIGURE}<div><figcaption>캡션.</figcaption><p>첫 문장입니다. 둘째 문장입니다.</p></div>`), [2]);
});

test('작성 시점 표현 — error는 정밀함, warn은 완전함 (왕복을 끝내는 분담)', () => {
  // 이 규칙은 11·12·13차에 걸쳐 오탐↔미탐을 왕복했다. 원인은 개별 케이스가
  // 아니라 **한 규칙에 두 일을 시킨 것**이다 — "시제 지시어가 이 방문 동사를
  // 수식하는가"는 형태소 분석 질문인데 부분 문자열 매칭으로 답하려 했고,
  // 한국어 표면형은 열거로 닫히지 않으므로 넓히면 오탐, 좁히면 미탐이었다.
  //
  // 이제 정밀함(error)과 완전함(warn)을 나눈다. error가 놓치는 형태는 warn이
  // **열거 없이** 전부 표면화하므로, error를 넓힐 압력이 사라진다.
  const of = (text) => {
    const r = lintDraftHtml(`<p>${text}</p>`, {});
    return {
      error: r.errors.some((e) => e.rule === 'no-writing-date-expression'),
      warn: r.warnings.some((w) => w.rule === 'writing-date-word'),
    };
  };

  // 직접 수식 = error (+ 당연히 warn)
  for (const t of ['오늘 다녀왔습니다', '오늘 재방문했습니다', '오늘 점심 먹으러 다녀왔습니다']) {
    assert.deepEqual(of(t), { error: true, warn: true }, t);
  }

  // error가 보수적으로 넘기는 것들 — warn이 반드시 잡아야 한다.
  // 여기가 왕복의 핵심이다: 미탐이 "조용한 통과"가 아니라 "보이는 warn"이 된다.
  for (const t of [
    '오늘 기준 가격이 조금 내려갔어요',
    '오늘 하루가 어떻게 지나갔는지 모르겠다',
    '지금 생각해보면 방문한 게 잘한 일이었다',
    '이번 주 내내 비가 와서 못 갔다',
    '지금은 자리가 없어서 다음에 방문하기로 했다',
  ]) {
    assert.deepEqual(of(t), { error: false, warn: true }, `warn이 놓침: ${t}`);
  }

  // **고정 어구는 error만 면제한다.** 면제를 warn에 붙였던 것이 14차의 설계
  // 실패였다 — 담당이 뒤바뀌어 "오늘의 추천 메뉴를 먹으러 방문했습니다"가
  // error로 차단되고 warn은 침묵했다. 면제는 정밀함(error) 쪽에 붙고,
  // 완전함(warn)은 지시어가 있다는 사실 자체를 보고한다.
  //
  // **반드시 방문 동사를 포함시킨다.** 14차 테스트는 `가본`·`가면`처럼
  // stem이 아닌 활용형만 써서 면제와 error의 상호작용을 한 번도 실행하지
  // 않았다 — 그래서 261건이 통과하는데도 결함이 살아 있었다.
  for (const t of [
    '오늘의 추천 메뉴를 먹으러 방문했습니다',
    '오늘처럼 늦은 점심에 갔더니 한산했습니다',
    '지금까지 다녀온 카페 중에 제일 조용했습니다',
    '지금껏 다녀본 곳과는 분위기가 달랐습니다',
    '오늘의 나들이 코스로 들렀습니다',
  ]) {
    assert.deepEqual(of(t), { error: false, warn: true }, `고정 어구가 error로 차단됨: ${t}`);
  }

  // 과거 표지가 있으면 방문 시점을 명시한 정본 표현이다 (CLAUDE.md가 요구하는 형태)
  for (const t of [
    '오늘은 지난달에 다녀온 카페를 정리해봅니다',
    '오늘은 작년에 방문했던 곳을 다시 꺼내봅니다',
    '오늘, 예전에 다녀왔던 곳을 정리합니다',
    '오늘은 그때 들렀던 가게 이야기입니다',
    '지금 정리하는 글은 5월에 다녀온 기록입니다',
  ]) {
    assert.deepEqual(of(t), { error: false, warn: true }, `정본 표현이 차단됨: ${t}`);
  }

  // `방문`이 명사구일 때는 방문 주장이 아니다
  for (const t of [
    '오늘 방문 예약은 마감이라고 적혀 있었습니다',
    '오늘 기준 방문객이 많다는 후기가 보입니다',
    '지금 인기 방문 코스로 소개되어 있습니다',
    '오늘 방문 후기를 정리했습니다',
  ]) {
    assert.deepEqual(of(t), { error: false, warn: true }, `명사구가 차단됨: ${t}`);
  }

  // 서술어가 붙으면 방문 주장이다
  for (const t of ['오늘 방문했습니다', '오늘 방문해서 사진을 찍었습니다',
    '지금 방문 중입니다', '오늘 첫방문이라 설렜습니다']) {
    assert.deepEqual(of(t), { error: true, warn: true }, `방문 주장을 놓침: ${t}`);
  }

  // EXIF 기반 표현은 아무것도 걸리지 않는다
  for (const t of ['지난 5월 10일에 다녀왔다', '5월 초에 갔던 카페다', '지난달에 방문했던 곳이다']) {
    assert.deepEqual(of(t), { error: false, warn: false }, t);
  }
});

test('실초안 6건의 writing-date-word warn 노이즈를 계량으로 고정한다', () => {
  // warn이 매 초안마다 뜨면 무시당하고, 그러면 완전성 담당이 무력해진다.
  // 실측: 6건 중 1건에서 1회("오늘처럼 늦은 점심") — 고정 어구이므로 error는
  // 침묵하고 warn만 뜬다. 이 수치가 늘면 warn 설계를 다시 봐야 한다.
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const dir = pathMod.join(__dirname, 'fixtures', 'drafts');
  const counts = {};
  for (const f of fsMod.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const r = lintDraftHtml(fsMod.readFileSync(pathMod.join(dir, f), 'utf8'), {});
    counts[f] = r.warnings.filter((w) => w.rule === 'writing-date-word').length;
    // error는 실초안에서 절대 뜨지 않아야 한다 (발행이 막힌다)
    assert.deepEqual(
      r.errors.filter((e) => e.rule === 'no-writing-date-expression'),
      [],
      `${f}: 실초안이 error로 차단됨`,
    );
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 1, `warn 노이즈가 늘었다: ${JSON.stringify(counts)}`);
});

test('본문 텍스트 skip 목록이 글자수와 문장수에서 같다', () => {
  // 목록이 갈려 있으면 한쪽에서 제외되는 텍스트가 다른 쪽에서 본문으로 셈된다.
  // 실측 사고: <script>의 한국어 주석이 "이미지 다음 4문장"으로 세어져 **본문
  // 없이** text-after-figure(error)를 통과했다. CLAUDE.md가 삽입을 권하는
  // blogger-image-protection.html이 정확히 그 모양이다.
  const FIGURE = '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + '<img src="https://x/p.webp" width="1024" height="768" loading="lazy" '
    + 'alt="가게 외관" style="max-width:100%;height:auto;">'
    + '<figcaption>정상 캡션입니다</figcaption></figure>';
  const JS = '// 우클릭을 막습니다. 드래그도 막습니다. 이미지를 보호합니다.\n'
    + 'document.oncontextmenu = function () { return false; };';
  const CSS = 'img { pointer-events: none; } /* 이미지를 보호합니다. 드래그를 막습니다. */';

  const stats = (html) => lintDraftHtml(html, {}).stats;
  const blocked = (html) => lintDraftHtml(html, {}).errors
    .some((e) => e.rule === 'text-after-figure');

  for (const [label, tag, body] of [['script', 'script', JS], ['style', 'style', CSS]]) {
    for (const wrap of [false, true]) {
      const inner = `<${tag}>${body}</${tag}>`;
      const html = FIGURE + (wrap ? `<div>${inner}</div>` : inner);
      assert.deepEqual(stats(html).sentencesAfterFigure, [0],
        `${label}${wrap ? '(래퍼)' : ''}의 텍스트가 본문 문장으로 셈됨`);
      assert.equal(blocked(html), true, `${label}${wrap ? '(래퍼)' : ''}만으로 error를 통과`);
      assert.equal(stats(html).bodyChars, 0);
    }
  }

  // 진짜 본문이 있으면 통과하고, script는 글자수에 들어가지 않는다
  const withBody = `${FIGURE}<script>${JS}</script><p>첫 문장입니다. 둘째 문장입니다.</p>`;
  assert.deepEqual(stats(withBody).sentencesAfterFigure, [2]);
  assert.equal(blocked(withBody), false);
  assert.equal(stats(withBody).bodyChars,
    require('../lib/korean-text').countChars('첫 문장입니다. 둘째 문장입니다.'));
});

test('본문 텍스트가 아닌 태그를 모든 규칙이 같게 제외한다', () => {
  // skip 목록이 규칙마다 갈려 있으면 한쪽에서 제외되는 텍스트가 다른 쪽에서
  // 본문으로 셈된다. 14차에 bodyChars/textAfterFigure만 통일했고 세 곳이 남았다.
  const CSS = `img{pointer-events:none}${'.a{b:c}'.repeat(50)}`;
  const has = (html, rule) => {
    const r = lintDraftHtml(html, {});
    return r.errors.concat(r.warnings).some((e) => e.rule === rule);
  };

  // no-emoji(error) — CSS/JS 안의 이모지로 발행이 막히면 작성자는 본문에서
  // 그 이모지를 찾을 수 없다
  assert.equal(has('<p>본문입니다. 둘째 문장입니다.</p><style>/* 좋아요 ❤️ */</style>', 'no-emoji'),
    false, 'style 안 이모지가 발행을 막음');
  assert.equal(has('<p>본문입니다. 둘째 문장입니다.</p><script>// ❤️</script>', 'no-emoji'),
    false, 'script 안 이모지가 발행을 막음');
  // 본문·캡션의 이모지는 여전히 금지다
  assert.equal(has('<p>본문입니다 ❤️. 둘째 문장입니다.</p>', 'no-emoji'), true);

  // p-max-chars / p-sentence-count
  assert.equal(has(`<p>짧은 본문입니다. 둘째 문장입니다.<style>${CSS}</style></p>`, 'p-max-chars'),
    false, 'p 안의 CSS가 글자수로 셈됨');
});

test('h3-placement가 래퍼에 무력화되지 않는다', () => {
  // elementChildren(root)만 보면 <div>로 감싼 h3의 indexOf가 -1이 되어
  // **규칙이 0개를 검사한다** (발견이 줄어드는 게 아니라 무력화).
  const H3 = '<h3>제목입니다</h3>';
  const P = '<p>본문 문장입니다. 둘째 문장입니다.</p>';
  const warned = (html) => lintDraftHtml(html, {}).warnings
    .some((w) => w.rule === 'h3-placement');

  for (const [label, html] of [
    ['평면 h3-first', H3 + P],
    ['래퍼 h3-first', `<div>${H3}</div>${P}`],
    ['평면 h3-last', P + H3],
    ['래퍼 h3-last', `${P}<div>${H3}</div>`],
  ]) {
    assert.equal(warned(html), true, `${label}: 규칙이 검사하지 않음`);
  }
  // 정상 배치는 경고하지 않는다
  assert.equal(warned(`${P}${H3}${P}`), false);
  assert.equal(warned(`${P}<div>${H3}</div>${P}`), false);
});

test('figcaption-generic이 숫자 없는 제네릭 캡션도 잡는다', () => {
  // 예전 패턴은 `\d+`가 필수라서 가장 제네릭한 형태를 놓쳤다.
  const FIGCAP = (cap) => '<figure style="margin:1.5em 0;text-align:center;position:relative;">'
    + '<img src="https://x/p.webp" width="1024" height="768" loading="lazy" alt="가게 외관" '
    + `style="max-width:100%;height:auto;"><figcaption>${cap}</figcaption></figure>`;
  const blocked = (cap) => lintDraftHtml(FIGCAP(cap), {}).errors
    .some((e) => e.rule === 'figcaption-generic');

  for (const cap of ['사진', '이미지', '그림', 'photo', 'Image',
    '사진 - 1', '사진1', '이미지 03', '사진 2.']) {
    assert.equal(blocked(cap), true, `제네릭 캡션을 놓침: ${cap}`);
  }
  for (const cap of ['해질녘 가게 앞 풍경입니다', '사진 속 간판이 인상적이었다',
    '이미지 왼쪽이 입구다']) {
    assert.equal(blocked(cap), false, `장면 설명을 차단: ${cap}`);
  }
});

test('부정 표현이 뒤따르는 금칙 어구는 warn하지 않는다', () => {
  // 부분 문자열 매칭의 한계. warn 등급이라 차단은 아니지만, 시끄러운 warn은
  // 무시당해 규칙이 무력해진다.
  const warned = (text, rule) => lintDraftHtml(`<p>${text}</p>`, {}).warnings
    .some((w) => w.rule === rule);

  for (const [text, rule] of [
    ['부인할 수 없는 맛이었다', 'spouse-wording'],
    ['완벽한 날씨는 아니었습니다', 'overclaim-phrase'],
    ['최고의 선택은 아니었어요', 'overclaim-phrase'],
    ['수익형 블로그와는 무관합니다', 'no-ad-encouragement'],
  ]) {
    assert.equal(warned(text, rule), false, `오탐: [${rule}] ${text}`);
  }

  // 진짜 위반은 여전히 warn
  for (const [text, rule] of [
    ['강력 추천합니다', 'overclaim-phrase'],
    ['완벽한 하루였다', 'overclaim-phrase'],
    ['부인과 함께 갔다', 'spouse-wording'],
    ['개인적으로는 좋았다', 'ai-tell-phrase'],
  ]) {
    assert.equal(warned(text, rule), true, `놓침: [${rule}] ${text}`);
  }
});

test('writing-date-word가 겹치는 지시어를 중복 보고하지 않는다', () => {
  // `이번 주`와 `이번 주말`이 둘 다 목록에 있어 한 문장에 동일한 warn 2건이 났다.
  // warn이 시끄러워지면 무시당해 완전성 담당이 무력해진다.
  const count = (text) => lintDraftHtml(`<p>${text}</p>`, {}).warnings
    .filter((w) => w.rule === 'writing-date-word').length;
  assert.equal(count('이번 주말에 다녀왔습니다. 좋았습니다.'), 1);
  assert.equal(count('이번 주에 다녀왔습니다.'), 1);
  // 서로 다른 자리의 서로 다른 지시어는 각각 보고한다
  assert.equal(count('어제 갔고 오늘 또 다녀왔습니다.'), 2);
});

test('link-target-rel은 외부 링크에만 적용된다', () => {
  // target="_blank"는 외부로 나가는 링크에만 의미가 있다.
  const warned = (href) => lintDraftHtml(`<p><a href="${href}">링크</a></p>`, {}).warnings
    .some((w) => w.rule === 'link-target-rel');
  for (const href of ['#section', '/relative/path', 'mailto:a@b.c', 'tel:+8210']) {
    assert.equal(warned(href), false, `내부/특수 링크에 경고: ${href}`);
  }
  for (const href of ['https://example.com', 'http://example.com/a']) {
    assert.equal(warned(href), true, `외부 링크를 놓침: ${href}`);
  }
});

test('방문의 서술어 판정 — 1음절 이/중이 명사 접두를 삼키지 않는다', () => {
  // `\s*(?:…|중|이|…)`처럼 1음절로 두면 `\s*`가 공백까지 먹어 `방문 이용/이력/
  // 이후/이유/이벤트`, `방문 중간/중요/중단`이 전부 "서술어가 붙었다"로 판정돼
  // error 차단됐다. 이 규칙이 고치겠다고 선언한 FP 클래스 그 자체이고,
  // CLAUDE.md가 요구하는 "이용 안내를 본문에 녹여라"와 충돌한다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const ok of [
    '오늘 기준 방문 이용 안내는 홈페이지에 있습니다.',
    '오늘 기준 방문 중단 안내가 붙어 있었습니다.',
    '지금 방문 이벤트가 진행됩니다.',
    '지금 방문 이유를 정리해봅니다.',
    '오늘 방문 이력이 있습니다.',
    '지금 방문 중요도가 높습니다.',
    '오늘 방문 이후로 자주 갑니다.',
    '오늘 방문 중간에 비가 왔습니다.',
    '오늘 기준 방문 인원 제한이 있습니다.',
    '오늘 방문 예약은 마감되었습니다.',
  ]) {
    assert.equal(hit(ok), false, `명사구가 차단됨: ${ok}`);
  }

  // 서술어가 붙으면 방문 주장이다 — 계사 활용형도 포함
  for (const bad of [
    '오늘 방문했습니다.', '오늘 방문해서 사진을 찍었습니다.', '지금 방문 중입니다.',
    '오늘 첫방문이라 설렜습니다.', '오늘 재방문입니다.', '오늘 방문이었습니다.',
    '오늘 방문이다.', '지금 방문 중이었습니다.',
  ]) {
    assert.equal(hit(bad), true, `방문 주장을 놓침: ${bad}`);
  }
});

test('과거 표지 — 숫자+월/일은 과거 조사와 함께일 때만', () => {
  // `\d+월`·`\d+일`을 단독으로 두면 진짜 위반을 면제한다. `오늘 + 다녀왔다`는
  // 이 규칙이 존재하는 이유 그 자체다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  // 계수 구성은 과거 표지가 아니다 → error가 잡는다
  for (const bad of [
    '오늘 3일 만에 다시 다녀왔습니다.',
    '오늘 5월 들어 처음 다녀왔습니다.',
    '오늘 2일차 일정으로 갔습니다.',
    '오늘 4일 연속 갔습니다.',
  ]) {
    assert.equal(hit(bad), true, `면제되어 놓침: ${bad}`);
  }

  // **동격 구문은 error가 잡지 않는다** — "오늘 5월 마지막 날 다녀왔습니다"의
  // `5월 마지막 날`은 오늘과 같은 날을 가리키므로 위반이지만, "오늘은 5월 초
  // 다녀온 기록입니다"의 `5월 초`는 방문 시점이라 정당하다. 둘을 구별하려면
  // 동격 여부를 알아야 하고, 그건 부분 문자열 매칭의 범위 밖이다.
  // 등급 분리 원칙대로 **error는 좁게 두고 warn이 덮는다** — 차단은 되돌릴 수
  // 없지만 warn은 사람이 확인한다.
  const apposition = '오늘 5월 마지막 날 다녀왔습니다.';
  assert.equal(hit(apposition), false);
  assert.equal(
    lintDraftHtml(`<p>${apposition}</p>`, {}).warnings
      .some((w) => w.rule === 'writing-date-word'),
    true,
    '동격 구문이 warn에도 안 걸리면 조용히 통과한다',
  );

  // 진짜 과거 표지는 여전히 면제한다 (CLAUDE.md가 요구하는 정본 표현)
  for (const ok of [
    '오늘은 지난달에 다녀온 카페를 정리해봅니다',
    '오늘은 작년에 방문했던 곳을 다시 꺼내봅니다',
    '오늘, 예전에 다녀왔던 곳을 정리합니다',
    '지금 정리하는 글은 5월에 다녀온 기록입니다',
    '오늘은 5월 10일에 다녀온 기록입니다',
    '오늘은 며칠 전에 다녀온 곳 이야기입니다',
  ]) {
    assert.equal(hit(ok), false, `정본 표현이 차단됨: ${ok}`);
  }
});

test('부정 필터 — 없/않은 강조의 구성 요소라 면제하지 않는다', () => {
  // 한국어에서 `없`·`않`은 부정보다 **강조의 관용 구성 요소**로 더 흔하다.
  // 14자 창에 들어오면 과장 표현을 **강화하는** 문맥이 전부 면제됐다.
  // 이 세 규칙은 error/warn 2단 구조가 없어서, 면제되면 신호가 0이 된다.
  const warned = (text, rule) => lintDraftHtml(`<p>${text}</p>`, {}).warnings
    .some((w) => w.rule === rule);

  for (const [text, rule] of [
    ['강력 추천, 후회 없을 겁니다.', 'overclaim-phrase'],
    ['최고의 맛, 두말할 것 없습니다.', 'overclaim-phrase'],
    ['완벽한 코스, 부족함이 없었다.', 'overclaim-phrase'],
    ['무조건 가야 하는 곳, 이견 없습니다.', 'overclaim-phrase'],
    ['개인적으로는 아쉬움이 없었습니다.', 'ai-tell-phrase'],
    ['가성비가 좋다는 말밖에 없다.', 'ai-tell-phrase'],
    ['광고 클릭 유도는 하지 않습니다.', 'no-ad-encouragement'],
  ]) {
    assert.equal(warned(text, rule), true, `강화 문맥이 면제됨: [${rule}] ${text}`);
  }

  // 계사 부정은 여전히 면제한다 (조사구가 끼는 경우까지)
  for (const [text, rule] of [
    ['완벽한 날씨는 아니었습니다', 'overclaim-phrase'],
    ['최고의 선택은 아니었어요', 'overclaim-phrase'],
    ['수익형 블로그와는 무관합니다', 'no-ad-encouragement'],
    ['부인할 수 없는 맛이었다', 'spouse-wording'],
  ]) {
    assert.equal(warned(text, rule), false, `오탐: [${rule}] ${text}`);
  }
});

test('link-target-rel — 프로토콜 상대 URL도 외부 링크다', () => {
  const warned = (href) => lintDraftHtml(`<p><a href="${href}">링크</a></p>`, {}).warnings
    .some((w) => w.rule === 'link-target-rel');
  for (const href of ['//example.com', 'https://example.com', 'HTTPS://EXAMPLE.COM']) {
    assert.equal(warned(href), true, `외부 링크를 놓침: ${href}`);
  }
  for (const href of ['#a', '/rel', 'mailto:a@b.c']) {
    assert.equal(warned(href), false, `내부 링크에 경고: ${href}`);
  }
});

test('과거 표지 — 프롬프트가 지시한 정본 표현을 차단하지 않는다', () => {
  // 한때 `에`를 월/일 **직후에** 요구했다. 계수 구성은 배제되지만 **이 프로젝트의
  // 정본 표현이 전부 error 차단**됐다 (실측 11종). prompts/blog-draft.md·
  // CLAUDE.md·workflow-steps.md가 작성 모델에게 **쓰라고 지시한 어구**다.
  //
  // 게다가 방향이 뒤집힌 교환이었다 — 그렇게 막은 미탐 4종은 이미
  // writing-date-word(warn)가 전부 덮고 있어 조용히 LIVE로 나가지 않았다.
  // 발행을 막는 error를 얻고 보이는 warn을 잃은 셈이다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const ok of [
    '오늘은 5월 10일 다녀온 카페 기록입니다',
    '오늘은 5월 초 다녀온 카페 기록입니다',
    '오늘은 5월 초에 다녀온 카페 기록입니다',
    '오늘은 5월 말에 다녀온 곳입니다',
    '오늘은 5월 중순에 다녀온 곳입니다',
    '오늘은 2026년 5월 10일 다녀온 기록입니다',
    '오늘은 3일 전에 다녀온 곳입니다',
    '오늘은 10일 전 다녀온 곳입니다',
    '오늘은 이틀 전에 다녀온 곳입니다',
    '오늘은 일주일 전에 다녀온 곳입니다',
    '오늘은 한 달 전에 다녀온 곳입니다',
  ]) {
    assert.equal(hit(ok), false, `정본 표현이 차단됨: ${ok}`);
  }
});

test('방문의 서술어 — 1음절 하/해가 명사 접두를 삼키지 않는다', () => {
  // `이`·`중`만 고치고 `하`·`해`를 1음절로 남겼더니, 같은 클래스가 절반만
  // 처리됐다. 관람 시간·하차 지점·해설 프로그램은 이 장르의 상용 정보다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  for (const ok of [
    '오늘 기준 방문 해설 프로그램은 10시에 시작합니다',
    '오늘 기준 방문 하루권 가격은 만원입니다',
    '오늘 기준 방문 하차 지점은 정문입니다',
    '오늘 기준 방문 해외 관광객이 많습니다',
    '오늘 기준 방문 하한선은 없습니다',
    '지금 방문 하이라이트는 야경입니다',
    '오늘 방문 하나만 남았어요',
    '오늘 방문 하루 코스로 좋아요',
  ]) {
    assert.equal(hit(ok), false, `명사구가 차단됨: ${ok}`);
  }

  // 활용형이 붙으면 방문 주장이다
  for (const bad of [
    '오늘 방문했습니다.', '오늘 방문해서 사진을 찍었습니다.', '오늘 방문하러 갔습니다.',
    '오늘 방문하고 왔습니다.', '오늘 방문해도 좋습니다.', '오늘 방문하는 날입니다.',
    '오늘 방문하지 못했다고 적혀 있었습니다.',
  ]) {
    assert.equal(hit(bad), true, `방문 주장을 놓침: ${bad}`);
  }
});

test('부정 필터 — 조사구가 길게 끼는 정당한 부정까지 닿는다', () => {
  // 계사 부정은 강조의 구성 요소로 쓰이지 않으므로 창을 넓혀도 강화 문맥이
  // 면제되지 않는다 (실측). 넓히는 편이 순이득이다.
  const warned = (text) => lintDraftHtml(`<p>${text}</p>`, {}).warnings
    .some((w) => w.rule === 'overclaim-phrase');

  for (const ok of [
    '완벽한 하루라고 하기에는 아니었다',
    '최고의 맛이라고 하기에는 아니에요',
    '완벽한 코스라고 부를 정도는 아니었습니다',
    '최고의 선택이라고 말하기는 좀 아니죠',
  ]) {
    assert.equal(warned(ok), false, `오탐: ${ok}`);
  }
  // 창을 넓혀도 강화 문맥은 계속 warn
  for (const bad of [
    '강력 추천, 후회 없을 겁니다.',
    '최고의 맛, 두말할 것 없습니다.',
    '완벽한 코스, 부족함이 없었다.',
  ]) {
    assert.equal(warned(bad), true, `강화 문맥이 면제됨: ${bad}`);
  }
});

test('가드 존치 기준 — 오탐을 막지 않는 가드는 미탐만 만든다', () => {
  // 이 규칙은 11~17차에 걸쳐 오탐↔미탐을 왕복했다. 원인은 가드를 "문법적으로
  // 그럴듯한가"로 판단한 것이다. 판정 기준을 **계량**으로 바꿨다:
  // 가드는 실제로 막는 오탐이 있을 때만 존치한다.
  //
  // 계량 결과 `는데`·`지만`·`니까`는 오탐 0건을 막고 미탐 7건을 만들었다 —
  // 그 어미가 있던 정당한 문장은 과거 표지 가드가 이미 통과시킨다.
  const hit = (text) => lintDraftHtml(`<p>${text}</p>`, {}).errors
    .some((e) => e.rule === 'no-writing-date-expression');

  // 제거한 어미들이 만들던 미탐 — 이제 잡힌다
  for (const bad of [
    '오늘 비 오는데 다녀왔습니다',
    '지금 문 닫는데 갔습니다',
    '어제 늦었는데 다녀왔어요',
    '오늘 비싸지만 다녀왔습니다',
    '어제 멀지만 다녀왔어요',
    '오늘 가까우니까 다녀왔습니다',
    '지금 한가하니까 들렀습니다',
  ]) {
    assert.equal(hit(bad), true, `놓침: ${bad}`);
  }

  // 그 어미가 있던 정당한 문장은 과거 표지가 통과시킨다 (가드가 없어도)
  for (const ok of [
    '오늘 소개하는데 지난달에 다녀온 곳입니다',
    '오늘 쓰는데 예전에 방문했던 가게입니다',
    '오늘 짧지만 지난 5월 다녀온 이야기입니다',
    '오늘 쓰니까 작년에 방문했던 기억이 납니다',
  ]) {
    assert.equal(hit(ok), false, `오탐(발행 불가): ${ok}`);
  }

  // `면` 계열은 실제로 오탐을 막으므로 존치한다
  for (const ok of ['지금 생각해보면 방문한 게 잘한 일이었다', '오늘 같으면 방문하기 좋겠다']) {
    assert.equal(hit(ok), false, `면 계열 가드가 사라짐: ${ok}`);
  }
  // 명사 "라면"에는 걸리지 않는다
  assert.equal(hit('오늘 라면 다녀왔다'), true);
});

test('새 표면형 계량 — error 오탐 0, 미탐은 warn이 전부 덮는다', () => {
  // 왕복이 끝났다고 판단하는 근거. error는 정당한 문장을 하나도 막지 않고,
  // 놓치는 것은 warn이 전부 표면화한다. 이 수치가 나빠지면 설계를 다시 봐야 한다.
  const of = (text) => {
    const r = lintDraftHtml(`<p>${text}</p>`, {});
    return {
      error: r.errors.some((e) => e.rule === 'no-writing-date-expression'),
      warn: r.warnings.some((w) => w.rule === 'writing-date-word'),
    };
  };

  const VIOLATION = [
    '오늘 오후에 다녀왔어요', '오늘 저녁에 들렀습니다', '오늘 낮에 방문했어요',
    '오늘 퇴근하고 다녀왔습니다', '오늘 아이 데리고 다녀왔어요',
    '오늘 비 오는데 다녀왔습니다', '어제 저녁에 갔다 왔습니다',
    '어제 오후 늦게 다녀왔어요', '조금 전 다녀온 곳이에요',
    '아까 들러서 사 왔어요', '이번 주 화요일에 다녀왔습니다',
    '오늘 아침 일찍 갔어요', '오늘 문 열자마자 갔습니다',
  ];
  const LEGIT = [
    '오늘 소개할 곳은 지난 봄에 다녀온 카페입니다',
    '오늘 글에서 다룰 가게는 작년에 방문했던 곳입니다',
    '오늘 정리한 사진은 5월 초 다녀온 것입니다',
    '오늘 기준 영업시간은 오후 9시까지입니다',
    '오늘 기준 주차는 2시간 무료입니다',
    '오늘 기준 메뉴 가격이 올랐다고 합니다',
    '지금 예약은 네이버로만 받는다고 합니다',
    '지금 기준으로 웨이팅은 없다고 하네요',
    '아까 말한 그 메뉴가 시그니처입니다',
    '방금 언급한 주차장이 건물 뒤에 있습니다',
    '오늘처럼 흐린 날에 가면 사진이 잘 나옵니다',
    '오늘의 커피는 에티오피아 원두였습니다',
    '어제오늘 생긴 가게가 아닙니다',
    '지금까지 마신 라떼 중 부드러웠습니다',
    '이번 주 내내 휴무라고 적혀 있었습니다',
    '오늘 날짜로 리뉴얼 공지가 붙어 있었습니다',
    '지금 시점에는 예약이 필수라고 합니다',
    '오늘 하루 종일 비가 왔다고 들었습니다',
    '오늘 아침 뉴스에서 이 동네가 나왔습니다',
    '어제 내린 눈이 아직 남아 있었습니다',
  ];

  // **오탐 0** — error가 정당한 문장을 막지 않는다 (막으면 발행 불가)
  const blocked = LEGIT.filter((t) => of(t).error);
  assert.deepEqual(blocked, [], `정당한 문장을 차단: ${blocked.join(' / ')}`);

  // **미탐은 warn이 전부 덮는다** — 조용히 LIVE로 나가지 않는다
  const uncovered = VIOLATION.filter((t) => { const x = of(t); return !x.error && !x.warn; });
  assert.deepEqual(uncovered, [], `error도 warn도 놓침: ${uncovered.join(' / ')}`);

  // error 적중률도 계량으로 고정한다 (떨어지면 원인을 확인해야 한다)
  const caught = VIOLATION.filter((t) => of(t).error).length;
  assert.ok(caught >= 12, `error 적중이 ${caught}/${VIOLATION.length}로 떨어졌다`);
});
