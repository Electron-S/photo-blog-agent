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
  const uploadResult = {
    images: [{
      index: 1,
      webpUrl: 'https://mine.github.io/posts/2026-05-10-abc/photo-01.webp',
      width: 1024,
      height: 768,
    }],
  };
  const warnsFor = (src) => lintDraftHtml(FIG(src), { uploadResult })
    .warnings.map((w) => w.rule);

  assert.ok(!warnsFor('https://mine.github.io/posts/2026-05-10-abc/photo-01.webp')
    .includes('upload-match-by-filename'), '같은 호스트인데 경고');
  assert.ok(warnsFor('https://old.example/posts/2026-05-10-abc/photo-01.webp')
    .includes('upload-match-by-filename'), '호스트가 다른데 조용함');
  // 상대 경로는 호스트를 비교할 수 없으므로 관용 매칭을 유지한다 (경고 없음)
  assert.ok(!warnsFor('/posts/2026-05-10-abc/photo-01.webp')
    .includes('upload-match-by-filename'));
  // --upload-result가 없으면 이 규칙은 아예 돌지 않는다
  assert.deepEqual(
    lintDraftHtml(FIG('https://x/a.webp'), {}).warnings
      .filter((w) => w.rule === 'upload-match-by-filename'),
    [],
  );
});
