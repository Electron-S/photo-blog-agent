# Photo Blog Agent — Claude Code 지침

이 프로젝트는 사진과 방문 메모를 바탕으로 **Blogger 또는 네이버 블로그**에 글을 작성하는 에이전트입니다.

## 아키텍처

이 저장소는 Claude Code의 `/blog` 슬래시 커맨드와 `scripts/*`, `prompts/*`로 구성된다.

- **`.claude/commands/blog.md`** — `/blog` 모드 진입 시 로드되는 워크플로우 프롬프트
- **`scripts/`** — EXIF 추출, 시각 분석 스캐폴딩, 이미지 업로드, Blogger/네이버 초안/수정/발행/삭제
- **`prompts/`** — 스타일 가이드, 시스템 규칙, 초안 작성, 방문지 리서치 프롬프트
- **`lib/`** — Blogger API 클라이언트, 네이버 블로그 Playwright 자동화, GitHub Pages 이미지 호스팅
- **`schemas/`** — JSON 스키마

사용자는 `/blog` 커맨드로 모드를 시작하고, 사진 파일 경로와 방문 메모를 자연어로 전달한다. Claude Code는 사진을 Read 도구로 시각 검사하여 장면·분위기·간판 등을 파악하고, 결과를 `tmp/photo-analysis-<날짜>.json`에 영속화한다. 비전 능력이 없는 모델이 실행 중이면 시각 분석을 건너뛰고 EXIF·캡션만으로 초안을 작성한다. 단계별 진행 상태는 `tmp/session-state-<slug>.json`에 기록되어 다른 세션이나 다른 모델이 중단 지점부터 이어 진행할 수 있다.

## 사진 파이프라인

사진 처리는 블로그 글 작성과 독립적으로 동작하는 파이프라인이다. 다른 에이전트에서도 메타데이터에 접근할 수 있도록 결과를 파일로 저장한다.

### 1단계: EXIF 메타데이터 추출

```bash
node scripts/extract-exif.js <이미지경로1> [이미지경로2] ... --output tmp/metadata-<날짜>.json
```

- 사진에서 날짜, GPS 좌표, 카메라 정보를 추출한다.
- `--output`으로 JSON 파일을 저장해야 2단계에서 `--metadata`로 재사용할 수 있다.
- 출력 포맷: `{ photos: [...], primary_date: "YYYY-MM-DD", date_range: "...", gps_center: { lat, lng } }`
- **`primary_date`** = 가장 많이 촬영된 단일 날짜 (동률이면 가장 이른 날). 이 값이 블로그 글의 방문 날짜이자 폴더 경로의 날짜다.

### 1.5단계: 사진 시각 분석 (영속화)

```bash
node scripts/analyze-photos.js <이미지경로1> [이미지경로2] ... --output tmp/photo-analysis-<날짜>.json
```

- 빈 JSON 골격을 디스크에 쓰는 **스캐폴더 스크립트**. 실제 시각 분석은 실행 중인 모델이 Read 도구로 사진을 보고 Edit으로 채운다.
- 모델은 첫 사진을 Read해서 시각 정보를 얻을 수 있으면 `analyzed_by_model_capability: "vision"`으로 표시하고 각 사진의 `scene_description`·`text_visible`·`notable_objects` 등을 채운다.
- 첫 사진 Read에서 시각 정보가 없으면(텍스트 전용 모델) `analyzed_by_model_capability: "text-only"`로 표시하고 나머지 사진은 건너뛴다.
- 이미 채워진 파일을 발견하면 다른 세션/모델이 만든 것이라 가정하고 재분석하지 않는다 (모델 간 핸드오프 지점).
- 출력 포맷: `{ schema_version: 1, analyzed_at, analyzed_by_model_capability, photos: [...], overall_impression }`

종료 코드:
- `analyze-photos.js`: 0=성공, 1=인자 오류, 2=`--output` 쓰기 실패, 3=지원 이미지 없음

### 2단계: 이미지 처리 및 업로드

```bash
node scripts/upload-images.js <이미지경로1> [이미지경로2] ... --metadata tmp/metadata-<날짜>.json [--slug 슬러그] [--max-size-kb N]
```

- **반드시 1단계의 `--output` JSON을 `--metadata`로 전달한다** — 그래야 사진 찍은 날짜가 폴더 경로에 반영되어 글 작성 시점과 분리된다.
- 날짜 우선순위: `--date` 명시 > `--metadata`의 `primary_date` > **둘 다 없거나 primary_date가 null이면 즉시 exit 5로 중단** (오늘 날짜 fallback은 멱등성을 깨므로 차단). 의도된 경우 `--date`를 명시할 것.
- `--slug`는 멱등성을 위해 한 번 정한 값을 유지할 것 (다른 slug로 재호출하면 중복 폴더가 생긴다)
- WebP 포맷만 사용 (JPEG 폴백 없음)
- 최대 1024x1024 리사이즈 (원본이 더 작으면 원본 크기 유지)
- 워터마크 자동 삽입 (우측 하단, 반투명)
- AdSense 파일 크기 기준: 이미지당 150KB 이하 (quality 80→70→60→50 순으로 자동 조절)
- `--max-size-kb`로 기준 변경 가능 (기본값: 150)
- 경로에 해시를 포함해 URL 추측 방지 (`posts/{date}-{hash12}/photo-NN.webp`)
- 업로드 후 URL 검증 (최대 3회 재시도)

종료 코드:
- `extract-exif.js`: 0=성공, 1=일반 실패, 2=`--output` 쓰기 실패(stdout 미출력), 3=지원 이미지 없음
- `upload-images.js`: 0=전부 정상, 1=업로드/검증 실패, 2=`--output` 쓰기 실패, 4=품질 저하(fallback/oversize/치수 결손), 5=날짜 출처 미상으로 업로드 거부 (`--metadata` 또는 `--date` 명시 필요, 멱등성 보호)
- `publish-post.js`: 0=성공, 1=일반 실패, 6=`--slug`/`--slug-from-date` 미지정 거부, 7=슬러그 검증 실패 (LIVE 영구 고정 URL과 mismatch 또는 발행 후 사후 검증 mismatch — 자동 suffix `-N`은 통과)

## 블로그 글 작성 워크플로우

사진 파이프라인 완료 후 진행한다.

1. EXIF 메타데이터와 사용자 메모를 바탕으로 방문지 리서치 (`prompts/visit-research.md`)
   - 공식 홈페이지 > 네이버/카카오 지도 > 관광공사 > 구글 검색 순으로 정보 수집
   - 식당/카페는 메뉴·가격 정보까지 수집
   - 주차 정보(무료/유료, 매장 이용 시 무료, 꿀팁)를 구조화하여 수집
2. `prompts/` 디렉토리의 스타일 가이드와 시스템 규칙을 참고하여 초안 작성
   - SEO 라벨은 지역+장소명+카테고리+계절+동행 조합으로 자동 생성
   - 주차·꿀팁·메뉴 정보는 별도 섹션 없이 본문에 자연스럽게 녹임
   - 공식 홈페이지 링크는 실용 정보 근처나 마무리 단락에 배치
   - **방문 날짜 = metadata의 `primary_date`** (EXIF 촬영 날짜). 글 작성 시점(오늘)과 절대 혼동하지 말 것
   - "오늘 다녀왔다" 같은 표현 금지. "지난 ○월 ○일", "○월 초" 등 EXIF 기반 표현 사용
   - `primary_date`가 null이면 방문 날짜를 "확인 필요"로 두고 임의 날짜를 만들지 말 것
   - GPS 좌표가 있으면 장소 확인에 활용
3. `scripts/create-draft.js`로 Blogger에 초안 생성 (이미지 URL 검증 포함)
4. 사용자가 수정을 요청하면 `scripts/update-post.js`로 기존 글 수정
   - `--labels` 생략 시 기존 라벨 보존 (PATCH 요청에 labels 필드 미포함)
5. 사용자가 승인하면 `scripts/publish-post.js`로 발행
   - **`--slug-from-date` 또는 `--slug` 중 하나는 반드시 동반**한다. 둘 다 없으면 `publish-post.js`가 exit 6으로 fail-fast 종료한다 (아래 "URL 슬러그 — 절대 규칙" 참조).
   - 기본 경로: `--slug-from-date tmp/metadata-<날짜>.json` → 슬러그를 `YYYY-MM-DD` (촬영 날짜) 로 강제
   - `primary_date`가 null이면 `--slug 2026-05-10` 형태로 직접 지정

## 이미지 포맷 규칙

- 모든 이미지는 WebP만 사용. JPEG 폴백은 제공하지 않는다.
- `<picture>/<source>` 래퍼 없이 `<img src="...webp">` 직접 사용.
- `<figure>`에 `style="margin:1.5em 0;text-align:center;position:relative;"` 적용. `position:relative`는 이미지 보호 오버레이를 위해 필요하다.
- `<img>`에 `width`, `height`, `loading="lazy"`, `style="max-width:100%;height:auto;"` 필수.
- `width`/`height`는 **업로드 결과 JSON의 `images[].width`/`height`를 그대로 옮긴다** (세로 사진: 768x1024, 가로: 1024x768 등). `null`이면 파이프라인이 치수를 확인하지 못한 것이므로 **추측해서 채우지 말고** 사용자에게 보고한다 — 틀린 치수는 CLS를 유발한다.
- 워터마크가 이미지 우측 하단에 자동 삽입됨.

## 사용 가능한 npm scripts

| 명령 | 용도 |
| --- | --- |
| `npm run assets:extract` | EXIF 메타데이터 추출 |
| `npm run assets:analyze` | 사진 시각 분석 JSON 골격 생성 |
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 |
| `npm run assets:test` | GitHub Pages 업로드 테스트 |
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | Blogger 초안 생성 |
| `npm run blogger:update` | Blogger 글 수정 |
| `npm run blogger:publish` | Blogger 글 발행 |
| `npm run blogger:delete` | Blogger 글 삭제 |

### EXIF 메타데이터 추출 (CLI)

```bash
node scripts/extract-exif.js <이미지경로1> [이미지경로2] ... [--output tmp/metadata-YYYY-MM-DD.json]
```

사진에서 날짜, GPS 좌표, 카메라 정보를 추출한다. `--output`으로 JSON 파일을 저장하면 다른 에이전트가 메타데이터를 활용할 수 있다.

### 사진 시각 분석 스캐폴더 (CLI)

```bash
node scripts/analyze-photos.js <이미지경로1> [이미지경로2] ... --output tmp/photo-analysis-YYYY-MM-DD.json
```

빈 JSON 골격(`photos[]`, 각 항목 `analysis_status: "pending"`)을 디스크에 쓴다. 실행 중인 모델이 사진을 Read 도구로 본 뒤 Edit으로 채워야 한다. 비전 능력이 없는 모델은 `analyzed_by_model_capability: "text-only"`로 표시하고 종료. 이미 채워진 파일은 재분석하지 않는다 (모델 간 핸드오프).

### 이미지 업로드 (CLI)

```bash
node scripts/upload-images.js <이미지경로1> [이미지경로2] ... --metadata tmp/metadata-<날짜>.json [--slug 슬러그] [--max-size-kb N]
```

- 반드시 `--metadata`로 1단계 출력을 연결할 것. `--date`도 `--metadata`도 없으면 (또는 metadata의 `primary_date`가 null이면) **업로드 전에 즉시 exit 5로 거부**된다 (네트워크 호출 없이 fail-fast — 멱등성 보호).
- `--max-size-kb`로 AdSense 이미지 크기 기준을 변경할 수 있다 (기본값: 150KB, 허용 범위: 1~10000).

### Blogger 초안 생성 (CLI)

```bash
node scripts/create-draft.js --title "제목" --content "HTML 본문" [--labels "라벨1,라벨2"]
# 또는 HTML 파일 경로로:
node scripts/create-draft.js --title "제목" --content ./draft.html --labels "라벨1,라벨2"
```

### Blogger 글 수정 (CLI)

```bash
node scripts/update-post.js --post-id POST_ID [--title "수정제목"] [--content "수정본문"] [--labels "라벨1,라벨2"]
```

`--labels`를 생략하면 기존 라벨이 보존된다.

### Blogger 글 발행 (CLI)

```bash
# 사진 촬영 날짜를 URL 슬러그로 사용 (기본 경로)
node scripts/publish-post.js --post-id POST_ID --slug-from-date tmp/metadata-<날짜>.json

# 슬러그 직접 지정 (metadata의 primary_date가 null일 때)
node scripts/publish-post.js --post-id POST_ID --slug 2026-05-10
```

- **`--slug`/`--slug-from-date` 중 하나는 필수.** 둘 다 없으면 exit 6으로 거부 — Blogger가 title 기반 한글 슬러그를 영구 고정하고 나중에 절대 못 바꾼다.
- URL 컨벤션: `YYYY-MM-DD.html` (zero-padded). 사진 촬영 날짜 기반이라 글 작성 시점과 분리되고 정렬도 자연스러움.
- Blogger API는 customPermalink를 공식 지원하지 않으므로 우회 트릭 사용: 발행 직전 title을 슬러그(YYYY-MM-DD)로 patch → publish → title 원복. Blogger가 발행 시점 title로 URL을 고정하고 이후 title 변경은 URL에 영향 없음에 의존.
- 슬러그는 영문/숫자/하이픈만 허용. `--slug-from-date`의 metadata `primary_date`가 null이면 fail.
- 같은 날짜의 두 번째 글은 Blogger가 자동으로 `-1`, `-2` 등의 suffix 추가 (자동 suffix는 정상 통과).
- 발행 결과 URL이 요청 슬러그(또는 자동 suffix `-N`)와 다르면 **exit 7로 fail-fast**. 자동화 재시도는 같은 글이 LIVE 상태로 남아 있을 가능성을 인지하고 수동 확인 분기로 처리할 것.

### URL 슬러그 — 절대 규칙

Blogger는 **첫 발행 시점에 URL을 영구 고정**한다. LIVE 된 글의 슬러그는 어떤 API/UI로도 변경 불가능.

- **발행 전(DRAFT) 단계**에서 슬러그를 반드시 `YYYY-MM-DD` 형태로 결정해 둘 것. `publish-post.js`의 슬러그 트릭은 DRAFT → LIVE 전환 순간에만 효과가 있다.
- 이미 LIVE 된 글의 URL을 바꾸려고 **글을 삭제하고 새로 발행하지 말 것**. Google index에 옛 URL이 남아 새 URL로의 redirect chain이 만들어지고, 이게 Search Console의 "리디렉션 오류"로 분류되어 색인이 막힌다 (실제로 이 프로젝트가 한 번 겪었던 사고).
- 부득이 URL을 바꿔야 한다면:
  1. 옛 글을 `delete-post.js`로 삭제. **단, Blogger v3 API의 `useTrash` 기본값은 문서에 명시되어 있지 않고 현재 `delete-post.js`는 옵션 미전달**이므로, 삭제 후 Blogger 에디터의 휴지통이 비어 있는지 (즉 영구 삭제되었는지) **수동 확인 필수**. 휴지통에 남아 있으면 비우기까지 진행해야 옛 URL이 응답을 멈춘다.
  2. 옛 URL을 직접 열어서 404가 반환되는지 확인. 200/3xx가 나오면 색인에서 자연 제거되지 않으므로 다시 휴지통/영구 삭제 단계로 돌아갈 것.
  3. 새 글을 올바른 슬러그로 처음부터 새로 작성·발행
  4. Search Console "삭제" 도구에서 옛 URL을 명시적으로 "임시 삭제" 요청 (재크롤 가속)

## 프롬프트 파일

| 파일 | 용도 |
| --- | --- |
| `prompts/style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `prompts/system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `prompts/blog-draft.md` | 첫 초안 생성 프롬프트 |
| `prompts/visit-research.md` | 방문지 리서치 프롬프트 |

블로그 글을 작성하거나 수정할 때 반드시 이 세 파일을 읽고 규칙을 따르세요.

## 영속화 아티팩트 (모델 간 핸드오프)

`tmp/` 디렉토리에 다음 파일들이 단계별로 영속화되어, 다른 세션·다른 모델이 중단 지점부터 재개할 수 있다:

| 파일 | 생성 단계 | 역할 |
| --- | --- | --- |
| `tmp/metadata-<날짜>.json` | EXIF 추출 직후 | 사진별 EXIF, `primary_date`, `gps_center` |
| `tmp/photo-analysis-<날짜>.json` | 시각 분석 단계 | 빈 골격을 스크립트가 만들고 비전 모델이 채움. `analyzed_by_model_capability`로 vision/text-only 분기 표시 |
| `tmp/session-state-<slug>.json` | 업로드 성공 후 | `steps_completed`/`steps_remaining`/`post_id`/`post_url` 등. 단계 종료마다 갱신 |
| `tmp/draft-<slug>.html` | 초안 작성 | Blogger에 등록된 HTML 본문 (수정 루프 시 Edit 대상) |

핵심 원칙:
- 이미 채워진 `photo-analysis-*.json`(`analyzed_by_model_capability`가 null이 아님)은 재분석하지 않는다 — 모델이 바뀌어도 그대로 사용
- `session-state-*.json`이 존재하면 `/blog` 모드 진입 시 사용자에게 "이어서/처음부터" 분기를 물음
- 사용자가 "처음부터"를 선택하면 session-state와 draft-html은 삭제하되, metadata/photo-analysis는 멱등하므로 보존

## 이미지 보호

- GitHub Pages에 업로드된 이미지는 공개 접근 가능하므로 워터마크와 경로 난독화로 보호한다.
- 워터마크: `WATERMARK_TEXT` 환경변수로 텍스트 지정 (기본값: `electronian-review.blogspot.com`), 이미지 우측 하단에 반투명으로 합성.
- 경로 난독화: `posts/{date}-{sha256hash}/{photo-NN.webp}` 형식으로 URL 추측 방지.
- 블로그 HTML: CSS/JS로 우클릭 방지, 드래그 방지 적용 (`blogger-image-protection.html` 참고).

## 네이버 블로그 발행 (Playwright 자동화)

Blogger 대신 또는 함께 네이버 블로그에 발행할 수 있습니다.

### 세션 설정 (1회 수행)
```bash
npm run naver:login
```
- 브라우저가 자동으로 열려 네이버 로그인 페이지가 표시됩니다.
- 직접 ID/PW로 로그인하세요.
- 로그인 후 세션이 `.naver-session.json`에 저장됩니다 (gitignore 대상).

### 초안 생성
```bash
npm run naver:draft -- --title "제목" --content "./draft.html" [--category "카테고리"] [--tags "태그1,태그2"]
```

### 발행
네이버 블로그 에디터에서 직접 글을 최종 확인한 후:
```bash
npm run naver:publish
```

**중요한 차이점** (Blogger vs 네이버):
- **이미지 호스팅**: Blogger는 GitHub Pages (외부 URL) 사용, 네이버는 에디터에서 직접 로컬 파일 업로드.
- **카테고리**: Blogger의 다중 라벨과 달리, 네이버는 1개 계층형 카테고리 + 자유 태그 사용.
- **URL 슬러그**: Blogger는 SEO URL을 `YYYY-MM-DD` 형식으로 직접 지정, 네이버는 `blog.naver.com/{blogId}/{logNo}` (숫자 ID)로 자동 결정.
- **세션 관리**: 네이버는 로그인/캡차가 빈번해 매 실행마다 로그인할 수 없으므로, 초기 1회 로그인 후 세션 재사용.

## 환경변수

`.env` 파일에 다음 변수가 설정되어 있어야 합니다:

**Blogger:**
- `BLOGGER_BLOG_ID`, `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET`, `BLOGGER_REFRESH_TOKEN` — Blogger API

**네이버:**
- 환경변수 불필요. `.naver-session.json` (gitignore)에 세션 저장.

**이미지 호스팅:**
- `GITHUB_OWNER`, `GITHUB_ASSET_REPO`, `GITHUB_ASSET_BRANCH`, `GITHUB_ASSET_BASE_URL` — GitHub Pages (Blogger 경로)
- `GITHUB_TOKEN` (선택) — GitHub API 토큰, 없으면 `gh auth token` 사용

**기타:**
- `WATERMARK_TEXT` (선택) — 워터마크 텍스트, 기본값: `electronian-review.blogspot.com`
