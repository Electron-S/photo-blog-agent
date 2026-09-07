// 세션 진행 상태 — 외부 의존성 0 (fs/path 제외).
//
// 지금까지는 모델이 Write 도구로 이 JSON을 직접 썼다. 문제는 모델이
// steps_completed와 steps_remaining **두 배열을 손으로 동기화**해야 했다는 것이다.
// 하나만 틀려도 재개가 조용히 깨지고, 그 사실은 다음 세션에서야 드러난다.
//
// 여기서는 불변식을 코드가 강제한다: 두 배열은 언제나 STEPS의 완전한 분할이며,
// 호출자는 "완료된 단계"만 알려준다. steps_remaining은 항상 재계산된다.

const fs = require('fs');
const path = require('path');
const { errCode, errFull } = require('./err-text');
const { SLUG_RE } = require('./slug');

const SCHEMA_VERSION = 1;

// 워크플로우의 정본 단계 목록. .claude/commands/blog.md의 Step 순서와 대응한다.
const STEPS = ['exif', 'photo_analysis', 'upload', 'research', 'draft', 'publish'];

const EXIT_STATE_ERROR = 9;

class SessionStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionStateError';
    this.exitCode = EXIT_STATE_ERROR;
  }
}

// KST(+09:00) ISO 8601. 외부 tz 라이브러리 없이 UTC로 9시간 민 벽시계 값을
// 그대로 표기하고 +09:00 라벨을 붙인다 (extract-exif.js의 EXIF 시각 처리와 같은 발상).
// date를 주입할 수 있어 테스트에서 고정 시각으로 검증한다.
function nowKst(date = new Date()) {
  return `${new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19)}+09:00`;
}

// 파일 경로가 tmp/session-state-<slug>.json 이므로 slug를 그대로 쓰면
// `../../etc/x` 같은 값이 임의 경로 쓰기가 된다.
//
// **규칙은 lib/slug.js의 SLUG_RE 하나뿐이다.** 예전에는 여기가 더 엄격해서
// `--slug MyPost`가 publish-post를 통과해 Blogger URL이 영구 고정된 **뒤에**
// 여기서 exit 9가 났다 — 되돌릴 수 없는 작업 다음에 세션이 깨지는 순서다.
//
// 남은 차이 한 가지: `0000-00-00`은 publish-post가 거부하고(달력 날짜 검증) 여기는
// 통과시킨다. 방향이 안전한 쪽이다 — 되돌릴 수 없는 쪽이 더 엄격하다.
function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new SessionStateError(
      `slug는 소문자 영문/숫자/하이픈만 가능하며 하이픈으로 시작할 수 없습니다. (받음: ${JSON.stringify(slug)})`,
    );
  }
  return slug;
}

function statePath(slug, dir = 'tmp') {
  return path.join(dir, `session-state-${assertSlug(slug)}.json`);
}

function remainingFrom(completed) {
  const done = new Set(completed);
  return STEPS.filter((s) => !done.has(s));
}

function defaultState(slug, fields = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    slug: assertSlug(slug),
    primary_date: fields.primary_date ?? null,
    steps_completed: [],
    steps_remaining: [...STEPS],
    metadata_path: fields.metadata_path ?? null,
    analysis_path: fields.analysis_path ?? null,
    upload_result_path: fields.upload_result_path ?? null,
    draft_path: fields.draft_path ?? null,
    post_id: fields.post_id ?? null,
    post_url: fields.post_url ?? null,
    last_updated: null,
  };
}

/**
 * 디스크에서 읽은 객체를 정규화한다. read는 관대하게, update는 엄격하게 —
 * 깨진 상태여도 재개는 가능해야 하지만, 더 깨진 상태로 저장하지는 않는다.
 * @param {object} raw
 * @param {{slug: string, strict?: boolean}} opts
 */
function normalizeState(raw, { slug, strict = false }) {
  const warnings = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SessionStateError('session-state JSON의 최상위 타입이 객체가 아닙니다.');
  }
  if (typeof raw.slug !== 'string' || !raw.slug) {
    throw new SessionStateError('session-state에 slug가 없습니다.');
  }
  if (raw.slug !== slug) {
    throw new SessionStateError(
      `파일 안의 slug("${raw.slug}")가 파일명의 slug("${slug}")와 다릅니다. 파일이 뒤섞였을 수 있습니다.`,
    );
  }

  // 알 수 없는 최상위 키는 보존한다 (다른 세션/버전이 넣은 데이터를 잃지 않는다).
  const state = { ...raw };

  // schema_version은 **값까지** 본다. undefined만 검사하면 2·99·null·"1"·{}가
  // 경고 없이 통과하고 그대로 재기록된다 — v1 코드가 v2 파일에 v1 의미를 적용해
  // 덮어쓰면서 파일은 계속 schema_version: 2를 주장하게 된다. null은
  // `!== undefined`라 영구 고착됐다.
  if (state.schema_version === undefined) {
    warnings.push('schema_version이 없어 1로 간주합니다 (다음 저장 시 추가됩니다).');
    state.schema_version = SCHEMA_VERSION;
  } else if (state.schema_version !== SCHEMA_VERSION) {
    const got = JSON.stringify(state.schema_version);
    if (Number.isInteger(state.schema_version) && state.schema_version > SCHEMA_VERSION) {
      // 미래 버전 파일에 옛 의미를 적용해 덮어쓰면 데이터가 조용히 손상된다.
      throw new SessionStateError(
        `session-state의 schema_version이 ${got}인데 이 코드는 ${SCHEMA_VERSION}만 이해합니다. `
        + '더 새 버전이 만든 파일을 옛 의미로 덮어쓰지 않도록 중단합니다 — 코드를 갱신하세요.',
      );
    }
    const msg = `schema_version이 ${got}입니다 (기대: ${SCHEMA_VERSION}).`;
    if (strict) throw new SessionStateError(`${msg} 손상된 값을 덮어쓰지 않고 중단합니다.`);
    warnings.push(`${msg} ${SCHEMA_VERSION}로 간주합니다.`);
    state.schema_version = SCHEMA_VERSION;
  }

  const rawCompleted = Array.isArray(raw.steps_completed) ? raw.steps_completed : [];
  if (!Array.isArray(raw.steps_completed)) {
    const msg = `steps_completed가 배열이 아닙니다 (받음: ${JSON.stringify(raw.steps_completed)}).`;
    // strict(=쓰기 경로)에서 이걸 []로 강등하면 진행 상태 전량이 조용히 사라진다.
    if (strict) throw new SessionStateError(`${msg} 빈 배열로 강등하지 않고 중단합니다.`);
    warnings.push(`${msg} 빈 배열로 간주합니다.`);
  }

  const known = rawCompleted.filter((s) => STEPS.includes(s));
  const unknown = rawCompleted.filter((s) => !STEPS.includes(s));
  if (unknown.length) {
    const msg = `알 수 없는 단계 이름: ${unknown.join(', ')} (사용 가능: ${STEPS.join(', ')})`;
    if (strict) throw new SessionStateError(msg);
    warnings.push(`${msg} — unknown_steps로 격리합니다.`);
    state.unknown_steps = [...new Set([...(state.unknown_steps || []), ...unknown])];
  }

  // STEPS 순서로 정렬 + 중복 제거. 두 배열은 항상 완전한 분할이다.
  state.steps_completed = STEPS.filter((s) => known.includes(s));
  const expectedRemaining = remainingFrom(state.steps_completed);
  const prevRemaining = Array.isArray(raw.steps_remaining) ? raw.steps_remaining : null;
  // 심각도가 역전돼 있었다: **비배열**(가장 심하게 깨진 상태)은 경고 0건이고
  // 틀린 배열만 경고 1건이었다. 손으로 고칠 때 가장 깨지기 쉬운 곳이다.
  if (raw.steps_remaining !== undefined && prevRemaining === null) {
    warnings.push(`steps_remaining이 배열이 아닙니다 (받음: ${JSON.stringify(raw.steps_remaining)}). `
      + 'steps_completed에서 재계산했습니다.');
  } else if (prevRemaining !== null
      && (prevRemaining.length !== expectedRemaining.length
        || prevRemaining.some((step, i) => step !== expectedRemaining[i]))) {
    warnings.push('steps_remaining이 steps_completed와 어긋나 재계산했습니다.');
  }
  state.steps_remaining = expectedRemaining;

  // **완료 단계는 STEPS의 prefix여야 한다.** 파이프라인이 순차적이므로 중간에
  // 구멍이 있으면 재개 지점(steps_remaining[0])이 이미 지난 단계를 가리킨다.
  // 가장 위험한 경우: completed=[draft, publish] → remaining[0]='exif'.
  // .claude/commands/blog.md의 재개 규칙이 remaining[0]으로 점프하므로,
  // **이미 LIVE인 글에 대해 EXIF부터 전 파이프라인을 재실행**하고 두 번째 글을
  // 발행한다. CLAUDE.md "URL 슬러그 — 절대 규칙"이 기록한 redirect chain →
  // 색인 탈락 사고 경로 그대로다.
  const gapAt = state.steps_completed.findIndex((step, i) => step !== STEPS[i]);
  if (gapAt !== -1) {
    const missing = STEPS.slice(0, STEPS.indexOf(state.steps_completed[gapAt]))
      .filter((step) => !state.steps_completed.includes(step));
    const msg = `steps_completed에 구멍이 있습니다: ${state.steps_completed.join(',')} `
      + `— ${missing.join(', ')}을 건너뛰고 ${state.steps_completed[gapAt]}가 완료로 표시돼 있습니다.
`
      + `  + 이 상태로 재개하면 ${expectedRemaining[0]}부터 다시 실행됩니다`
      + `${state.post_id ? ` (이미 post_id=${state.post_id}가 있습니다 — 중복 발행 위험)` : ''}.
`
      + '  + tmp/의 아티팩트를 확인해 실제로 끝난 단계를 --complete로 채우거나, init --force로 다시 시작하세요.';
    if (strict) throw new SessionStateError(msg);
    warnings.push(msg);
  }
  // 발행이 완료로 표시됐는데 post_id가 없으면 어느 글을 발행했는지 알 수 없다.
  if (state.steps_completed.includes('publish') && !state.post_id) {
    const msg = 'publish가 완료로 표시됐는데 post_id가 없습니다 — 어느 글이 발행됐는지 확인할 수 없습니다.\n'
      + '  + Blogger 초안/글이 이미 만들어졌다면 --post-id로 함께 넘기세요.';
    if (strict) throw new SessionStateError(msg);
    warnings.push(msg);
  }

  // **prefix 검사만으로는 부족하다.** `completed=[]`는 유효한 prefix라서
  // `completed=[] && post_id != null`이 통과했다. 그 상태는 steps_completed가
  // 문자열로 손상됐을 때 정확히 만들어지고(빈 배열로 강등), 재개 규칙은
  // steps_remaining[0]='exif'로 점프한다 — post_id가 이미 있는데 처음부터
  // 다시 돌린다. post_id는 "Blogger에 글이 존재한다"는 증거이므로, 초안 이전
  // 단계가 하나도 완료로 표시되지 않은 것과 양립할 수 없다.
  if (state.post_id && !state.steps_completed.includes('draft')) {
    const msg = `post_id=${state.post_id}가 있는데 draft가 완료로 표시돼 있지 않습니다 `
      + `(완료: ${state.steps_completed.join(',') || '(없음)'}).\n`
      + '  + Blogger에는 글이 이미 있는데 상태는 그 이전을 가리킵니다 — 이대로 재개하면 '
      + '두 번째 글이 만들어집니다.\n'
      + '  + Blogger에서 해당 글을 확인한 뒤 --complete로 끝난 단계를 채우거나, '
      + '그 글을 지우고 init --force로 다시 시작하세요.';
    if (strict) throw new SessionStateError(msg);
    warnings.push(msg);
  }

  return { state, warnings };
}

function markCompleted(state, steps) {
  if (!Array.isArray(steps)) {
    throw new SessionStateError(`markCompleted: steps는 배열이어야 합니다 (받음: ${JSON.stringify(steps)}).`);
  }
  const unknown = steps.filter((s) => !STEPS.includes(s));
  if (unknown.length) {
    throw new SessionStateError(
      `알 수 없는 단계 이름: ${unknown.join(', ')} (사용 가능: ${STEPS.join(', ')})`,
    );
  }
  const done = new Set([...state.steps_completed, ...steps]);
  return {
    ...state,
    steps_completed: STEPS.filter((s) => done.has(s)),
    steps_remaining: remainingFrom(done),
  };
}

// 얕은 복사만 하면 steps_* 배열 **참조가 공유**되어, 호출자가 사본이라 믿고
// push한 것이 원본까지 오염시킨다 (그리고 markCompleted가 그 오염을 승격시킨다).
function touch(state, date = new Date()) {
  return {
    ...state,
    steps_completed: [...state.steps_completed],
    steps_remaining: [...state.steps_remaining],
    last_updated: nowKst(date),
  };
}

function readState(slug, dir = 'tmp', { strict = false } = {}) {
  const p = statePath(slug, dir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw new SessionStateError(`session-state를 읽을 수 없습니다 (${p}): ${errFull(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 원본은 덮어쓰지 않는다. 사람이 열어볼 수 있어야 한다.
    throw new SessionStateError(`session-state JSON 파싱 실패 (${p}): ${errFull(err)}. 파일은 그대로 두었습니다.`);
  }
  return { path: p, ...normalizeState(parsed, { slug, strict }) };
}

// 원자적 쓰기: 같은 디렉터리에 .tmp를 쓰고 rename. 중간에 죽어도 절반만 쓰인
// 상태 파일이 남지 않는다. 인코딩 'utf8' 명시 + 개행 \n 고정 (Windows 대비).
//
// 디스크에 **쓰는** 유일한 함수이므로 여기서 불변식을 강제한다. 예전에는 임의 객체를
// 그대로 직렬화해서, 중복·교집합·미지 단계가 섞인 파일이 만들어지고 다음 세션의
// read가 조용히 복구하는 바람에 손상 사실이 exit 코드로 드러나지 않았다.
function writeStateAtomic(slug, dir, state) {
  const { state: validated, warnings } = normalizeState(state, { slug, strict: true });
  // 정규화 과정에서 무언가 고쳐졌다면 조용히 넘기지 않는다.
  for (const w of warnings) console.warn(`[session-state] 쓰기 전 정규화: ${w}`);
  const p = statePath(slug, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function listStates(dir = 'tmp') {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const f of files.sort()) {
    const m = /^session-state-(.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const r = readState(m[1], dir);
      if (r) out.push({ slug: m[1], ...r });
    } catch (err) {
      out.push({ slug: m[1], path: path.join(dir, f), error: errFull(err) });
    }
  }
  return out;
}

module.exports = {
  EXIT_STATE_ERROR,
  SCHEMA_VERSION,
  STEPS,
  SessionStateError,
  assertSlug,
  defaultState,
  listStates,
  markCompleted,
  normalizeState,
  nowKst,
  readState,
  remainingFrom,
  statePath,
  touch,
  writeStateAtomic,
};
