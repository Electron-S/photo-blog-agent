const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHtml, findAll, getAttr, textOf, nextElementSibling, ancestors, lineOf,
} = require('../lib/html-parse');

test('속성 값 안의 > 와 / 를 태그 종료로 오인하지 않는다', () => {
  const { root, errors } = parseHtml('<img alt="a > b" src="x/y.webp">');
  assert.deepEqual(errors, []);
  const img = findAll(root, 'img')[0];
  assert.equal(getAttr(img, 'alt'), 'a > b');
  assert.equal(getAttr(img, 'src'), 'x/y.webp');
});

test('따옴표 없는 속성 값', () => {
  const { root } = parseHtml('<img width=1024 height=768 src=a.webp>');
  const img = findAll(root, 'img')[0];
  assert.equal(getAttr(img, 'width'), '1024');
  assert.equal(getAttr(img, 'height'), '768');
  assert.equal(getAttr(img, 'src'), 'a.webp');
});

test('작은따옴표 속성 값', () => {
  const { root } = parseHtml("<img src='a.webp' alt='설명'>");
  const img = findAll(root, 'img')[0];
  assert.equal(getAttr(img, 'src'), 'a.webp');
  assert.equal(getAttr(img, 'alt'), '설명');
});

test('self-closing과 void 태그는 스택에 쌓이지 않는다', () => {
  const { root, errors } = parseHtml('<p>a<br>b<img src="x.webp" />c</p>');
  assert.deepEqual(errors, []);
  const p = findAll(root, 'p')[0];
  assert.equal(findAll(p, 'br').length, 1);
  assert.equal(findAll(p, 'img').length, 1);
});

test('대문자 태그와 속성명은 소문자로 정규화된다', () => {
  const { root } = parseHtml('<FIGURE STYLE="x"><IMG SRC="a.webp" LOADING="lazy"></FIGURE>');
  const fig = findAll(root, 'figure')[0];
  assert.ok(fig);
  assert.equal(getAttr(fig, 'style'), 'x');
  assert.equal(getAttr(findAll(root, 'img')[0], 'loading'), 'lazy');
});

test('여러 줄에 걸친 속성 (실제 초안 형태)', () => {
  const html = `<figure style="margin:1.5em 0;">
  <img loading="lazy" width="1024" height="768"
       src="https://x/photo-01.webp"
       alt="구체적인 설명"
       style="max-width:100%;height:auto;" />
  <figcaption>캡션 문장이다.</figcaption>
</figure>`;
  const { root, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  const img = findAll(root, 'img')[0];
  assert.equal(getAttr(img, 'src'), 'https://x/photo-01.webp');
  assert.equal(getAttr(img, 'alt'), '구체적인 설명');
  assert.equal(getAttr(img, 'style'), 'max-width:100%;height:auto;');
});

test('주석은 건너뛴다', () => {
  const { root, errors } = parseHtml('<p>a</p><!-- <p>주석 안</p> --><p>b</p>');
  assert.deepEqual(errors, []);
  assert.equal(findAll(root, 'p').length, 2);
});

test('닫히지 않은 주석은 오류', () => {
  const { errors } = parseHtml('<p>a</p><!-- 안 닫힘');
  assert.equal(errors[0].code, 'unterminated-comment');
});

test('미닫힘 태그를 조용히 복구하지 않고 오류로 표면화한다', () => {
  const { errors } = parseHtml('<figure><img src="a.webp">');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unclosed-tag');
  assert.equal(errors[0].tag, 'figure');
});

test('고아 닫는 태그도 오류', () => {
  const { errors } = parseHtml('<p>a</p></figure>');
  assert.equal(errors[0].code, 'orphan-closing-tag');
  assert.equal(errors[0].tag, 'figure');
});

test('중첩이 어긋나면 사이의 태그를 미닫힘으로 보고한다', () => {
  const { errors } = parseHtml('<figure><p>a</figure>');
  assert.ok(errors.some((e) => e.code === 'unclosed-tag' && e.tag === 'p'));
});

test('중첩 figure', () => {
  const { root, errors } = parseHtml('<figure><figure><img src="a.webp"></figure></figure>');
  assert.deepEqual(errors, []);
  assert.equal(findAll(root, 'figure').length, 2);
});

test('원본의 리터럴 NUL은 제거된다 (센티널과 구별 불가하므로)', () => {
  const { BR_SENTINEL } = require('../lib/html-parse');
  const NUL = String.fromCharCode(0);
  // 남겨두면 <br>이 만든 센티널과 구별되지 않아 가짜 문장 경계가 되고,
  // text-after-figure(error)가 조용히 통과한다.
  const { root, source } = parseHtml(`<p>가${NUL}나</p>`);
  assert.ok(!source.includes(BR_SENTINEL));
  assert.equal(textOf(root), '가나');
  // <br>은 여전히 센티널이 된다
  assert.equal(textOf(parseHtml('<p>가<br>나</p>').root), `가${BR_SENTINEL}나`);
});

test('CRLF와 BOM 정규화', () => {
  const { root, errors, source } = parseHtml('﻿<p>a</p>\r\n<p>b</p>');
  assert.deepEqual(errors, []);
  assert.equal(findAll(root, 'p').length, 2);
  assert.ok(!source.includes('\r'));
  assert.ok(!source.startsWith('﻿'));
});

test('textOf — skipTags로 figcaption 제외', () => {
  const { root } = parseHtml('<figure><img src="a.webp" alt="ALT"><figcaption>캡션</figcaption></figure><p>본문</p>');
  assert.equal(textOf(root).replace(/\s+/g, ''), '캡션본문');
  assert.equal(textOf(root, ['figcaption']).replace(/\s+/g, ''), '본문');
  // alt는 속성이라 애초에 텍스트에 포함되지 않는다
  assert.ok(!textOf(root).includes('ALT'));
});

test('textOf — <br>만 센티널이 되고 소스 줄바꿈은 그대로다', () => {
  const { BR_SENTINEL } = require('../lib/html-parse');

  // <br>은 전용 센티널로 나온다.
  assert.equal(textOf(parseHtml('<p>첫 문장<br>둘째 문장</p>').root), `첫 문장${BR_SENTINEL}둘째 문장`);

  // HTML 소스의 줄바꿈은 텍스트 그대로다. 둘을 구분하지 않으면 초안이 소스에서
  // 접혀 있다는 이유만으로 문장 수가 부풀려져 text-after-figure(error)가
  // 조용히 통과한다.
  assert.equal(textOf(parseHtml('<p>첫 문장\n둘째 문장</p>').root), '첫 문장\n둘째 문장');
  assert.ok(!textOf(parseHtml('<p>a\nb</p>').root).includes(BR_SENTINEL));
});

test('nextElementSibling — 공백은 건너뛰고 실제 텍스트는 형제를 끊는다', () => {
  const a = parseHtml('<figure></figure>\n  <h3>제목</h3>');
  assert.equal(nextElementSibling(findAll(a.root, 'figure')[0]).tag, 'h3');

  const b = parseHtml('<figure></figure>문장이 있다.<h3>제목</h3>');
  assert.equal(nextElementSibling(findAll(b.root, 'figure')[0]), null);

  const c = parseHtml('<figure></figure>');
  assert.equal(nextElementSibling(findAll(c.root, 'figure')[0]), null);
});

test('ancestors — img가 figure 안에 있는지 판정', () => {
  const { root } = parseHtml('<figure><span><img src="a.webp"></span></figure><img src="b.webp">');
  const [inFig, outFig] = findAll(root, 'img');
  assert.ok(ancestors(inFig).some((n) => n.tag === 'figure'));
  assert.ok(!ancestors(outFig).some((n) => n.tag === 'figure'));
});

test('lineOf', () => {
  const src = 'a\nb\nc';
  assert.equal(lineOf(src, 0), 1);
  assert.equal(lineOf(src, 2), 2);
  assert.equal(lineOf(src, 4), 3);
});

test('빈 입력과 null', () => {
  assert.deepEqual(parseHtml('').errors, []);
  assert.deepEqual(parseHtml(null).errors, []);
});

test('style/script 내부는 마크업으로 파싱하지 않는다', () => {
  const { root, errors } = parseHtml('<style>.x{content:"<p>"}</style><p>진짜</p>');
  assert.deepEqual(errors, []);
  assert.equal(findAll(root, 'p').length, 1);
});

// --- 7차 리뷰 회귀: 조용히 마크업을 삼키던 경로 ---
//
// 이 파서가 존재하는 이유는 "관대한 파싱이 곧 silent failure"이기 때문인데,
// 정작 세 곳에서 오류 없이 내용을 삼키고 있었다. 그 결과 **사진이 빠진 글이
// lint를 exit 0으로 통과**한다 — figure에 img가 필수라는 규칙이 없어서
// img 관련 규칙 6개가 전부 "img가 없으니 위반도 없음"이 된다.

test("'>'를 빠뜨린 태그가 다음 요소를 속성으로 삼키지 않는다", () => {
  const bad = '<figure style="margin:1.5em 0" '
    + '<img src="https://x/photo-01.webp" width="1024" height="768" alt="외관" loading="lazy">'
    + '</figure>';
  const { root, errors } = parseHtml(bad);
  assert.equal(errors.length, 1, `오류가 보고되지 않음: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].code, 'malformed-tag');
  assert.match(errors[0].message, /'>'/);
  // 삼켜졌던 요소가 살아난다
  const imgs = findAll(root, 'img');
  assert.equal(imgs.length, 1, '<img>가 여전히 사라짐');
  assert.equal(getAttr(imgs[0], 'src'), 'https://x/photo-01.webp');
  // 속성으로 위장하지 않는다
  assert.equal(getAttr(findAll(root, 'figure')[0], '<img'), undefined);

  // 정상 태그는 영향 없음
  assert.deepEqual(parseHtml('<figure style="a"><img src="x.webp"></figure>').errors, []);
});

test("'<!'로 시작하는 비-DOCTYPE 선언은 오류로 보고한다", () => {
  // `<!- note` 같은 주석 오타가 다음 '>'까지 통째로 삼켰고 errors는 빈 배열이었다.
  const { root, errors } = parseHtml('<p>a</p><!- note <img src="x.webp"><p>b</p>');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'bogus-declaration');
  assert.match(errors[0].message, /<!-- -->/);
  // 삼켜진 범위는 다음 '>'까지 — 즉 <img>가 사라진다. 그래서 오류 보고가 필수다.
  assert.equal(findAll(root, 'img').length, 0);
  assert.equal(findAll(root, 'p').length, 2);

  // DOCTYPE과 정상 주석은 조용히 통과
  assert.deepEqual(parseHtml('<!DOCTYPE html><p>a</p>').errors, []);
  assert.deepEqual(parseHtml('<!doctype HTML><p>a</p>').errors, []);
  assert.deepEqual(parseHtml('<p>a</p><!-- 설명 --><p>b</p>').errors, []);
});

test('빈 주석 <!--> <!---> 은 유효하다 (거짓 빨강 금지)', () => {
  // 스펙상 유효한 빈 주석인데 unterminated-comment로 보고 문서 나머지를 버렸다.
  for (const html of ['<p>a</p><!--><p>b</p>', '<p>a</p><!---><p>b</p>', '<p>a</p><!----><p>b</p>']) {
    const { root, errors } = parseHtml(html);
    assert.deepEqual(errors, [], `${html}: 거짓 오류`);
    assert.equal(findAll(root, 'p').length, 2, `${html}: 뒤 내용이 버려짐`);
  }
  // 진짜로 닫히지 않은 주석은 여전히 오류다
  assert.equal(parseHtml('<p>a</p><!-- 안 닫힘').errors[0].code, 'unterminated-comment');
});

test('닫는 태그에 잡다한 것이 붙어도 raw text 요소를 닫는다', () => {
  // `</script foo>`를 못 닫으면 문서 나머지가 script 본문으로 삼켜진다.
  const { root, errors } = parseHtml('<p>a</p><script>x=1;</script foo><p>b</p>');
  assert.deepEqual(errors, []);
  assert.equal(findAll(root, 'p').length, 2);
});

test("따옴표 없는 속성값에서도 '<'가 종료 문자다", () => {
  // 속성 **이름** 쪽만 고치고 값 쪽을 빼두면 헤드라인 버그가 이 한 위치에서
  // 그대로 살아남는다 — 판정 기준이 위치에 따라 달라지는 형태다.
  const { root, errors } = parseHtml('<figure class=foo<img src="b.webp"></figure>');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'malformed-tag');
  assert.equal(findAll(root, 'img').length, 1, '<img>가 여전히 사라짐');
  // 정상적인 따옴표 없는 값은 영향 없다
  assert.deepEqual(parseHtml('<img width=100 height=200 src="a.webp">').errors, []);
  assert.equal(getAttr(findAll(parseHtml('<img width=100 src="a.webp">').root, 'img')[0], 'width'), '100');
  // 값 안의 <는 따옴표 안이므로 무해하다
  assert.deepEqual(parseHtml('<img alt="1<2" src="a.webp">').errors, []);
  assert.equal(getAttr(findAll(parseHtml('<img alt="1<2" src="a.webp">').root, 'img')[0], 'alt'), '1<2');
});
