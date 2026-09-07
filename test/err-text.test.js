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
const CATCH_RE = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

// 주석과 **따옴표** 문자열만 지운다 (설명문의 `err.message`를 위반으로 세지 않도록).
// 위치를 유지하려고 같은 길이의 공백으로 치환한다.
//
// 템플릿 리터럴은 지우지 않는다. `${err.message}`의 안쪽은 문자열이 아니라
// **코드**이고, 실제 위반이 거의 전부 거기 있다. 템플릿을 통째로 지웠더니
// 일부러 심은 위반(`${ex.message}`)조차 잡히지 않았다.
const blank = (m) => ' '.repeat(m.length);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

// 대괄호 접근(`err["message"]`)은 문자열 리터럴이 **키**라서, 문자열을 지우면
// 위반이 사라진다. 그래서 두 단계로 나눈다.
function stripStrings(code) {
  return code
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank);
}

// catch 절의 바인딩 식별자를 추출해, **그 식별자의** message 접근을 이름과
// 무관하게 전부 찾는다. 점 접근·옵셔널 체인·대괄호·구조분해를 모두 포함한다.
// 판정 기준이 "내가 적어둔 변수명"이면 `catch (e)` 하나로 뚫린다 — 실제로 뚫려
// 있었다 (scripts/extract-exif.js).
function findMessageReads(src) {
  const withStrings = stripComments(src);
  const code = stripStrings(withStrings);
  const names = new Set();
  for (const m of code.matchAll(CATCH_RE)) names.add(m[1]);

  const hits = [];
  for (const name of names) {
    const n = name.replace(/[$]/g, '\\$');
    // [정규식, 종류, 문자열을 남긴 소스에서 볼 것인가]
    const patterns = [
      [`${n}\\s*\\.\\s*message`, '.message', false],
      [`${n}\\s*\\?\\.\\s*message`, '?.message', false],
      [`${n}\\s*\\[\\s*['"\`]message`, "['message']", true],
      [`\\{[^}\\n]*\\bmessage\\b[^}\\n]*\\}\\s*=\\s*${n}\\b`, '구조분해', false],
    ];
    for (const [pat, kind, keepStrings] of patterns) {
      const haystack = keepStrings ? withStrings : code;
      for (const m of haystack.matchAll(new RegExp(pat, 'g'))) {
        // 대입(감싸기)은 읽기가 아니다: `err.message = ...`
        const after = haystack.slice(m.index + m[0].length);
        if (!keepStrings && /^\s*=[^=]/.test(after)) continue;
        if (keepStrings && /^['"`]\s*\]\s*=[^=]/.test(after)) continue;
        hits.push({ name, kind, line: haystack.slice(0, m.index).split('\n').length });
      }
    }
  }
  return hits;
}

test('err.message를 직접 만지는 코드가 새로 늘지 않는다 (구조적 강제)', () => {
  // 라운드 1~6에서 같은 결함이 반복된 이유는 "이 catch에도 가드를 넣는다"를
  // 매번 손으로 했기 때문이다. 그래서 스캔을 넣었는데 **그 스캔도 변수명 열거**
  // 였다. `catch (e)`가 통과했고, 실제로 scripts/extract-exif.js의 `catch (e)`
  // 안에서 `e.message`를 무가드로 읽는 코드가 205건 통과 상태로 트리에 있었다.
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of ['lib', 'scripts']) {
    for (const f of fs.readdirSync(path.join(root, rel)).filter((n) => n.endsWith('.js'))) {
      const p = `${rel}/${f}`;
      if (p === 'lib/err-text.js') continue;     // 이 모듈이 유일한 예외다
      const src = fs.readFileSync(path.join(root, p), 'utf8');
      for (const hit of findMessageReads(src)) {
        offenders.push(`${p}:${hit.line}: catch(${hit.name})의 ${hit.kind}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `catch한 값의 message를 직접 읽는 곳이 있습니다. lib/err-text.js의 errText/errFull을 쓰세요:\n${offenders.join('\n')}`);
});

test('스캔이 실제로 위반을 잡는지 (스캔의 자기 검증)', () => {
  // 스캔이 통과한다는 것만으로는 강제력을 증명하지 못한다 — 예전 스캔은
  // `catch (e)`를 못 잡으면서 초록이었다. **위 테스트와 같은 함수**에 위반
  // 샘플을 넣어, 스캔을 약화시키면 여기가 깨지게 한다.
  for (const bad of [
    'try { x(); } catch (e) { log(`${e.message}`); }',
    'try { x(); } catch (ex) { log(ex.message); }',
    'try { x(); } catch (caught) { log(caught?.message); }',
    'try { x(); } catch (reason) { log(reason["message"]); }',
    'try { x(); } catch (failure) { const { message } = failure; log(message); }',
    'try { x(); } catch (e2) { log(e2 . message); }',
    'try { x(); } catch (err) { log(err.message); }',
    'try { x(); } catch (ERROR) { log(`x ${ERROR.message}`); }',
  ]) {
    assert.ok(findMessageReads(bad).length > 0, `놓침: ${bad}`);
  }
  for (const good of [
    'try { x(); } catch (err) { log(errFull(err)); }',
    'try { x(); } catch (e) { log(errText(e)); }',
    'const res = { message: "ok" }; log(res.message);',
    'try { x(); } catch (err) { err.message = `wrapped: ${errFull(err)}`; throw err; }',
    '// catch (e) { e.message }  ← 주석은 설명이다',
  ]) {
    assert.deepEqual(findMessageReads(good), [], `오탐: ${good}`);
  }
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
