// lib/err-text.js — "예외에서 문구를 뽑다가 예외가 나면 원래 예외가 사라진다"를 막는다.
//
// 이 저장소에서 그 실패가 만든 사고: naver-dom이 NaverError(exit 12)를 만들기
// 전에 dumpFailure를 await하는데 그쪽에서 TypeError가 나면 exit 12가 exit 1이
// 됐고, naver-doctor는 세션 행에서 죽어 **셀렉터 게이트를 통째로 건너뛰었다.**

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  errCodeTag, errExitCode, errFull, errStack, errText,
} = require('../lib/err-text');

const THROWN = [
  ['Error', new Error('첫 줄\n둘째 줄'), '첫 줄', '첫 줄\n둘째 줄'],
  ['문자열 throw', '보스', '보스', '보스'],
  ['여러 줄 문자열', 'a\nb', 'a', 'a\nb'],
  ['undefined reject', undefined, '', ''],
  ['null reject', null, '', ''],
  ['숫자', 42, '42', '42'],
  ['message 없는 객체', {}, '[object Object]', '[object Object]'],
  ['message가 빈 문자열', Object.assign(new Error(''), {}), 'Error', 'Error'],
  ['message가 숫자', { message: 7 }, '[object Object]', '[object Object]'],
];

test('errText/errFull — 어떤 값이 던져져도 던지지 않는다', () => {
  for (const [label, thrown, expectedText, expectedFull] of THROWN) {
    assert.equal(errText(thrown), expectedText, `errText(${label})`);
    assert.equal(errFull(thrown), expectedFull, `errFull(${label})`);
  }
});

test('errFull — toString이 던지는 객체에서도 살아남는다', () => {
  const hostile = { get message() { throw new Error('trap'); } };
  // getter가 던지면 errFull 자체가 죽어 원래 예외를 가린다
  assert.doesNotThrow(() => errFull(hostile));
});

test('errCodeTag — 진단 코드를 삼키지 않는다', () => {
  assert.equal(errCodeTag(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), ' (EAI_AGAIN)');
  assert.equal(errCodeTag(new Error('x')), '');
  assert.equal(errCodeTag(null), '');
  assert.equal(errCodeTag('문자열'), '');
});

// **두 테스트가 같은 구현을 공유한다.** 예전에는 자기 검증 테스트가 detect()를
// 따로 정의해서, 트리 스캔 쪽을 변수명 열거로 되돌려도 자기 검증은 통과했다 —
// "스캔이 안전하다는 착각"을 만드는 구조 자체가 검출되지 않았다.

// catch 절 바인딩(`catch (e)`)과 promise 콜백 바인딩(`.catch((e) => …)`)을 모두 본다.
// 후자를 빼면 catch 절이 없는 스크립트(test-blogger-api 등)에서 스캔 히트가 0이 된다.
const BINDING_RES = [
  /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
  /\.catch\s*\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g,
  /\.catch\s*\(\s*(?:async\s+)?function\s*\w*\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
];

// 예외에서 **직접 읽으면 위험한** 프로퍼티. 라운드마다 하나씩 발견됐다:
// .message(5차) → .stack/.exitCode(7차) → .response(8차). 이름을 열거하는 것은
// 여전히 열거이지만, 대상이 "예외 객체의 진단 프로퍼티"로 닫혀 있고 헬퍼가
// 전부 제공되므로 새 이름이 생기면 여기 한 줄만 추가하면 된다.
const GUARDED_PROPS = ['message', 'stack', 'exitCode', 'response', 'code'];

// 위치를 유지하려고 같은 길이로 치환한다. **개행은 보존해야 줄 번호가 맞는다** —
// 여러 줄 블록 주석을 공백으로 뭉개면 그 뒤 모든 히트의 줄 번호가 어긋난다
// (실측: 실제 6행 위반이 2행으로 보고됐다).
const blankKeepLines = (m) => m.replace(/[^\n]/g, ' ');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepLines)
    .replace(/\/\/[^\n]*/g, blankKeepLines);
}

// 대괄호 접근(`err["message"]`)은 문자열 리터럴이 **키**라서, 문자열을 지우면
// 위반이 사라진다. 그래서 두 단계로 나눈다.
function stripStrings(code) {
  return code
    .replace(/'(?:\\.|[^'\\\n])*'/g, blankKeepLines)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blankKeepLines);
}

// catch/promise 바인딩 식별자를 추출해, **그 식별자의** 진단 프로퍼티 접근을
// 이름과 무관하게 전부 찾는다. 점 접근·옵셔널 체인·대괄호·구조분해를 포함한다.
// 판정 기준이 "내가 적어둔 변수명"이면 `catch (e)` 하나로 뚫린다 — 실제로 뚫려
// 있었다 (scripts/extract-exif.js).
//
// 주석 제거를 문자열 제거보다 먼저/나중에 각각 돌린 결과를 **합집합**으로 쓴다.
// 한 순서만 쓰면 문자열 안의 주석 마커(`const open = "/*";`)가 그 뒤 코드를
// 통째로 가려 진짜 위반이 사라진다.
function findMessageReads(src) {
  const views = [
    stripComments(src),                 // 문자열 남김 (대괄호 키를 보기 위해)
    stripStrings(stripComments(src)),   // 표준
    stripComments(stripStrings(src)),   // 순서를 뒤집은 것
  ];
  const names = new Set();
  for (const view of views) {
    for (const re of BINDING_RES) {
      for (const m of view.matchAll(new RegExp(re.source, 'g'))) names.add(m[1]);
    }
  }

  const seen = new Set();
  const hits = [];
  const push = (name, kind, prop, view, index) => {
    const line = view.slice(0, index).split('\n').length;
    const key = `${line}:${name}:${prop}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ name, kind, prop, line });
  };

  for (const name of names) {
    const n = name.replace(/[$]/g, '\\$');
    for (const prop of GUARDED_PROPS) {
      // [정규식, 종류, 문자열을 남긴 뷰에서 볼 것인가]
      const patterns = [
        [`${n}\\s*\\.\\s*${prop}\\b`, `.${prop}`, false],
        [`${n}\\s*\\?\\.\\s*${prop}\\b`, `?.${prop}`, false],
        [`${n}\\s*\\[\\s*['"\`]${prop}`, `['${prop}']`, true],
        [`\\{[^}\\n]*\\b${prop}\\b[^}\\n]*\\}\\s*=\\s*${n}\\b`, `구조분해(${prop})`, false],
      ];
      for (const [pat, kind, keepStrings] of patterns) {
        // 대괄호 접근은 문자열을 남긴 뷰에서만 보이고, 나머지는 어느 뷰에서든
        // 보일 수 있다 (주석/문자열 제거 순서에 따라 가려지는 코드가 다르다).
        const searchIn = keepStrings ? [views[0]] : [views[1], views[2]];
        for (const view of searchIn) {
          for (const m of view.matchAll(new RegExp(pat, 'g'))) {
            const after = view.slice(m.index + m[0].length);
            // 대입(감싸기)은 읽기가 아니다: `err.message = ...`
            if (!keepStrings && /^\s*=[^=]/.test(after)) continue;
            if (keepStrings && /^['"`]\s*\]\s*=[^=]/.test(after)) continue;
            // `err && err.response` 처럼 같은 표현 안에서 null을 이미 걸렀으면 안전하다.
            const before = view.slice(Math.max(0, m.index - 60), m.index);
            if (new RegExp(`${n}\\s*&&[^;{}]*$`).test(before)) continue;
            push(name, kind, prop, view, m.index);
          }
        }
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

test('예외의 진단 프로퍼티를 직접 읽는 코드가 새로 늘지 않는다 (구조적 강제)', () => {
  // 라운드 1~7에서 같은 결함이 반복된 이유는 "이 접근에도 가드를 넣는다"를
  // 매번 손으로 했기 때문이다. 그래서 스캔을 넣었는데 **그 스캔도 열거**였다 —
  // 5차는 `.message`만, 7차는 변수명이 `err*`인 것만 봤다. 실제로 놓친 것:
  //   `catch (e) { e.message }`            (7차까지 트리에 살아 있었다)
  //   `if (err.response?.data)`             (errStack을 넣은 핸들러의 다음 줄)
  //   `.catch((err) => err.message)`        (catch 절이 아니다)
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of ['lib', 'scripts']) {
    for (const f of fs.readdirSync(path.join(root, rel)).filter((n) => n.endsWith('.js'))) {
      const p = `${rel}/${f}`;
      if (p === 'lib/err-text.js') continue;     // 이 모듈이 유일한 예외다
      const src = fs.readFileSync(path.join(root, p), 'utf8');
      for (const hit of findMessageReads(src)) {
        offenders.push(`${p}:${hit.line}: ${hit.name}의 ${hit.kind}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'catch한 값의 진단 프로퍼티를 직접 읽는 곳이 있습니다. lib/err-text.js의 '
    + `errText/errFull/errStack/errExitCode/errStatus/errCode/errResponseData를 쓰세요:\n${offenders.join('\n')}`);
});

test('스캔이 실제로 위반을 잡는지 (스캔의 자기 검증)', () => {
  // 스캔이 통과한다는 것만으로는 강제력을 증명하지 못한다 — 예전 스캔은
  // `catch (e)`를 못 잡으면서 초록이었다. **위 테스트와 같은 함수**에 위반
  // 샘플을 넣어, 스캔을 약화시키면 여기가 깨지게 한다.
  const BAD = [
    'try { x(); } catch (e) { log(`${e.message}`); }',
    'try { x(); } catch (ex) { log(ex.message); }',
    'try { x(); } catch (caught) { log(caught?.message); }',
    'try { x(); } catch (reason) { log(reason["message"]); }',
    'try { x(); } catch (failure) { const { message } = failure; log(message); }',
    'try { x(); } catch (e2) { log(e2 . message); }',
    'try { x(); } catch (err) { log(err.message); }',
    'try { x(); } catch (ERROR) { log(`x ${ERROR.message}`); }',
    // 7차가 놓친 것들
    'try { x(); } catch (e) { if (e.stack) log(e.stack); }',
    'try { x(); } catch (e) { exit(e.exitCode || 1); }',
    'try { x(); } catch (e) { if (e.response?.data) log(e.response.data); }',
    'try { x(); } catch (e) { if (e.code === "ENOENT") return null; }',
    // catch 절이 아닌 바인딩
    'p.catch((err) => log(err.message));',
    'p.catch((e) => { log(e.stack); });',
    'p.catch(async (e) => log(e.message));',
    'p.catch(function (e) { log(e.message); });',
    // 문자열 안의 주석 마커가 뒤를 가리지 않는다
    'const open = "/*"; try { x(); } catch (e) { log(e.message); } const close = "*/";',
  ];
  for (const bad of BAD) {
    assert.ok(findMessageReads(bad).length > 0, `놓침: ${bad}`);
  }

  const GOOD = [
    'try { x(); } catch (err) { log(errFull(err)); }',
    'try { x(); } catch (e) { log(errText(e)); }',
    'const res = { message: "ok" }; log(res.message);',
    'try { x(); } catch (err) { err.message = `wrapped: ${errFull(err)}`; throw err; }',
    'try { x(); } catch (err) { err.exitCode = 7; throw err; }',
    '// catch (e) { e.message }  ← 주석은 설명이다',
    'try { x(); } catch (err) { if (err && err.response) keep(err.response); }',
    'p.catch((err) => process.exit(reportFatal(err, "x:")));',
  ];
  for (const good of GOOD) {
    assert.deepEqual(findMessageReads(good), [], `오탐: ${good}`);
  }
});

test('스캔이 줄 번호를 정확히 보고한다', () => {
  // blank()가 여러 줄 블록 주석의 개행을 없애서, 그 뒤 모든 히트의 줄 번호가
  // 어긋났다 (실측: 실제 6행 위반이 2행으로 보고). 개발자를 엉뚱한 줄로 보낸다.
  const src = [
    '/* 한 줄',           // 1
    '   두 줄',           // 2
    '   세 줄 */',        // 3
    'function f() {',    // 4
    '  try { x(); }',    // 5
    '  catch (e) { log(e.message); }', // 6
    '}',                 // 7
  ].join('\n');
  const hits = findMessageReads(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 6, `줄 번호가 ${hits[0].line}로 보고됨`);
});

test('errStack / errExitCode — 최상위 핸들러가 non-Error에서도 exit 코드를 지킨다', () => {
  // `if (err.stack)`·`err.exitCode || 1`을 무가드로 쓰면 Promise.reject(null)에서
  // **핸들러 자체가 죽어** 의도한 exit 코드 대신 unhandled rejection이 된다.
  for (const thrown of [null, undefined, '문자열', 42, {}, []]) {
    assert.equal(errExitCode(thrown), 1, JSON.stringify(thrown));
    assert.equal(errStack(thrown), '');
  }
  assert.equal(errExitCode({ exitCode: 7 }), 7);
  assert.equal(errExitCode({ exitCode: 9 }, 1), 9);
  // 범위 밖·비정수는 fallback (process.exit이 받을 수 없는 값)
  for (const bad of [{ exitCode: -1 }, { exitCode: 256 }, { exitCode: 1.5 }, { exitCode: '7' }]) {
    assert.equal(errExitCode(bad), 1, JSON.stringify(bad));
  }
  assert.equal(errExitCode({ exitCode: 5 }, 9), 5);
  assert.ok(errStack(new Error('x')).includes('Error'));

  // 접근이 던지는 객체에서도 살아남는다
  const hostile = {
    get stack() { throw new Error('t'); },
    get exitCode() { throw new Error('t'); },
    get code() { throw new Error('t'); },
  };
  assert.equal(errStack(hostile), '');
  assert.equal(errExitCode(hostile, 4), 4);
  assert.equal(errCodeTag(hostile), '');
});
