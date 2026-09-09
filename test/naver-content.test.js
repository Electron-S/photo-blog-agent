// 브라우저 없이 검증 가능한 네이버 콘텐츠 파이프라인 테스트.
// (에디터 조작은 실물 DOM 확인 게이트를 통과한 뒤에 구현·검증한다.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  htmlToBlocks, localPathFor, resolveImagePaths, summarizeBlocks,
} = require('../lib/naver-content');
const { NAVER_EXIT } = require('../lib/naver-errors');

const FIG = (n, cap = '캡션 문장이다.') =>
  `<figure style="margin:1.5em 0;text-align:center;position:relative;">`
  + `<img loading="lazy" width="1024" height="768" style="max-width:100%;height:auto;" `
  + `src="https://electron-s.github.io/photo-blog-assets/posts/2026-05-10-abc123def456/photo-0${n}.webp" alt="설명">`
  + `<figcaption>${cap}</figcaption></figure>`;

test('htmlToBlocks — 문단/제목/이미지 순서 보존', () => {
  const { blocks } = htmlToBlocks(`<p>첫 문단이다.</p>${FIG(1)}<h3>부제목</h3><p>둘째 문단이다.</p>`);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'image', 'heading', 'paragraph']);
  assert.equal(blocks[0].text, '첫 문단이다.');
  assert.equal(blocks[2].level, 3);
  assert.equal(blocks[2].text, '부제목');
});

test('htmlToBlocks — HTML 태그가 본문 텍스트로 새지 않는다', () => {
  // 예전 구현의 핵심 결함: HTML 전문을 문단 텍스트로 타이핑해서
  // <figure style=...>가 본문에 그대로 찍혔다.
  const { blocks } = htmlToBlocks(`<p>안녕 <strong>굵게</strong> 끝.</p>${FIG(1)}`);
  assert.equal(blocks[0].text, '안녕 굵게 끝.');
  for (const b of blocks) {
    if (b.type === 'image') continue;
    assert.ok(!b.text.includes('<'), `태그가 텍스트에 남았다: ${b.text}`);
    assert.ok(!b.text.includes('style='), `속성이 텍스트에 남았다: ${b.text}`);
  }
});

test('htmlToBlocks — 이미지 블록은 src/alt/caption을 담는다', () => {
  const { blocks } = htmlToBlocks(`${FIG(3, '골목 끝 간판이 인상적이었다.')}<p>문장.</p>`);
  const img = blocks[0];
  assert.equal(img.type, 'image');
  assert.match(img.src, /photo-03\.webp$/);
  assert.equal(img.alt, '설명');
  assert.equal(img.caption, '골목 끝 간판이 인상적이었다.');
  assert.equal(img.localPath, null);
});

test('htmlToBlocks — 링크는 평문화하되 무엇이 평문화됐는지 보고한다', () => {
  const { blocks, links } = htmlToBlocks(
    '<p><a href="https://x.com" target="_blank">공식 홈페이지</a>를 참고하자.</p>',
  );
  assert.equal(blocks[0].text, '공식 홈페이지 (https://x.com)를 참고하자.');
  assert.deepEqual(links, [{ text: '공식 홈페이지', href: 'https://x.com' }]);
});

test('htmlToBlocks — div/section은 컨테이너로 펼친다', () => {
  const { blocks } = htmlToBlocks('<div><p>가.</p><section><p>나.</p></section></div>');
  assert.deepEqual(blocks.map((b) => b.text), ['가.', '나.']);
});

test('htmlToBlocks — 목록은 불릿으로 평문화', () => {
  const { blocks } = htmlToBlocks('<ul><li>주차 무료</li><li>예약 필수</li></ul>');
  assert.deepEqual(blocks.map((b) => b.text), ['- 주차 무료', '- 예약 필수']);
});

test('htmlToBlocks — <br>은 줄바꿈', () => {
  const { blocks } = htmlToBlocks('<p>첫 줄<br>둘째 줄</p>');
  assert.equal(blocks[0].text, '첫 줄\n둘째 줄');
});

test('htmlToBlocks — 엔티티 디코드', () => {
  const { blocks } = htmlToBlocks('<p>커피 &amp; 차, &quot;인용&quot;, &nbsp;공백.</p>');
  assert.equal(blocks[0].text, '커피 & 차, "인용", 공백.');
});

test('htmlToBlocks — 허용 밖 요소를 조용히 버리지 않는다', () => {
  assert.throws(() => htmlToBlocks('<p>ok.</p><table><tr><td>x</td></tr></table>'), /허용되지 않은 블록 요소/);
  assert.throws(() => htmlToBlocks('<p><marquee>x</marquee></p>'), /허용되지 않은 요소/);
});

test('htmlToBlocks — 구조가 깨진 HTML은 변환하지 않는다', () => {
  assert.throws(() => htmlToBlocks('<figure><img src="a.webp">'), /구조 오류/);
});

test('htmlToBlocks — figure에 img가 없거나 여럿이면 실패', () => {
  assert.throws(() => htmlToBlocks('<figure><figcaption>캡션</figcaption></figure>'), /<img>가 0개/);
  assert.throws(
    () => htmlToBlocks('<figure><img src="a.webp"><img src="b.webp"></figure>'),
    /<img>가 2개/,
  );
});

test('htmlToBlocks — 실제 초안 6건 전부 변환된다', () => {
  const dir = path.join(__dirname, 'fixtures', 'drafts');
  for (const f of fs.readdirSync(dir)) {
    const { blocks } = htmlToBlocks(fs.readFileSync(path.join(dir, f), 'utf8'));
    const s = summarizeBlocks(blocks);
    assert.ok(s.images > 0, `${f}: 이미지 블록이 없다`);
    assert.ok(s.paragraphs > 0, `${f}: 문단 블록이 없다`);
    assert.ok(s.chars > 1000, `${f}: 텍스트가 ${s.chars}자뿐`);
  }
});

test('localPathFor — GitHub Pages URL을 로컬 경로로', () => {
  assert.equal(
    localPathFor('https://x.github.io/assets/posts/2026-05-10-abc123/photo-01.webp', { assetsRoot: 'tmp/assets' }),
    path.join('tmp/assets', '2026-05-10-abc123', 'photo-01.webp'),
  );
  // encodeURIComponent된 경로도 해석한다
  assert.equal(
    localPathFor('https://x/posts/2026-05-10-abc%20123/photo-01.webp', { assetsRoot: 'tmp/assets' }),
    path.join('tmp/assets', '2026-05-10-abc 123', 'photo-01.webp'),
  );
  // --image-dir 지정 시 basename만 쓴다
  assert.equal(
    localPathFor('https://x/posts/d/photo-02.webp', { assetsRoot: 'tmp/assets', imageDir: '/img' }),
    path.join('/img', 'photo-02.webp'),
  );
  // 규약 밖 URL은 해석 실패
  assert.equal(localPathFor('https://x/other/a.webp', { assetsRoot: 'tmp/assets' }), null);
});

test('resolveImagePaths — 파일이 있으면 localPath를 채운다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-nv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const postDir = path.join(dir, '2026-05-10-abc123def456');
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, 'photo-01.webp'), 'x', 'utf8');

  const { blocks } = htmlToBlocks(`${FIG(1)}<p>문장.</p>`);
  resolveImagePaths(blocks, { assetsRoot: dir });
  assert.equal(blocks[0].localPath, path.resolve(postDir, 'photo-01.webp'));
});

test('resolveImagePaths — 파일이 없으면 exit 16, URL로 폴백하지 않는다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-nv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const { blocks } = htmlToBlocks(`${FIG(1)}<p>문장.</p>`);
  let thrown;
  try { resolveImagePaths(blocks, { assetsRoot: dir }); } catch (e) { thrown = e; }
  assert.ok(thrown, '실패해야 한다');
  assert.equal(thrown.exitCode, NAVER_EXIT.IMAGE);
  assert.match(thrown.message, /핫링킹/);
  // 폴백해서 URL을 넣지 않았는지
  assert.equal(blocks[0].localPath, null);
});

test('summarizeBlocks', () => {
  const { blocks } = htmlToBlocks(`<p>가나다.</p>${FIG(1)}<h3>제목</h3><p>라마.</p>`);
  assert.deepEqual(summarizeBlocks(blocks), {
    total: 4, headings: 1, paragraphs: 2, images: 1, chars: '가나다.제목라마.'.length,
    hardBreaks: 0,
  });
});

test('summarizeBlocks — hardBreaks가 출력 계약을 눈에 보이게 한다', () => {
  // 파일 헤더의 계약: text의 '\n'은 Shift+Enter로 넣어야 하는 하드 개행이다.
  // 그 수가 dry-run에 안 보이면, 에디터 레이어가 Enter로 처리해 문단 수가
  // 달라져도 아무도 눈치채지 못한다.
  const { blocks } = htmlToBlocks('<h2>가<br>나</h2><p>다<br>라<br>마</p>');
  assert.equal(summarizeBlocks(blocks).hardBreaks, 3);
  // 소스 줄바꿈은 하드 개행이 아니다
  assert.equal(summarizeBlocks(htmlToBlocks('<p>가\n나</p>').blocks).hardBreaks, 0);
  // 이미지 필드에는 개행이 없다는 계약
  const img = htmlToBlocks(`${FIG(1)}`).blocks[0];
  for (const field of ['alt', 'caption', 'src']) {
    assert.ok(!img[field].includes('\n'), `image.${field}에 개행이 있다`);
  }
});

// --- 4차 리뷰에서 확인된 결함들의 회귀 고정 ---

test('htmlToBlocks — <br>만 줄바꿈이고 HTML 소스 줄바꿈은 공백이다', () => {
  // lib/html-parse.js가 BR_SENTINEL을 도입한 이유가 이 파일에서만 무효화돼 있었다.
  // 초안이 한 번이라도 pretty-print되면 소스 줄바꿈이 전부 하드 개행으로
  // 에디터에 타이핑된다.
  assert.equal(htmlToBlocks('<p>첫 줄<br>둘째 줄</p>').blocks[0].text, '첫 줄\n둘째 줄');
  assert.equal(htmlToBlocks('<p>첫 줄\n둘째 줄</p>').blocks[0].text, '첫 줄 둘째 줄');
  assert.equal(htmlToBlocks('<p>첫 줄\n  들여쓰기</p>').blocks[0].text, '첫 줄 들여쓰기');
});

test('htmlToBlocks — <a> 안팎의 <br>이 같게 처리된다', () => {
  assert.equal(
    htmlToBlocks('<p><a href="https://x.com">가<br>나</a></p>').blocks[0].text,
    '가\n나 (https://x.com)',
  );
});

test('htmlToBlocks — 엔티티는 위치와 무관하게 정확히 한 번 디코드된다', () => {
  // 예전에는 <a> 라벨만 두 번 디코드돼, 같은 소스 텍스트가 <a> 안에서는 `<`,
  // 밖에서는 `&lt;`가 됐다 (커밋 a1f6bbf가 splitSentences에서 고친 것과 같은 버그).
  const r = htmlToBlocks('<p><a href="https://x.com?a=1&amp;b=2">&amp;lt;가</a> &amp;lt;나</p>');
  assert.equal(r.blocks[0].text, '&lt;가 (https://x.com?a=1&b=2) &lt;나');
  // links의 href도 본문에 박히는 값과 같은 형태여야 한다
  assert.deepEqual(r.links, [{ text: '&lt;가', href: 'https://x.com?a=1&b=2' }]);
});

test('htmlToBlocks — alt와 caption이 같은 기준으로 디코드된다', () => {
  const img = htmlToBlocks(
    '<figure><img src="a.webp" alt="카페 &amp; 베이커리"><figcaption>카페 &amp; 베이커리</figcaption></figure>',
  ).blocks[0];
  assert.equal(img.alt, '카페 & 베이커리');
  assert.equal(img.caption, '카페 & 베이커리');
});

test('htmlToBlocks — 엔티티로 만든 NUL이 에디터 페이로드에 실리지 않는다', () => {
  // parseHtml이 원본의 리터럴 NUL을 지우지만, decodeEntities는 파싱 **이후**에
  // `&#0;`로 NUL을 다시 만들어낸다. 그 값이 네이버 에디터에 타이핑될 뻔했다.
  const NUL = String.fromCharCode(0);
  for (const html of ['<p>가&#0;나</p>', '<h2>제&#x0;목</h2>', '<p><a href="https://x.com">가&#0;나</a></p>']) {
    const text = htmlToBlocks(html).blocks[0].text;
    assert.ok(!text.includes(NUL), `NUL 누출: ${html}`);
  }
  assert.equal(summarizeBlocks(htmlToBlocks('<p>가&#0;나</p>').blocks).chars, 2);
});

test('htmlToBlocks — <a> 안에서도 화이트리스트가 적용된다', () => {
  // 예전에는 <a> 라벨만 textOf를 써서 화이트리스트를 통째로 우회했다.
  // <script> 본문이 본문 텍스트로 주입되고 <img>는 조용히 사라졌다.
  assert.throws(
    () => htmlToBlocks('<p><a href="https://x.com"><script>alert(1)</script>label</a></p>'),
    /허용되지 않은 요소/,
  );
  assert.throws(
    () => htmlToBlocks('<p><a href="https://x.com"><img src="https://h/p.webp"></a></p>'),
    /허용되지 않은 요소/,
  );
  assert.throws(
    () => htmlToBlocks('<p><a href="https://x.com"><table><tr><td>표</td></tr></table></a></p>'),
    /허용되지 않은 요소/,
  );
});

test('htmlToBlocks — figure/ul이 허용 밖 자식을 조용히 버리지 않는다', () => {
  assert.throws(
    () => htmlToBlocks('<figure><img src="a.webp"><figcaption>캡</figcaption><p>숨은문단</p></figure>'),
    /<figure> 안에 아무도 소비하지 않는 내용/,
  );
  assert.throws(
    () => htmlToBlocks('<figure><img src="a.webp"><figcaption>하나</figcaption><figcaption>둘</figcaption></figure>'),
    /figcaption>이 2개/,
  );
  assert.throws(
    () => htmlToBlocks('<ul><li>가</li><div>숨음</div></ul>'),
    /<ul> 안에 아무도 소비하지 않는 내용/,
  );
});

// --- 5차 리뷰 회귀 ---
//
// 이 라운드의 결함은 전부 같은 뿌리였다: **raw 문자열과 최종화된 문자열을 한
// 버퍼에 섞는 것.** 그래서 조각마다 디코드 횟수·<br> 처리·화이트리스트 적용이
// 달라졌다. 이제 재귀가 조각 배열을 돌려주고 finalizeParts가 한 번에 정리하므로,
// 테스트도 "케이스"가 아니라 **위치 전수**로 확인한다.

test('빈 줄 스페이서 <p><br></p>는 블록을 만들지 않는다 (&nbsp; 관용구와 같은 결과)', () => {
  // 이전 구현은 조각별로만 trim하고 join 뒤를 trim하지 않아 text="\n"인
  // 빈 문단·빈 제목·내용 없는 불릿("- ")을 만들었다. 에디터에 그대로 타이핑된다.
  for (const html of ['<p><br></p>', '<h2><br></h2>', '<h3><br></h3>']) {
    assert.deepEqual(htmlToBlocks(html).blocks, [], `${html} 가 빈 블록을 만듦`);
  }
  // <li>는 다르다. 빈 문단은 스페이서 관용구지만 빈 목록 항목은 저작 오류이고,
  // 평문화하면 그 항목이 소멸한다 (번호가 있으면 이후 번호까지 어긋난다).
  assert.throws(() => htmlToBlocks('<ul><li><br></li></ul>'), /내용이 없는 <li>/);
  // 같은 목적의 &nbsp; 스페이서와 결과가 같아야 한다
  assert.deepEqual(htmlToBlocks('<p>&nbsp;</p>').blocks, []);
  // 앞뒤 <br>만 정리하고 **중간의 의도된 빈 줄은 보존**한다
  assert.equal(htmlToBlocks('<p>가<br></p>').blocks[0].text, '가');
  assert.equal(htmlToBlocks('<p><br>가</p>').blocks[0].text, '가');
  assert.equal(htmlToBlocks('<p>가<br>나</p>').blocks[0].text, '가\n나');
  assert.equal(htmlToBlocks('<p>가<br><br>나</p>').blocks[0].text, '가\n\n나');
});

test('figcaption도 인라인 화이트리스트를 탄다 (<a>에서 고친 우회가 여기 남아 있었다)', () => {
  assert.throws(
    () => htmlToBlocks('<figure><img src="a.webp"><figcaption><script>alert(1)</script>캡션</figcaption></figure>'),
    /허용되지 않은 요소/,
  );
  // figcaption 안의 링크가 조용히 사라지지 않는다
  const r = htmlToBlocks('<figure><img src="a.webp"><figcaption>가<span><a href="http://h/">링크</a></span></figcaption></figure>');
  assert.deepEqual(r.links, [{ text: '링크', href: 'http://h/' }]);
  assert.match(r.blocks[0].caption, /http:\/\/h\//);
});

test('alt와 caption은 같은 파이프라인 — 디코드 1회, 제어문자 제거, 한 줄', () => {
  const capOf = (h) => htmlToBlocks(h).blocks[0];
  // NUL(`&#0;`)이 alt로만 새던 것 — 커밋이 막으려던 페이로드가 그대로 실렸다
  let b = capOf('<figure><img src="a.webp" alt="가&#0;나"><figcaption>가&#0;나</figcaption></figure>');
  assert.equal(b.alt, '가나');
  assert.equal(b.caption, '가나');
  // 엔티티는 정확히 한 번만 디코드된다
  b = capOf('<figure><img src="a.webp" alt="&amp;amp;x"><figcaption>&amp;amp;x</figcaption></figure>');
  assert.equal(b.alt, '&amp;x');
  assert.equal(b.caption, '&amp;x');
  // 한 줄 입력 필드라 개행이 남으면 안 된다
  b = capOf('<figure><img src="a.webp" alt="a  b&#10;c"><figcaption>a<br>b</figcaption></figure>');
  assert.equal(b.alt, 'a b c');
  assert.equal(b.caption, 'a b');
  assert.ok(!b.caption.includes('\n') && !b.alt.includes('\n'));
});

test('엔티티는 위치와 무관하게 정확히 한 번 디코드된다 (컨테이너 직속 텍스트 포함)', () => {
  // <div> 직속 텍스트만 normalizeWhitespace 위에 decodeEntities를 한 번 더 얹어
  // `&amp;lt;`가 거기서만 `<`가 됐다 (a1f6bbf가 splitSentences에서 고친 버그).
  const textOfFirst = (h) => htmlToBlocks(h).blocks[0].text;
  for (const wrap of ['<p>%s</p>', '<div>%s</div>', '<section>%s</section>',
    '<p><strong>%s</strong></p>', '<ul><li>%s</li></ul>', '<h3>%s</h3>']) {
    const html = wrap.replace('%s', '&amp;lt;가');
    assert.match(textOfFirst(html), /&lt;가/, `${html} 가 이중 디코드됨`);
  }
});

test('제어문자는 디코드로 되살아나도 페이로드에 실리지 않는다', () => {
  // NUL만 막고 있었다. 근거("에디터에 타이핑될 페이로드")는 나머지 C0/C1에도 같다.
  for (const ent of ['&#0;', '&#8;', '&#27;', '&#127;', '&#133;']) {
    const t = htmlToBlocks(`<p>가${ent}나</p>`).blocks[0].text;
    assert.equal(t, '가나', `${ent} 가 남음: ${JSON.stringify(t)}`);
    assert.ok(![...t].some((c) => c.codePointAt(0) < 0x20), `${ent}: 제어문자 잔존`);
  }
  // 공백류 엔티티는 제거가 아니라 공백 1칸으로 접힌다 (<br>과 구별된다)
  assert.equal(htmlToBlocks('<p>가&#10;나</p>').blocks[0].text, '가 나');
  assert.equal(htmlToBlocks('<p>가&#9;나</p>').blocks[0].text, '가 나');
  assert.equal(htmlToBlocks('<p>가<br>나</p>').blocks[0].text, '가\n나');
});

test('links[].href는 본문에 박히는 문자열과 글자 단위로 같다', () => {
  // href만 따로 디코드해서, 공백·`&#0;`이 든 href가 본문과 links[]에서 갈렸다.
  // 사용자는 links[] 출력을 보고 손으로 링크를 다시 건다.
  for (const raw of ['https://x.com/a\nb', 'https://x.com/a&#0;b', '  https://x.com/a  ',
    'https://x.com/?a=1&amp;b=2', 'https://x.com/a  b']) {
    const r = htmlToBlocks(`<p><a href="${raw}">L</a></p>`);
    assert.equal(r.links.length, 1, raw);
    assert.ok(
      r.blocks[0].text.includes(`(${r.links[0].href})`),
      `본문 ${JSON.stringify(r.blocks[0].text)} 에 links.href ${JSON.stringify(r.links[0].href)} 가 그대로 없음`,
    );
  }
  // 공백뿐인 href는 링크가 아니다 — 빈 괄호를 본문에 남기지 않는다
  const blank = htmlToBlocks('<p><a href="   ">L</a></p>');
  assert.deepEqual(blank.links, []);
  assert.equal(blank.blocks[0].text, 'L');
});

// --- 6차 리뷰 회귀 ---
//
// 5차가 "조각 배열로 바꿔 위치 의존성을 없앴다"고 선언했는데, 판정 기준이 여전히
// **열거**로 남아 있던 곳들이다. 테스트도 열거가 아니라 클래스로 확인한다.

test('보이지 않는 문자는 코드포인트 목록이 아니라 카테고리로 제거된다 (Cc + Cf)', () => {
  // C0만 지우던 규칙에 Cf 전체가 새고 있었다. 근거("보이지 않는다 + 에디터
  // 페이로드에 실린다")가 같은데 판정이 "내가 적어둔 구간에 있나"였기 때문이다.
  // U+202E(RLO)는 이후 문단을 시각적으로 역전시키는 bidi 스푸핑 문자다.
  const INVISIBLE = [
    0x0000, 0x0008, 0x001B, 0x007F, 0x0085, // Cc
    0x00AD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x202A, 0x202E, 0x2060, 0x2066, 0x2069, 0xFEFF, 0x061C, 0xE0001, // Cf
  ];
  for (const cp of INVISIBLE) {
    const text = htmlToBlocks(`<p>가&#${cp};나</p>`).blocks[0].text;
    assert.equal(text, '가나', `U+${cp.toString(16).toUpperCase()} 잔존: ${JSON.stringify(text)}`);
  }
  // 8개 위치 전부에서 같아야 한다 — 파이프라인 통합의 요점
  const probe = (wrap) => htmlToBlocks(wrap.replace('%s', '가&#8203;나')).blocks[0];
  for (const wrap of ['<p>%s</p>', '<div>%s</div>', '<h3>%s</h3>', '<p><strong>%s</strong></p>',
    '<ul><li>%s</li></ul>', '<p><a href="https://x/">%s</a></p>']) {
    assert.match(probe(wrap).text, /가나/, `${wrap} 에서 ZWSP 잔존`);
  }
  const fig = htmlToBlocks('<figure><img src="a&#8203;.webp" alt="가&#8203;나"><figcaption>가&#8203;나</figcaption></figure>').blocks[0];
  assert.equal(fig.alt, '가나');
  assert.equal(fig.caption, '가나');
  assert.equal(fig.src, 'a.webp');

  // 공백류(Cc지만 \s)는 제거가 아니라 공백 1칸으로 접힌다 — 단어가 붙지 않게
  for (const cp of [0x09, 0x0A, 0x0B, 0x0C, 0x0D]) {
    assert.equal(htmlToBlocks(`<p>가&#${cp};나</p>`).blocks[0].text, '가 나',
      `U+${cp.toString(16)} 가 제거돼 단어가 붙음`);
  }
  // 보이는 문자는 건드리지 않는다
  assert.equal(htmlToBlocks('<p>가漢a1·※℃—…</p>').blocks[0].text, '가漢a1·※℃—…');
});

test('URL 구분자는 조각 안의 공백이 아니라 결합 시점에 넣는다', () => {
  // literal이 ` (url)`처럼 선행 공백을 품고 있으면, 그 조각이 줄의 첫 조각일 때
  // 마지막 trim이 공백을 먹는다. 주석이 "이미 trim된 상태라 재적용이 무해하다"고
  // 선언했던 불변식이 여기서 거짓이었다.
  const t = (h) => htmlToBlocks(h).blocks[0].text;
  assert.equal(t('<p>보기 <a href="https://x/">링크</a> 끝</p>'), '보기 링크 (https://x/) 끝');
  assert.equal(t('<p>앞<a href="https://x/"></a>뒤</p>'), '앞 (https://x/)뒤');
  // </a> 뒤는 붙는 것이 맞다 — 한국어 조사가 그렇게 온다
  assert.equal(t('<p>공식 <a href="https://x/">홈페이지</a>를 보자.</p>'), '공식 홈페이지 (https://x/)를 보자.');
  // URL은 어떤 경우에도 자기 라벨과 붙지 않는다
  for (const label of ['링크', 'a', '아주 긴 라벨 텍스트']) {
    assert.match(t(`<p>${label}<a href="https://x/">${label}</a></p>`), /\S \(https:\/\/x\/\)$/);
  }
});

test('중첩 <a>는 URL을 두 번 박지 않고 중단한다', () => {
  // html-parse도 lint도 중첩을 검사하지 않는다. 평문화하면 본문에
  // "x (안쪽) (바깥쪽)"이 되고 links[]에 두 줄이 쌓여 어느 링크인지 알 수 없다.
  assert.throws(
    () => htmlToBlocks('<p><a href="https://1/"><a href="https://2/">x</a></a></p>'),
    /중첩/,
  );
  assert.throws(
    () => htmlToBlocks('<p><a href="https://1/"><span><a href="https://2/">x</a></span></a></p>'),
    /중첩/,
  );
  // 형제 <a>는 정상
  const r = htmlToBlocks('<p><a href="https://1/">a</a><a href="https://2/">b</a></p>');
  assert.equal(r.links.length, 2);
});

test('<ol>의 순번과 start를 잃지 않고, 빈 <li>를 조용히 버리지 않는다', () => {
  const texts = (h) => htmlToBlocks(h).blocks.map((b) => b.text);
  assert.deepEqual(texts('<ul><li>가</li><li>나</li></ul>'), ['- 가', '- 나']);
  assert.deepEqual(texts('<ol><li>첫째</li><li>둘째</li></ol>'), ['1. 첫째', '2. 둘째']);
  assert.deepEqual(texts('<ol start="5"><li>다섯째</li></ol>'), ['5. 다섯째']);
  // 항목이 소멸하면 이후 번호가 어긋난다
  assert.throws(() => htmlToBlocks('<ol><li>첫째</li><li></li><li>셋째</li></ol>'), /내용이 없는 <li>/);
  // <li> 안의 <br>은 이어지는 줄이라 접두사를 다시 붙이지 않고 소속을 들여쓰기로 표시
  assert.deepEqual(texts('<ul><li>가<br>나</li></ul>'), ['- 가\n  나']);
  assert.deepEqual(texts('<ol><li>가<br>나</li></ol>'), ['1. 가\n   나']);
});

test('인라인 요소가 블록 위치에 있으면 <p>로 감싸라고 안내한다', () => {
  // 블록 목록만 나열하면 "<br>은 허용 태그인데 왜 안 되나"로 막힌다.
  const CASES = {
    br: '<div>가<br>나</div>',                          // void 태그
    strong: '<div>가<strong>나</strong></div>',
    a: '<div>가<a href="https://x/">링크</a></div>',
    span: '<div>가<span>나</span></div>',
  };
  for (const [tag, html] of Object.entries(CASES)) {
    assert.throws(() => htmlToBlocks(html), /<p>로 감싸세요/, `<${tag}> 안내가 없음`);
  }
  // 진짜 허용 밖 블록 요소는 허용 목록을 보여준다
  assert.throws(() => htmlToBlocks('<table><tr><td>x</td></tr></table>'), /허용되지 않은 블록 요소/);
});

test('src도 alt·caption과 같은 파이프라인을 탄다', () => {
  const src = (s) => htmlToBlocks(`<figure><img src="${s}"></figure>`).blocks[0].src;
  assert.equal(src('p/b&amp;c.webp'), 'p/b&c.webp');   // 디코드 1회
  assert.equal(src('p/b&#0;.webp'), 'p/b.webp');       // 제어문자 제거
  assert.equal(src('  p/a.webp  '), 'p/a.webp');       // 공백 정리
});

test('figure/ul이 소비되지 않은 텍스트도 조용히 버리지 않는다', () => {
  // 판정 기준이 "허용 안 된 **태그**"라서 elementChildren만 봤고, 텍스트 노드는
  // 검사 대상이 아니었다. lint에도 이걸 막는 규칙이 없다.
  assert.throws(() => htmlToBlocks('<ul>중요한 안내문<li>가</li></ul>'), /소비하지 않는 내용/);
  assert.throws(() => htmlToBlocks('<ol>서두<li>1</li></ol>'), /소비하지 않는 내용/);
  assert.throws(
    () => htmlToBlocks('<figure><img src="x.webp" alt="a">여기 캡션이 사라진다</figure>'),
    /소비하지 않는 내용/,
  );
  // pretty-print가 만든 공백 전용 텍스트는 내용이 아니다
  assert.equal(htmlToBlocks('<ul>\n  <li>가</li>\n</ul>').blocks.length, 1);
  assert.equal(
    htmlToBlocks('<figure>\n  <img src="x.webp" alt="a">\n  <figcaption>정상</figcaption>\n</figure>')
      .blocks[0].caption,
    '정상',
  );
  // 보이지 않는 문자만 있는 것도 내용이 아니다 (finalizeSource가 지운다)
  assert.equal(htmlToBlocks('<figure><img src="x.webp" alt="a">&#8203;</figure>').blocks.length, 1);
});

// --- 22차 리뷰 회귀 ---

test('localPathFor — percent-escape로 assetsRoot를 벗어날 수 없다', () => {
  // decodeURIComponent가 `%2e%2e%2f`를 `../`로 바꿔 해석 결과가 tmp/assets 밖으로
  // 나갔다. 초안 HTML은 모델이 쓴 것이라 공격 경로는 아니지만, "해석된 경로는
  // assetsRoot 안"이라는 불변식이 성립하지 않았다.
  for (const bad of [
    'https://x/posts/%2e%2e%2f%2e%2e%2fetc/passwd.webp',
    'https://x/posts/..%2fother/photo-01.webp',
    'https://x/posts/d/%2e%2e%2f%2e%2e%2fpasswd.webp',
  ]) {
    assert.equal(localPathFor(bad, { assetsRoot: 'tmp/assets' }), null, bad);
  }
  // 정상 경로는 계속 해석된다 (공백이 든 폴더명 포함 — 기존 계약)
  assert.equal(
    localPathFor('https://x/posts/2026-05-10-abc%20123/photo-01.webp', { assetsRoot: 'tmp/assets' }),
    path.join('tmp/assets', '2026-05-10-abc 123', 'photo-01.webp'),
  );
});

test('localPathFor — 잘못된 percent-escape는 src를 담은 오류를 낸다', () => {
  // decodeURIComponent가 raw URIError를 던져 generic catch에 걸렸고, 사용자에게는
  // "실패 (exit 1): URI malformed" 한 줄만 나갔다 — 어느 사진인지도, 무엇을 하라는지도
  // 없었다. 게다가 exit 1은 "인자 오류"로 문서화되어 있어 안내가 플래그를 가리켰다.
  assert.throws(
    () => localPathFor('https://x/posts/2026-05-14-a%zzb/photo-01.webp', { assetsRoot: 'tmp/assets' }),
    (e) => e.exitCode === NAVER_EXIT.IMAGE
      && /percent-escape/.test(e.message)
      && /2026-05-14-a%zzb/.test(e.message),
  );
});

test('localPathFor — --image-dir가 다른 글의 폴더를 가리키면 경고한다', () => {
  // `{date}-{hash12}`가 같은 날 올린 여러 글의 photo-01.webp를 구별하는 **유일한**
  // 수단인데 이 분기가 그것을 버렸다. 그래서 다른 글의 사진을 10/10 해석하고
  // exit 0으로 끝났고, dry-run 출력도 basename만 찍어서 맞는 글이든 틀린 글이든
  // 같은 줄이 나왔다 — 눈으로도 감지할 수 없었다.
  const seen = [];
  const warn = (m) => seen.push(m);

  const p = localPathFor('https://x/posts/2026-05-14-73bbbb7cda45/photo-01.webp',
    { assetsRoot: 'tmp/assets', imageDir: '/img/postA', warn });
  assert.equal(p, path.join('/img/postA', 'photo-01.webp'), '경로 해석 자체는 유지된다');
  assert.equal(seen.length, 1, '불일치인데 경고하지 않음');
  assert.match(seen[0], /2026-05-14-73bbbb7cda45/);
  assert.match(seen[0], /postA/);

  // 디렉터리명이 글 폴더와 같으면 경고하지 않는다
  seen.length = 0;
  localPathFor('https://x/posts/2026-05-14-73bbbb7cda45/photo-01.webp',
    { assetsRoot: 'tmp/assets', imageDir: '/img/2026-05-14-73bbbb7cda45', warn });
  assert.deepEqual(seen, [], '일치하는데 경고함');
});
