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
// lib/slug.js의 validateSlugArg(`^[a-zA-Z0-9-]+$`)보다 **더 엄격하다** — 소문자만
// 허용하고 선행 하이픈을 거부한다. 즉 `--slug MyPost`로 Blogger 발행에는 성공한 뒤
// 여기서 exit 9로 거부될 수 있다. 워크플로우가 영문 소문자 슬러그를 쓰므로 실사용
// 경로에서는 어긋나지 않지만, 두 검증이 같지 않다는 점을 알고 있어야 한다.
function assertSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
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

  if (state.schema_version === undefined) {
    warnings.push('schema_version이 없어 1로 간주합니다 (다음 저장 시 추가됩니다).');
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
  if (prevRemaining === null
      || prevRemaining.length !== expectedRemaining.length
      || prevRemaining.some((s, i) => s !== expectedRemaining[i])) {
    if (prevRemaining !== null) {
      warnings.push('steps_remaining이 steps_completed와 어긋나 재계산했습니다.');
    }
  }
  state.steps_remaining = expectedRemaining;

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
    if (err.code === 'ENOENT') return null;
    throw new SessionStateError(`session-state를 읽을 수 없습니다 (${p}): ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 원본은 덮어쓰지 않는다. 사람이 열어볼 수 있어야 한다.
    throw new SessionStateError(`session-state JSON 파싱 실패 (${p}): ${err.message}. 파일은 그대로 두었습니다.`);
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
    if (err.code === 'ENOENT') return [];
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
      out.push({ slug: m[1], path: path.join(dir, f), error: err.message });
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
