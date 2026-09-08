# Photo Blog Agent

사진과 방문 메모를 바탕으로 Blogger 블로그 글을 작성하는 에이전트 프로젝트입니다.

**무료 우선**이 핵심 제약입니다. 유료 호스팅이나 유료 자동화 없이 Blogger + GitHub Pages로 운영합니다.

## 아키텍처

```text
[Claude Code /blog] → [photo-blog-agent scripts] → [Blogger API]
                                             ↓
                                       [GitHub Pages]
```

- **Claude Code**: `/blog` 슬래시 커맨드로 진입하여 프롬프트를 읽고, 리서치, 초안 작성, API 호출을 담당합니다.
- **photo-blog-agent**: 프롬프트, 스크립트, 스타일 가이드, JSON 스키마, 설정을 제공하는 프로젝트입니다.
- **Blogger API**: 초안 생성, 수정, 발행, 삭제.
- **GitHub Pages**: 이미지 호스팅.

## 구성 요소

### 프롬프트 (`prompts/`)

| 파일 | 용도 |
|------|------|
| `workflow-steps.md` | **워크플로우 정본 (Step 1~7).** `/blog` 커맨드와 `blog-agent`가 공유 |
| `style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `blog-draft.md` | 첫 초안 생성 프롬프트 |
| `visit-research.md` | 방문지 리서치 프롬프트 |

### 스크립트 (`scripts/`)

| 명령 | 용도 |
|------|------|
| `npm run assets:extract` | EXIF 메타데이터 추출 |
| `npm run assets:analyze` | 사진 시각 분석 JSON 골격 생성 |
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 |
| `npm run lint:draft` | 초안 HTML 규칙 검증 (`--upload-result`, `--format text\|json`, `--strict`; exit 8=위반) |
| `npm test` | 유닛 테스트 |
| `npm run test:clock` | 시스템 시계를 옮긴 채 유닛 테스트 (`CLOCK_OFFSET_MS`) — 시간 종속 회귀 방어 |
| `npm run session:state` | 세션 진행 상태 (`init`/`update`/`read`/`list`) |
| `npm run naver:doctor` | 네이버 자동화 프리플라이트 |
| `npm run naver:inspect` | 네이버 실물 DOM 셀렉터 확인 |
| `npm run assets:test` | GitHub Pages 업로드 테스트 |
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | Blogger 초안 생성 (`--title`, `--content`, `--labels`, `--upload-result`) |
| `npm run blogger:update` | Blogger 글 수정 (`--post-id`, `--title`, `--content`, `--labels`, `--upload-result`) |
| `npm run blogger:publish` | Blogger 글 발행 (`--post-id`, `--slug` 또는 `--slug-from-date`) |
| `npm run blogger:delete` | Blogger 글 삭제 (`--post-id`, `--draft-only`, `--keep-trash`) |

CLI 직접 호출 (1단계의 출력을 2단계 `--metadata`로 연결해야 EXIF 날짜가 일관되게 사용됨):

```bash
# 1단계: EXIF 메타데이터 추출 (날짜/GPS/카메라 정보 → JSON 저장)
node scripts/extract-exif.js <이미지경로...> --output tmp/metadata-2026-05-05.json

# 1.5단계: 사진 시각 분석 골격 생성 (실제 분석은 Claude Code가 Read/Edit로 채움)
node scripts/analyze-photos.js <이미지경로...> --output tmp/photo-analysis-2026-05-05.json

# 2단계: 이미지 처리 & GitHub Pages 업로드 (--metadata로 1단계 결과 연결)
# --slug은 필수다 (폴더 경로의 유일한 식별자 — 아래 "슬러그" 절 참조)
node scripts/upload-images.js <이미지경로...> --slug <슬러그> \
  --metadata tmp/metadata-2026-05-05.json \
  [--max-size-kb N] [--output tmp/upload-<슬러그>.json] [--local-only]
```

### 라이브러리 (`lib/`)

| 모듈 | 용도 |
|------|------|
| `blogger.js` | Blogger API 클라이언트 (초안 생성, 수정, 발행, 삭제) |
| `github-assets.js` | 이미지 압축(sharp) & GitHub Pages 업로드 |
| `asset-paths.js` | 슬러그·경로 해시 (의존성 0, sharp를 끌고 오지 않음) |
| `naver-errors.js` | 네이버 전용 오류·exit 코드 (10~19) |
| `naver-selectors.js` | 셀렉터 레지스트리 (**추정값 — `VERIFIED_AT` 확인 전**) |
| `naver-dom.js` | 에디터 DOM 헬퍼 (못 찾으면 덤프 후 실패, silent skip 없음) |
| `naver-debug.js` | 실패 시 스크린샷·HTML·프레임 트리 덤프 |
| `naver-browser.js` | 브라우저 기동·영속 프로필·세션 검증 |
| `naver-content.js` | 초안 HTML → 네이버 블록 변환 |
| `cli-args.js` | CLI 인자 파싱 |
| `slug.js` | Blogger URL 슬러그 검증 |
| `exif.js` | EXIF 값 정규화 |
| `html-parse.js` | 초안 HTML 토크나이저 (미닫힘 태그를 오류로 표면화) |
| `korean-text.js` | 글자수·문장수·이모지 계량 |
| `lint-draft.js` | 초안 규칙 엔진 |
| `session-state.js` | 세션 진행 상태 |
| `verify-images.js` | 본문 내 이미지 URL 검증 |

### JSON 스키마 (`schemas/`)

| 파일 | 용도 |
|------|------|
| `blog-draft.schema.json` | 블로그 초안 출력 스키마 |
| `visit-research.schema.json` | 방문지 리서치 출력 스키마 |
| `session-state.schema.json` | 세션 상태 스키마 |

스키마는 **문서·외부 도구용 참조**입니다. 런타임 검증에는 쓰이지 않습니다 (이 저장소에 JSON Schema 검증 라이브러리가 없습니다) — `lib/session-state.js`의 손수 검증과 `prompts/*.md`가 실제 계약입니다.

## 사진 파이프라인

블로그 글 작성과 독립적으로 동작하며, 다른 에이전트도 메타데이터를 활용할 수 있도록 결과를 JSON 파일로 저장한다.

1. **EXIF 메타데이터 추출** (`extract-exif.js`) — 날짜, GPS, 카메라 정보 추출. 결과 JSON에 `primary_date`(가장 많이 촬영된 날짜)를 포함.
2. **사진 시각 분석 스캐폴딩** (`analyze-photos.js`) — `tmp/photo-analysis-<날짜>.json`에 빈 골격 생성. Claude Code가 Read 도구로 사진을 보고 Edit으로 채움.
3. **이미지 처리 & 업로드** (`upload-images.js`) — `--metadata`로 1단계 결과를 받아 EXIF 날짜를 폴더 경로에 반영. WebP 변환, 리사이즈, 워터마크, GitHub Pages 업로드.

### 슬러그 — 폴더 경로의 유일한 식별자

`upload-images.js`의 `--slug`는 **필수**입니다. 경로가 `posts/{date}-{sha256(date-slug)[0:12]}`이므로
slug가 없으면 같은 날짜의 모든 글이 같은 폴더를 공유해 **이미 발행된 글의 이미지를 덮어씁니다.**
한글 slug는 ASCII화 과정에서 전부 사라져(`slugify('경복궁') === 'post'`) 같은 결과가 되므로 exit 1로 거부합니다.

발행 슬러그(`publish-post.js --slug`)와 세션 슬러그(`session-state.js --slug`)는 **같은 규칙**
(`^[a-z0-9][a-z0-9-]*$`)을 씁니다. 예전에는 발행이 대문자를 허용하고 세션이 거부해서,
`--slug MyPost`가 **Blogger URL을 영구 고정한 뒤** 세션이 exit 9로 죽었습니다.

### 사진 날짜 vs 글 쓰는 날짜

- 블로그 글의 방문 날짜 = `primary_date` (EXIF 촬영일). 글 작성 시점(오늘)과 혼동 금지.
- `--date` 명시 > `--metadata`의 `primary_date` > 둘 다 없거나 primary_date가 null이면 **즉시 exit 5로 중단** (오늘 날짜 fallback이 멱등성을 깨므로 업로드 전에 차단).
- 폴더 경로 `posts/{date}-{hash}`의 `{date}`도 EXIF 날짜를 따라야 같은 사진을 며칠 뒤 재업로드해도 같은 폴더를 가리킨다 (멱등성).

### 이미지 처리 정책

- **WebP 전용**: JPEG 폴백 없음. `<picture>` 래퍼 없이 `<img src="...webp">` 직접 사용.
- **리사이즈**: 최대 1024×1024 (원본이 더 작으면 원본 유지).
- **AdSense 파일 크기**: 이미지당 150KB 이하 (quality 80→70→60→50 자동 조절, `--max-size-kb`로 조정).
- **워터마크**: 우측 하단 반투명, `WATERMARK_TEXT` 환경변수로 텍스트 지정.
- **경로 난독화**: `posts/{date}-{sha256hash12}/photo-NN.webp` — URL 추측 방지.
- **업로드 후 URL 검증**: 최대 3회 재시도.
- **날짜 타당성**: 1990년 이전·미래 날짜는 카메라 시계 오류로 보고 `primary_date` 후보에서 제외
  (`date_status: "implausible"`). exif-reader가 `0000:00:00`을 `1899-11-30`으로 주는데,
  그 값이 Blogger URL로 영구 고정되는 것을 막습니다.
- **GPS**: 반구 지시자(`GPSLatitudeRef`/`GPSLongitudeRef`)가 없으면 좌표를 버립니다 —
  N/E로 가정하면 남반구·서반구 좌표가 정반대 지점이 됩니다. `(0, 0)`은 측위 실패 센티널로 버립니다.

### 초안 lint의 등급 설계

`error`는 발행을 차단하고 **우회 플래그가 없습니다**. 그래서 규칙마다 등급을
고르는 기준이 하나 있습니다 — **오탐의 비용과 미탐의 비용 중 무엇이 더 큰가.**

- 오탐(정당한 초안을 막음)은 즉시 드러납니다. 발행이 안 되니까요.
- 미탐(위반이 통과)은 **아무도 모르는 채 LIVE로 나갑니다.**

한국어 표면형을 부분 문자열로 판정하는 규칙은 넓히면 오탐, 좁히면 미탐이 나서
한 규칙으로 정밀함과 완전함을 동시에 만족시킬 수 없습니다. 그런 규칙은 **등급으로
나눕니다** — 작성 시점 표현이 그 예입니다:

| 규칙 | 등급 | 역할 |
| --- | --- | --- |
| `no-writing-date-expression` | error | **정밀함.** 시제 지시어가 방문 동사를 직접 수식하는 형태만. 보수적으로 둡니다 |
| `writing-date-word` | warn | **완전함.** 본문에 작성 시점 지시어가 있기만 하면 보고. 차단하지 않으므로 오탐 비용이 없고, error가 놓치는 형태를 열거 없이 표면화합니다 |

이 분담 덕분에 미탐이 "조용한 통과"가 아니라 "보이는 warn"이 되고, error 규칙을
넓힐 압력이 사라집니다.

**가드 존치 기준**: error 규칙의 예외(가드)는 **실제로 막는 오탐이 계량으로
확인될 때만** 존치합니다. 문법적으로 그럴듯한지가 아닙니다 — 오탐을 하나도 막지
않는 가드가 하는 일은 미탐을 만드는 것뿐이고, 미탐은 warn이 이미 덮습니다.
이 규칙이 열일곱 라운드 동안 오탐↔미탐을 왕복한 원인이 "그럴듯함"으로 판단한
것이었습니다. 실측 예: 절 연결어미 `-는데`·`-지만`·`-니까`는 오탐 0건을 막고
미탐 7건을 만들어 제거했고, `-으면/-하면/-되면/-보면` 계열은 오탐 2건을 막아
존치했습니다.

**수렴 판정 근거** (`test/lint-draft.test.js`가 계량으로 고정):
새 표면형 35종에서 error 오탐 **0/20**, 위반 적중 **13/15**, 놓친 2건은
warn이 **15/15** 덮습니다. 이 수치가 나빠지면 설계를 다시 봐야 합니다.

### 종료 코드

| 스크립트 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| `extract-exif.js` | 성공 | 일반 실패 | `--output` 쓰기 실패 | 지원 이미지 없음 | — | — | — | — | — |
| `analyze-photos.js` | 성공 | 인자 오류 | `--output` 쓰기 실패 | 지원 이미지 없음 | — | — | — | — | — |
| `upload-images.js` | 전부 정상 | 인자 오류(`--slug` 누락/붕괴)·업로드/검증 실패 | `--output` 쓰기 실패 | — | 품질 저하: fallback/oversize/치수 결손/계약 위반 | 날짜 출처 미상 — 업로드 거부 (멱등성 보호) | — | — | — |
| `publish-post.js` | 성공 | 일반 실패 | — | — | — | — | 슬러그 미지정 거부 | 슬러그 검증 실패 | — |
| `delete-post.js` | 성공 | 일반 실패 | — | — | — | — | — | 삭제 후 옛 URL이 살아 있음 | — |
| `lint-draft.js` | 통과 | 인자/파일 오류 | — | — | — | — | — | — | 규칙 위반 (error 1건 이상) |
| `create-draft.js` | 성공 | 일반 실패 | — | — | — | — | — | — | 초안 lint 위반 |
| `update-post.js` | 성공 | 일반 실패 | — | — | — | — | — | — | 초안 lint 위반 |
| `session-state.js` | 성공 | 인자 오류 | — | — | — | — | — | — | — |

`session-state.js`는 상태 파일이 없거나 손상됐거나 스키마를 위반하면 **9**로 끝납니다.

네이버 스크립트(`naver-*.js`)는 1~9와 겹치지 않게 **10~19** 블록을 씁니다.

| 코드 | 의미 | 조치 |
|---|---|---|
| 10 | playwright 모듈·브라우저 바이너리 없음 | `npm install --include=optional` + `npx playwright install chromium` |
| 11 | 세션 없음·만료·다른 계정 | `npm run naver:login` |
| 12 | 셀렉터 미발견 (DOM 변경 의심) | `tmp/naver-debug/` 덤프 확인 → `npm run naver:inspect` |
| 13 · 14 · 15 | 카테고리 · 태그 · 발행 후 검증 | **예약** — 발행 레이어 구현 후 사용 |
| 16 | 이미지 로컬 파일을 찾지 못함 | `tmp/assets/` 확인, `upload-images.js`를 `--output`/`--local-only`와 재실행 |
| 17 | headed 실행 불가 (디스플레이 없음) | WSLg / X 서버 확인 |
| 18 | 공개 발행 안전장치 거부 | `NAVER_ALLOW_PUBLIC=1` + `--visibility public` |
| 19 | 초안 HTML → 블록 변환 실패 | 허용 밖 태그·구조 오류를 초안에서 제거 |

## 블로그 글 작성 워크플로우

사진 파이프라인 완료 후 진행한다.

```text
1. EXIF 메타데이터와 사용자 메모를 바탕으로 방문지 리서치 (공식 페이지, 메뉴/가격, 주차 정보)
2. prompts/ 디렉토리의 스타일 가이드와 시스템 규칙을 참고하여 초안 작성
   - SEO 라벨은 지역+장소명+카테고리+계절+동행 조합으로 자동 생성
   - 주차·꿀팁·메뉴 정보는 별도 섹션 없이 본문에 자연스럽게 녹임
3. scripts/create-draft.js로 Blogger에 초안 생성 (이미지 URL 검증 포함)
4. 사용자가 수정을 요청하면 scripts/update-post.js로 기존 글 수정
   (--labels 생략 시 기존 라벨 보존)
5. 사용자가 승인하면 scripts/publish-post.js로 발행
   (--slug-from-date 또는 --slug 필수)
```

## 네이버 블로그 발행 (재구축 중 — 실물 확인 게이트 대기)

`playwright`는 `optionalDependencies`입니다. 쓰려면
`npm install --include=optional` 후 `npx playwright install chromium`.

| 단계 | 상태 |
|---|---|
| 의존성·브라우저·디스플레이 프리플라이트 (`naver:doctor`) | 완료 |
| 콘텐츠 파이프라인 (HTML → 블록, 로컬 이미지 해석, `--dry-run`) | 완료 |
| 셀렉터 레지스트리 + 실패 시 DOM 덤프 | 완료 (셀렉터는 **추정값**) |
| **실물 DOM 확인 (`naver:inspect`)** | **대기 — 사람이 네이버 계정으로 실행해야 함** |
| 에디터 조작 · 발행 · 사후 검증 | 게이트 통과 후 착수 |

`lib/naver-selectors.js`의 `VERIFIED_AT`이 `null`인 동안 실제 발행 경로는
exit 12로 차단됩니다. 추정 셀렉터로 구현하면 "또 한 번도 안 돌아가는 코드"가
되기 때문입니다. 지금 검증 가능한 것:

```bash
npm run naver:doctor                        # 프리플라이트 (계정 불필요)
npm run naver:draft -- --html tmp/draft-<slug>.html --dry-run   # 블록 변환 (브라우저 불필요)
npm run naver:login                         # 세션 수립 (headed 창 필요)
npm run naver:inspect -- --dump --keep-open # 실물 셀렉터 확인
```

`naver:doctor`는 **게이트 통과 전까지 exit 0을 내지 않습니다.** 항목별 OK/FAIL 표를
끝까지 출력한 뒤, 가장 먼저 조치할 항목의 코드로 종료합니다 — 앞이 다 통과했다면
마지막에 남는 것은 셀렉터 미검증이므로 exit 12입니다. `exit 0` = "정말로 발행 가능"이라
`npm run naver:doctor && npm run naver:draft ...` 체이닝이 안전합니다.

### Blogger와의 차이

- **이미지**: Blogger는 GitHub Pages 외부 URL, 네이버는 **로컬 파일을 에디터에 직접 업로드**.
  `upload-images.js`가 남긴 `tmp/assets/<date>-<hash12>/photo-NN.webp`를 쓰며,
  파일이 없으면 exit 16으로 중단하고 **URL로 폴백하지 않습니다** (핫링킹/깨짐 방지).
- **카테고리/태그**: 본문 에디터가 아니라 **발행 설정 레이어**에 있습니다.
  따라서 임시저장만 하는 경로에서는 반영되지 않으며, 그 사실을 출력으로 알립니다.
- **공개 발행**: `--visibility` 기본값은 `private`이고, `public`은
  `NAVER_ALLOW_PUBLIC=1`을 **함께** 요구합니다 (exit 18).

## URL 슬러그 절대 규칙

Blogger는 **첫 발행 시점에 URL을 영구 고정**한다. `publish-post.js`는 발행 직전 title을 슬러그(`YYYY-MM-DD`)로 변경 → 발행 → title 복원하는 트릭을 사용한다. 발행 전 DRAFT 단계에서 슬러그를 반드시 결정해야 하며, LIVE 된 글의 URL은 변경할 수 없다.

## 환경변수

`.env` 파일에 다음 변수가 설정되어 있어야 합니다:

| 변수 | 설명 |
|------|------|
| `BLOGGER_BLOG_ID` | Blogger 블로그 ID |
| `BLOGGER_CLIENT_ID` | Google OAuth client ID |
| `BLOGGER_CLIENT_SECRET` | Google OAuth client secret |
| `BLOGGER_REFRESH_TOKEN` | Blogger API refresh token |
| `GITHUB_OWNER` | GitHub 사용자명 (기본값: Electron-S) |
| `GITHUB_ASSET_REPO` | 이미지 저장소명 (기본값: photo-blog-assets) |
| `GITHUB_ASSET_BRANCH` | 브랜치 (기본값: main) |
| `GITHUB_ASSET_BASE_URL` | 이미지 기본 URL |
| `GITHUB_TOKEN` | GitHub 토큰 (비워두면 `gh auth token` 사용) |
| `WATERMARK_TEXT` | 워터마크 텍스트 (선택, 기본값: `electronian-review.blogspot.com`) |

## 현재 상태

발행 글 수·검색 등록·AdSense 신청 여부처럼 자주 바뀌는 값은 여기에 적지 않습니다
(갱신되지 않아 곧 거짓이 됩니다). 현황은 [블로그](https://electronian-review.blogspot.com)와
Blogger 대시보드에서 직접 확인하세요.

## 다음 목표

1. 글을 총 10개까지 쓰기
2. 소개, 문의, 개인정보처리방침 페이지 만들기
3. 글 10개와 기본 페이지 준비 후 AdSense 신청
