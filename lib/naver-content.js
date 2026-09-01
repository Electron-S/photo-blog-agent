// 초안 HTML → 네이버 에디터 블록 배열.
//
// 예전 구현은 `--blocks` 수동 JSON을 받았고, 없으면 HTML 전문을 문단 텍스트로
// 타이핑했다. `<figure style=...>` 태그가 본문에 그대로 찍히는 구조였다.
//
// Phase 3의 lib/html-parse.js를 재사용한다. 새 의존성을 넣지 않고, 관대한
// 파서가 조용히 복구하는 문제도 피한다. 그 위에 **화이트리스트 + throw**를
// 얹어 허용 밖 요소를 조용히 버리지 않는다.

const fs = require('fs');
const path = require('path');
const { parseHtml, findAll, getAttr, textOf, elementChildren } = require('./html-parse');
const { decodeEntities, normalizeWhitespace } = require('./korean-text');
const { NAVER_EXIT, NaverError } = require('./naver-errors');

// prompts/blog-draft.md가 생성하는 요소만 허용한다.
const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'figure', 'ul', 'ol']);
// 순수 컨테이너. 자기 자신은 블록이 아니고 자식을 블록으로 펼친다.
const CONTAINER_TAGS = new Set(['div', 'section', 'article']);
const INLINE_TAGS = new Set(['a', 'strong', 'b', 'em', 'i', 'br', 'span', 'code', 'u']);
const LIST_ITEM_TAGS = new Set(['li']);

function inlineTextOf(node, links) {
  let out = '';
  const rec = (n) => {
    if (n.type === 'text') { out += n.value; return; }
    if (n.type !== 'element') return;
    // 루트는 블록 태그(p/h3/li)라 인라인 화이트리스트 검사 대상이 아니다.
    if (n === node) { for (const c of n.children) rec(c); return; }
    if (n.tag === 'br') { out += '\n'; return; }
    if (n.tag === 'a') {
      const href = getAttr(n, 'href');
      const label = normalizeWhitespace(textOf(n));
      // 네이버 에디터의 링크 삽입은 별도 UI다. v1에서는 평문화하되,
      // 무엇이 평문화됐는지 반드시 호출자에게 보고한다 (조용히 버리지 않는다).
      if (href) {
        links.push({ text: label, href });
        out += `${label} (${href})`;
      } else {
        out += label;
      }
      return;
    }
    if (!INLINE_TAGS.has(n.tag)) {
      throw new NaverError(
        NAVER_EXIT.GENERAL,
        `블록 안에 허용되지 않은 요소가 있습니다: <${n.tag}>. `
        + `허용: ${[...INLINE_TAGS].join(', ')}`,
      );
    }
    for (const c of n.children) rec(c);
  };
  rec(node);
  // NBSP(\u00a0)를 일반 공백으로 바꾼 뒤에 접어야 이중 공백이 남지 않는다.
  return decodeEntities(out)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * @param {string} html 초안 HTML
 * @returns {{blocks: Array, links: Array<{text:string, href:string}>}}
 */
function htmlToBlocks(html) {
  const { root, errors } = parseHtml(html);
  if (errors.length) {
    throw new NaverError(
      NAVER_EXIT.GENERAL,
      `초안 HTML 구조 오류로 블록 변환을 중단합니다:\n  + ${errors.map((e) => e.message).join('\n  + ')}`,
      { errors },
    );
  }

  const blocks = [];
  const links = [];

  const walkBlocks = (children) => {
    for (const node of children) {
      if (node.type === 'text') {
        const t = normalizeWhitespace(node.value);
        if (t) blocks.push({ type: 'paragraph', text: decodeEntities(t) });
        continue;
      }
      if (node.type !== 'element') continue;

      if (CONTAINER_TAGS.has(node.tag)) {
        walkBlocks(node.children);
        continue;
      }

      if (!BLOCK_TAGS.has(node.tag)) {
        throw new NaverError(
          NAVER_EXIT.GENERAL,
          `허용되지 않은 블록 요소가 있습니다: <${node.tag}>. `
          + `허용: ${[...BLOCK_TAGS, ...CONTAINER_TAGS].join(', ')}. 조용히 버리지 않고 중단합니다.`,
        );
      }

      if (node.tag === 'figure') {
        const imgs = findAll(node, 'img');
        const caps = elementChildren(node).filter((c) => c.tag === 'figcaption');
        if (imgs.length !== 1) {
          throw new NaverError(
            NAVER_EXIT.GENERAL,
            `<figure> 안에 <img>가 ${imgs.length}개입니다 (1개여야 합니다).`,
          );
        }
        const src = getAttr(imgs[0], 'src');
        if (!src) {
          throw new NaverError(NAVER_EXIT.GENERAL, '<figure>의 <img>에 src가 없습니다.');
        }
        blocks.push({
          type: 'image',
          src,
          alt: getAttr(imgs[0], 'alt') || '',
          caption: caps.length ? normalizeWhitespace(textOf(caps[0])) : '',
          localPath: null,
        });
        continue;
      }

      if (node.tag === 'ul' || node.tag === 'ol') {
        const items = elementChildren(node).filter((c) => LIST_ITEM_TAGS.has(c.tag));
        for (const li of items) {
          const t = inlineTextOf(li, links);
          // 네이버 에디터의 목록 서식은 별도 UI다. v1에서는 불릿 문자로 평문화한다.
          if (t) blocks.push({ type: 'paragraph', text: `- ${t}` });
        }
        continue;
      }

      const text = inlineTextOf(node, links);
      if (!text) continue;
      if (node.tag === 'h2' || node.tag === 'h3') {
        blocks.push({ type: 'heading', level: node.tag === 'h2' ? 2 : 3, text });
      } else {
        blocks.push({ type: 'paragraph', text });
      }
    }
  };

  walkBlocks(root.children);
  return { blocks, links };
}

function basenameOf(src) {
  return String(src || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
}

// GitHub Pages URL → 로컬 압축본 경로.
// 규약: .../posts/{date}-{hash12}/photo-NN.webp → {assetsRoot}/{date}-{hash12}/photo-NN.webp
function localPathFor(src, { assetsRoot, imageDir }) {
  const clean = String(src || '').split(/[?#]/)[0];
  if (imageDir) return path.join(imageDir, basenameOf(clean));

  const m = /\/posts\/([^/]+)\/([^/]+)$/.exec(clean);
  if (m) return path.join(assetsRoot, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

  // 이미 로컬 경로인 경우
  if (!/^https?:/i.test(clean)) return clean;
  return null;
}

/**
 * 이미지 블록의 src를 로컬 webp 경로로 해석한다.
 *
 * 파일이 하나라도 없으면 exit 16으로 중단하고 **절대 URL로 폴백하지 않는다** —
 * 폴백하면 네이버가 외부 이미지를 링크로 박아 핫링킹/깨짐 사고가 난다.
 */
function resolveImagePaths(blocks, { assetsRoot = path.join('tmp', 'assets'), imageDir = null } = {}) {
  const missing = [];
  for (const b of blocks) {
    if (b.type !== 'image') continue;
    const p = localPathFor(b.src, { assetsRoot, imageDir });
    if (!p || !fs.existsSync(p)) {
      missing.push({ src: b.src, tried: p });
      continue;
    }
    b.localPath = path.resolve(p);
  }

  if (missing.length) {
    throw new NaverError(
      NAVER_EXIT.IMAGE,
      `로컬 이미지 파일을 찾지 못했습니다 (${missing.length}건). 네이버는 외부 URL이 아니라 `
      + '로컬 파일을 에디터에 직접 올립니다 — URL로 폴백하면 핫링킹/깨짐 사고가 납니다.\n'
      + missing.map((m) => `  + ${m.src}\n    → 찾은 경로: ${m.tried || '(해석 실패)'}`).join('\n')
      + '\n  + upload-images.js를 --local-only 또는 --output과 함께 다시 실행했는지 확인하세요.\n'
      + '  + 또는 --image-dir로 압축본 디렉터리를 직접 지정하세요.',
      { missing },
    );
  }
  return blocks;
}

function summarizeBlocks(blocks) {
  const chars = blocks
    .filter((b) => b.type !== 'image')
    .reduce((n, b) => n + [...b.text].length, 0);
  return {
    total: blocks.length,
    headings: blocks.filter((b) => b.type === 'heading').length,
    paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
    images: blocks.filter((b) => b.type === 'image').length,
    chars,
  };
}

module.exports = {
  BLOCK_TAGS,
  CONTAINER_TAGS,
  INLINE_TAGS,
  htmlToBlocks,
  localPathFor,
  resolveImagePaths,
  summarizeBlocks,
};
