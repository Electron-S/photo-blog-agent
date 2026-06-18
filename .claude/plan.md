# 텔레그램 봇 제거 및 프로젝트 정리 계획

## 목표

- 텔레그램 봇과 관련된 모든 코드, 설정, 문서를 제거한다.
- README, CLAUDE.md, advice.md, workflow, runbook, `.claude/commands/blog.md`를 현재 CLI 중심 구조로 갱신한다.
- `package.json`에 실용적인 npm scripts를 추가한다.
- `tmp/` 디렉토리를 정리한다(백업 후 전체 비우기).

## 사용자 결정 사항

- 봇 제거 범위: `bot/` 디렉토리 전체 + `.env.example` 봇 환경변수 + `CLAUDE.md` 봇 섹션 모두 제거
- `tmp/` 정리 정책: 완전히 비우되, 중요 파일은 사용자가 직접 백업
- `README.md`: 현재 아키텍처(bot 제거, 시각 분석, 영속화 아티팩트)에 맞게 전면 재작성
- `package.json`: 실용적 script 추가

---

## Phase 1: 봇 제거 (파일 삭제)

### 삭제 대상

`bot/` 디렉토리 전체를 삭제한다:

- `bot/bot.py`
- `bot/claude_runner.py`
- `bot/session_store.py`
- `bot/requirements.txt`
- `bot/systemd/photo-blog-bot.service`
- `bot/state/1128510632.json`
- `bot/state/1128510632_messages.json`
- `bot/__pycache__/`
- `bot/bot.log`
- `bot/.venv/`

### `.gitignore` 수정

봇 관련 항목을 제거한다:

```diff
- # bot/ — Python Telegram bridge
- bot/.venv/
- bot/state/
- bot/*.log
- bot/__pycache__/
```

### `.env.example` 수정

봇 환경변수 블록을 제거한다:

```diff
- # Telegram bot (bot/) — 내장 텔레그램 브리지
- TELEGRAM_BOT_TOKEN=<your-bot-token>
- TELEGRAM_ALLOWED_CHAT_IDS=
- OLLAMA_BIN=ollama
- OLLAMA_MODEL=kimi-k2.6:cloud
- CLAUDE_TIMEOUT_SEC=900
- BOT_INIT_MODE=true
- LOG_LEVEL=INFO
```

---

## Phase 2: 문서 갱신

### `CLAUDE.md`

- **아키텍처** 섹션을 단순화:
  - "텔레그램 봇(`bot/`)" 제거
  - "Claude Code `/blog` 커맨드 + `scripts/*` + `prompts/*`"로 기술
  - 사용자가 직접 사진 경로와 메모를 제공하는 흐름으로 변경
- **텔레그램 봇 (`bot/`)** 섹션 전체 삭제
- **사진 파이프라인**, **이미지 포맷 규칙**, **URL 슬러그 절대 규칙**, **영속화 아티팩트**, **이미지 보호**, **환경변수** 섹션은 유지/보강
- 환경변수 표에서 봇 변수 제거

### `README.md`

전면 재작성. 새 구조:

1. **개요**: 사진 기반 Blogger 글 작성 에이전트 (CLI/Claude Code 슬래시 커맨드 중심)
2. **아키텍처**: 사용자 → Claude Code `/blog` → `scripts/*` → Blogger API + GitHub Pages
3. **구성 요소**: `prompts/`, `scripts/`, `lib/`, `schemas/`, `.claude/commands/`
4. **사진 파이프라인**:
   - EXIF 추출 (`extract-exif.js`)
   - 시각 분석 스캐폴딩 (`analyze-photos.js`)
   - 이미지 업로드 (`upload-images.js`)
   - 멱등성 규칙 강조
5. **블로그 글 작성 워크플로우**:
   - 리서치 → 초안 → 수정 → 발행
   - 발행 시 `--slug-from-date` 필수
6. **사용 가능한 npm scripts** (갱신된 표)
7. **환경변수** (봇 변수 제거)
8. **종료 코드** 표

### `advice.md`

- 아키텍처 다이어그램에서 `Telegram → codex-bot` 제거
- "Claude Code 직접 실행" 중심으로 변경
- 현재 상태/목표는 유지
- 사용 가능한 스크립트 표를 `package.json` 기준으로 동기화

### `workflow/agent-flow.md`

- 제목의 "Telegram +" 제거
- 1단계 "사용자가 텔레그램에서" → "사용자가 Claude Code `/blog` 모드에서 사진 경로와 메모를 제공"
- 9단계 "사용자가 텔레그램에서 수정 요청" → "사용자가 수정 요청"
- 11단계 "사용자가 발행 승인" → "사용자가 발행 OK"

### `manual-workflow/runbook.md`

- 1단계 "텔레그램에서 사진과 방문 메모를 보냅니다" → "`/blog` 모드에서 사진 경로와 방문 메모를 제공합니다"
- Human Checkpoints, Success Criteria는 유지

### `.claude/commands/blog.md`

- 상단 description의 "텔레그램 브리지" 제거
- "대기 중 사진/메모" 스캔은 유지하되, Telegram 봇에 의존하지 않고 사용자가 제공한 파일 경로도 처리한다는 점 명시
- "모드 진입 시 첫 응답"에서 텔레그램 특화 문구 제거
- Step 1에서 `tmp/pending-batch/` + `tmp/incoming/` 스캔은 유지, 사용자가 추가 경로 명시 가능하도록 보강
- Step 6/7의 "사용자가 명시적으로 발행 OK" 흐름 유지
- "핵심 규칙"에서 봇/세션 상태 관련 항목은 유지(세션 상태는 slug 단위, 모델 간 핸드오프)
- `tmp/incoming/`이 실제로 사용되지 않는다면 언급 제거 또는 보완 검토

---

## Phase 3: `package.json` scripts 추가

기존 scripts는 유지하고 아래를 추가한다:

```json
{
  "scripts": {
    "blogger:auth": "node scripts/get-blogger-token.js",
    "blogger:test": "node scripts/test-blogger-api.js",
    "blogger:draft": "node scripts/create-draft.js",
    "blogger:update": "node scripts/update-post.js",
    "blogger:publish": "node scripts/publish-post.js",
    "blogger:delete": "node scripts/delete-post.js",
    "assets:extract": "node scripts/extract-exif.js",
    "assets:analyze": "node scripts/analyze-photos.js",
    "assets:upload": "node scripts/upload-images.js",
    "assets:test": "node scripts/test-github-assets.js"
  }
}
```

- `assets:extract`와 `assets:upload`는 인자를 추가로 받는다(예: `--metadata`, `--output`).
- `assets:analyze`는 `--output` 인자 필요.
- README와 `advice.md`의 스크립트 표를 이 목록과 동기화.

---

## Phase 4: `tmp/` 정리

1. **사용자에게 백업 요청**:
   ```bash
   cp -r tmp tmp.backup.$(date +%Y%m%d)
   ```
2. **백업 확인 후 `tmp/` 전체 비우기**:
   ```bash
   rm -rf tmp/*
   ```
3. **디렉토리 유지**:
   - `tmp/` 디렉토리 자체는 워크플로우에서 계속 사용되므로 유지.
   - 선택적으로 `tmp/.gitkeep` 추가.

---

## Phase 5: 검증

1. JavaScript syntax 검사:
   ```bash
   node -c scripts/*.js
   ```
2. npm scripts 목록 확인:
   ```bash
   npm run
   ```
3. `.env.example`에 봇 변수가 없는지 확인.
4. `git status`로 변경 사항 확인:
   - `bot/` 전체 삭제
   - 문서 파일 수정
   - `package.json` 수정
   - `.gitignore`, `.env.example` 수정

---

## 예상 변경 파일 목록

### 삭제
- `bot/*` (디렉토리 전체, git 추적 상태였으나 현재는 일부 untracked 포함)

### 수정
- `.env.example`
- `.gitignore`
- `CLAUDE.md`
- `README.md`
- `advice.md`
- `workflow/agent-flow.md`
- `manual-workflow/runbook.md`
- `.claude/commands/blog.md`
- `package.json`

### 생성
- `.claude/plan.md` (현재 파일)

---

## 위험 및 주의사항

- `tmp/` 삭제는 되돌릴 수 없으므로 반드시 백업 후 실행.
- `CLAUDE.md`와 `.claude/commands/blog.md`는 프로젝트 핵심 지침이므로, 변경 후에도 URL 슬러그 규칙, 멱등성, 시각 분석 영속화, 이미지 포맷 규칙이 그대로 유지되는지 재확인.
- 봇 삭제 후에는 텔레그램을 통한 글 작성이 완전히 불가능해지며, 모든 글 작성은 Claude Code `/blog` 커맨드 또는 직접 CLI 호출로 진행된다.
