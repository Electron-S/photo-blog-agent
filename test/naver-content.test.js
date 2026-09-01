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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const postDir = path.join(dir, '2026-05-10-abc123def456');
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, 'photo-01.webp'), 'x', 'utf8');

  const { blocks } = htmlToBlocks(`${FIG(1)}<p>문장.</p>`);
  resolveImagePaths(blocks, { assetsRoot: dir });
  assert.equal(blocks[0].localPath, path.resolve(postDir, 'photo-01.webp'));
});

test('resolveImagePaths — 파일이 없으면 exit 16, URL로 폴백하지 않는다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-nv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
  });
});
