// 초안 HTML 토크나이저 + 얕은 트리 빌더 — 외부 의존성 0.
//
// 왜 직접 쓰는가: 관대한 파서(node-html-parser 등)는 미닫힘 <figure>를 조용히
// 복구한다. 그러면 "구조가 깨진 초안"이 lint를 통과해 Blogger에 올라간다 —
// 이 프로젝트가 가장 싫어하는 silent failure다. 여기서는 미닫힘·고아 닫는 태그를
// errors[]로 표면화해서 발행을 막는다.
//
// 입력 도메인은 임의의 웹 HTML이 아니라 prompts/blog-draft.md가 생성하는
// flat block 시퀀스(p/h3/figure/img/figcaption/a/strong/br/ul)뿐이다.

// <br>이 만든 줄바꿈 전용 센티널. 그냥 '\n'을 쓰면 **HTML 소스의 줄바꿈**과
// 구별되지 않는다. 텍스트 노드의 값을 그대로 누적하므로, 초안이 소스에서
// 여러 줄로 접혀 있기만 해도 문장 수가 부풀려져 text-after-figure(error)가
// 조용히 통과한다 — AdSense 이미지/광고 분리 규칙이 무력화된다.
// NUL은 실제 초안 텍스트에 나타나지 않는다.
const BR_SENTINEL = '\u0000';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// 이 안의 내용은 마크업으로 파싱하지 않는다.
const RAW_TEXT_TAGS = new Set(['script', 'style']);

function makeElement(tag, attrs, start) {
  return { type: 'element', tag, attrs, children: [], parent: null, start, end: null };
}

function appendChild(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

// 태그 안의 속성을 읽는다. 따옴표 안의 '>'와 '/'를 태그 종료로 오인하지 않는 것이 핵심.
// 반환: { attrs, selfClosing, next } — next는 '>' 다음 위치.
function readAttributes(html, i) {
  const attrs = Object.create(null);
  let selfClosing = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) break;

    if (html[i] === '>') { i += 1; break; }
    if (html[i] === '/' && html[i + 1] === '>') { selfClosing = true; i += 2; break; }
    if (html[i] === '/') { i += 1; continue; }

    const nameStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i += 1;
    if (i === nameStart) { i += 1; continue; }
    const name = html.slice(nameStart, i).toLowerCase();

    while (i < html.length && /\s/.test(html[i])) i += 1;

    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const q = html[i];
      if (q === '"' || q === "'") {
        i += 1;
        const vs = i;
        while (i < html.length && html[i] !== q) i += 1;
        value = html.slice(vs, i);
        i += 1; // 닫는 따옴표
      } else {
        const vs = i;
        while (i < html.length && !/[\s>]/.test(html[i])) i += 1;
        value = html.slice(vs, i);
      }
    } else {
      // 값 없는 속성 (예: <img loading>) — 빈 문자열로 둔다.
      value = '';
    }

    if (!(name in attrs)) attrs[name] = value;
  }

  return { attrs, selfClosing, next: i };
}

function parseHtml(html) {
  const errors = [];
  const src = String(html == null ? '' : html)
    .replace(/^﻿/, '')   // BOM
    .replace(/\r\n/g, '\n')   // Windows 개행
    .replace(/\r/g, '\n');

  const root = makeElement('#root', Object.create(null), 0);
  const stack = [root];
  const top = () => stack[stack.length - 1];

  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) {
      appendChild(top(), { type: 'text', value: src.slice(textStart, end), start: textStart, end });
    }
  };

  while (i < src.length) {
    if (src[i] !== '<') { i += 1; continue; }

    // 주석
    if (src.startsWith('<!--', i)) {
      flushText(i);
      const close = src.indexOf('-->', i + 4);
      if (close === -1) {
        errors.push({ code: 'unterminated-comment', tag: null, offset: i, message: '닫히지 않은 주석 (<!--)' });
        i = src.length;
      } else {
        i = close + 3;
      }
      textStart = i;
      continue;
    }

    // <!DOCTYPE ...> 등 선언
    if (src.startsWith('<!', i)) {
      flushText(i);
      const close = src.indexOf('>', i);
      i = close === -1 ? src.length : close + 1;
      textStart = i;
      continue;
    }

    // 닫는 태그
    if (src.startsWith('</', i)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(src.slice(i));
      if (!m) { i += 1; continue; }
      flushText(i);
      const tag = m[1].toLowerCase();

      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx <= 0) {
        // 스택에 없는 태그를 닫으려 함 — 짝 없는 닫는 태그.
        errors.push({ code: 'orphan-closing-tag', tag, offset: i, message: `짝이 없는 닫는 태그 </${tag}>` });
      } else {
        // 사이에 열려 있던 태그들은 닫히지 않은 것이다.
        for (let k = stack.length - 1; k > idx; k--) {
          errors.push({
            code: 'unclosed-tag', tag: stack[k].tag, offset: stack[k].start,
            message: `<${stack[k].tag}>가 </${tag}> 전에 닫히지 않았습니다`,
          });
        }
        for (let k = stack.length - 1; k >= idx; k--) {
          stack[k].end = i + m[0].length;
          stack.pop();
        }
      }
      i += m[0].length;
      textStart = i;
      continue;
    }

    // 여는 태그
    const om = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i));
    if (!om) { i += 1; continue; }
    flushText(i);

    const tag = om[1].toLowerCase();
    const { attrs, selfClosing, next } = readAttributes(src, i + om[0].length);
    const el = makeElement(tag, attrs, i);
    appendChild(top(), el);

    if (VOID_TAGS.has(tag) || selfClosing) {
      el.end = next;
      i = next;
    } else if (RAW_TEXT_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = src.slice(next);
      const cm = closeRe.exec(rest);
      if (cm) {
        appendChild(el, { type: 'text', value: rest.slice(0, cm.index), start: next, end: next + cm.index });
        el.end = next + cm.index + cm[0].length;
        i = el.end;
      } else {
        errors.push({ code: 'unclosed-tag', tag, offset: i, message: `<${tag}>가 닫히지 않았습니다` });
        appendChild(el, { type: 'text', value: rest, start: next, end: src.length });
        el.end = src.length;
        i = src.length;
      }
    } else {
      stack.push(el);
      i = next;
    }
    textStart = i;
  }

  flushText(src.length);

  for (let k = stack.length - 1; k > 0; k--) {
    errors.push({
      code: 'unclosed-tag', tag: stack[k].tag, offset: stack[k].start,
      message: `<${stack[k].tag}>가 닫히지 않았습니다`,
    });
    stack[k].end = src.length;
  }

  return { root, errors, source: src };
}

function walk(node, visit) {
  visit(node);
  if (node.children) {
    for (const c of node.children) walk(c, visit);
  }
}

function findAll(node, tagName) {
  const tag = tagName.toLowerCase();
  const out = [];
  walk(node, (n) => {
    if (n !== node && n.type === 'element' && n.tag === tag) out.push(n);
  });
  return out;
}

// 하위 텍스트 노드를 이어붙인다 (엔티티 디코드는 하지 않음 — 호출자 책임).
// skipTags에 든 태그의 서브트리는 건너뛴다 (예: 본문 글자수에서 figcaption 제외).
function textOf(node, skipTags = []) {
  const skip = new Set(skipTags.map((t) => t.toLowerCase()));
  let out = '';
  const rec = (n) => {
    if (n.type === 'text') { out += n.value; return; }
    if (n.type === 'element') {
      if (n !== node && skip.has(n.tag)) return;
      // <br>만 문장 경계다 (korean-text의 splitSentences가 이 센티널로 나눈다).
      if (n.tag === 'br') { out += BR_SENTINEL; return; }
      for (const c of n.children) rec(c);
    }
  };
  rec(node);
  return out;
}

function getAttr(node, name) {
  if (!node || node.type !== 'element') return undefined;
  return node.attrs[name.toLowerCase()];
}

function hasAttr(node, name) {
  return getAttr(node, name) !== undefined;
}

// 요소 형제만 (텍스트 노드 무시). "figure 직후 형제가 h3인가" 판정에 쓴다.
function elementChildren(node) {
  return node.children.filter((c) => c.type === 'element');
}

function nextElementSibling(node) {
  const p = node.parent;
  if (!p) return null;
  const sibs = p.children;
  for (let i = sibs.indexOf(node) + 1; i < sibs.length; i++) {
    if (sibs[i].type === 'element') return sibs[i];
    // 사이의 공백만 있는 텍스트는 무시하고, 실제 내용이 있으면 형제 아님.
    if (sibs[i].type === 'text' && sibs[i].value.trim() !== '') return null;
  }
  return null;
}

function ancestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

// 문자 오프셋 → 1-기반 줄 번호 (에러 메시지용).
function lineOf(source, offset) {
  if (typeof offset !== 'number' || offset < 0) return null;
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

module.exports = {
  BR_SENTINEL,
  VOID_TAGS,
  ancestors,
  elementChildren,
  findAll,
  getAttr,
  hasAttr,
  lineOf,
  nextElementSibling,
  parseHtml,
  textOf,
  walk,
};
