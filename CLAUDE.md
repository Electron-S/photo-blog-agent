# Photo Blog Agent — Claude Code 지침

이 프로젝트는 사진과 방문 메모를 바탕으로 **Blogger 또는 네이버 블로그**에 글을 작성하는 에이전트입니다.

## 아키텍처

이 저장소는 Claude Code의 `/blog` 슬래시 커맨드와 `scripts/*`, `prompts/*`로 구성된다.

- **`.claude/commands/blog.md`** — `/blog` 모드 진입 시 로드되는 워크플로우 프롬프트
- **`scripts/`** — EXIF 추출, 시각 분석 스캐폴딩, 이미지 업로드, Blogger/네이버 초안/수정/발행/삭제
- **`prompts/`** — 스타일 가이드, 시스템 규칙, 초안 작성, 방문지 리서치 프롬프트
- **`lib/`** — Blogger API 클라이언트, 네이버 블로그 Playwright 자동화, GitHub Pages 이미지 호스팅
- **`schemas/`** — JSON 스키마

사용자는 `/blog` 커맨드(또는 `blog-agent` 자연어 호출)로 모드를 시작하고, 사진 파일 경로와 방문 메모를 자연어로 전달한다. **두 진입점 모두 `prompts/workflow-steps.md`(워크플로우 정본)를 읽어 Step 1~7을 따른다** — 워크플로우를 바꿀 때는 그 파일만 고친다. Claude Code는 사진을 Read 도구로 시각 검사하여 장면·분위기·간판 등을 파악하고, 결과를 `tmp/photo-analysis-<날짜>.json`에 영속화한다. 비전 능력이 없는 모델이 실행 중이면 시각 분석을 건너뛰고 EXIF·캡션만으로 초안을 작성한다. 단계별 진행 상태는 `tmp/session-state-<slug>.json`에 기록되어 다른 세션이나 다른 모델이 중단 지점부터 이어 진행할 수 있다.

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
- 이미 채워진 entry는 다른 세션/모델이 만든 것이라 가정하고 재분석하지 않는다 (모델 간 핸드오프 지점).
  판단 단위는 **entry**다 — `photos[].analysis_status`가 `"pending"`인 것만 채운다. 최상위
  `analyzed_by_model_capability`만 보면, 사진을 추가해 재실행했을 때 새로 붙은 entry를 건너뛰어
  그 사진이 영구히 `scene_description: null`로 남는다.
- 출력 포맷: `{ schema_version: 1, analyzed_at, analyzed_by_model_capability, photos: [...], overall_impression }`

종료 코드:
- `analyze-photos.js`: 0=성공, 1=인자 오류, 2=`--output` 쓰기 실패, 3=지원 이미지 없음

### 2단계: 이미지 처리 및 업로드

```bash
node scripts/upload-images.js <이미지경로1> [이미지경로2] ... --slug <슬러그> --metadata tmp/metadata-<날짜>.json [--max-size-kb N]
```

- **반드시 1단계의 `--output` JSON을 `--metadata`로 전달한다** — 그래야 사진 찍은 날짜가 폴더 경로에 반영되어 글 작성 시점과 분리된다.
- 날짜 우선순위: `--date` 명시 > `--metadata`의 `primary_date` > **둘 다 없거나 primary_date가 null이면 즉시 exit 5로 중단** (오늘 날짜 fallback은 멱등성을 깨므로 차단). 의도된 경우 `--date`를 명시할 것.
- **날짜 타당성**: 1990년 이전이나 미래 날짜는 카메라 시계 오류로 보고 `primary_date` 후보에서 제외한다
  (`date_status: "implausible"`). exif-reader가 `0000:00:00`을 `1899-11-30`으로 주는데, 이 값이
  그대로 Blogger URL로 영구 고정된 사고를 막기 위한 것이다. 정말로 옛 날짜라면 `--date`/`--slug`로 명시할 것.
- **GPS 반구 지시자**(`GPSLatitudeRef`/`GPSLongitudeRef`)가 없으면 좌표를 버린다. N/E로 가정하면
  남반구·서반구 좌표가 정반대 지점이 된다. `(0, 0)`도 측위 실패 센티널로 보고 버린다.
- **`--slug`는 필수다.** 폴더 경로 `posts/{date}-{hash}`의 유일한 식별자이므로, 생략하면
  같은 날짜의 모든 글이 같은 폴더를 써서 **이미 발행된 글의 이미지를 덮어쓴다**.
  영문/숫자/하이픈만 — 한글 slug는 ASCII화 과정에서 전부 사라져 같은 결과가 되므로 exit 1로 거부된다.
- `--slug`는 멱등성을 위해 한 번 정한 값을 유지할 것 (다른 slug로 재호출하면 중복 폴더가 생긴다)
- **사진을 추가/제거하고 같은 slug로 재실행하면 `photo-NN`이 밀려 이미 발행된 글의
  이미지가 제자리에서 바뀐다.** 그래서 이미 있는 원격 경로에 **다른 내용**을 쓰는 것은
  기본 거부이고 `--allow-replace`가 있어야 한다. 내용이 같으면 재업로드 자체를 하지
  않으므로(진짜 멱등) 단순 재실행에는 필요 없다.
- WebP 포맷만 사용 (JPEG 폴백 없음)
- 최대 1024x1024 리사이즈 (원본이 더 작으면 원본 크기 유지)
- 워터마크 자동 삽입 (우측 하단, 반투명)
- AdSense 파일 크기 기준: 이미지당 150KB 이하 (quality 80→70→60→50 순으로 자동 조절)
- `--max-size-kb`로 기준 변경 가능 (기본값: 150)
- 경로에 해시를 포함해 URL 추측 방지 (`posts/{date}-{hash12}/photo-NN.webp`)
- 업로드 후 URL 검증 (최대 3회 재시도)

종료 코드:
- `extract-exif.js`: 0=성공, 1=일반 실패, 2=`--output` 쓰기 실패(stdout 미출력), 3=지원 이미지 없음
- `upload-images.js`: 0=전부 정상, 1=인자 오류(`--slug` 누락/붕괴 포함)·업로드/검증 실패, 2=`--output` 쓰기 실패, 4=품질 저하(oversize/치수 결손/fallback — **계약 위반은 산출물이 없어 exit 1이다**), 5=날짜 출처 미상으로 업로드 거부 (`--metadata` 또는 `--date` 명시 필요, 멱등성 보호)
  - exit 4의 `fallback` 종류는 **WebP 입력에서만** 발생한다. 출력이 항상 `.webp`라서
    일반 카메라 사진(.jpg/.heic)의 sharp 실패는 폴백 대상이 아니고 exit 1로 끝난다.
    일반 사진에서 도달 가능한 exit 4는 `oversize`와 `치수 결손`이다.
- `publish-post.js`: 0=성공, 1=일반 실패, 6=`--slug`/`--slug-from-date` 미지정 거부, 7=슬러그 검증 실패 (LIVE 영구 고정 URL과 mismatch 또는 발행 후 사후 검증 mismatch — 자동 suffix `-N`은 통과)
- `delete-post.js`: 0=성공(또는 `--draft-only`로 건너뜀), 1=일반 실패, 7=삭제 후 옛 URL이 아직 살아 있음 (휴지통 확인 필요)
- `lint-draft.js` / `create-draft.js` / `update-post.js`: 8=초안 HTML 규칙 위반 (error 1건 이상)

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
   - "오늘 다녀왔다" 같은 표현 금지. "지난 ○월 ○일", "○월 초" 등 EXIF 기반 표현 사용.
     lint가 두 규칙으로 나눠 검사한다 — `no-writing-date-expression`(error, 직접 수식만)과
     `writing-date-word`(warn, 지시어가 있기만 하면 보고). **warn이 떠도 확인할 것**:
     error가 보수적으로 넘긴 형태일 수 있다 (고정 어구라면 무시해도 된다)
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
| `npm run lint:draft` | 초안 HTML 규칙 검증 (exit 8=위반) |
| `npm test` | 유닛 테스트 (`node --test test/`) |
| `npm run test:clock` | 시계를 옮긴 채 테스트 (`CLOCK_OFFSET_MS`) — 시간 종속 회귀 방어 |
| `npm run assets:test` | GitHub Pages 업로드 테스트 |
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | Blogger 초안 생성 |
| `npm run blogger:update` | Blogger 글 수정 |
| `npm run blogger:publish` | Blogger 글 발행 |
| `npm run blogger:delete` | Blogger 글 삭제 |

### CLI 레퍼런스

명령·플래그·종료 코드의 정본은 [README.md](README.md#스크립트-scripts)입니다.
위 "사진 파이프라인"과 "블로그 글 작성 워크플로우" 절에 이 프로젝트에서 지켜야 할
규칙과 그 이유를 적어 두었고, 전체 인자 목록은 각 스크립트를 **인자 없이 실행**하면 나오는
usage로 확인합니다. 대부분의 스크립트는 `--help`를 알 수 없는 플래그로 거부하고
(그때도 usage가 출력됩니다), `naver-publish-post.js`만 `--help`/`-h`를 받습니다.

### URL 슬러그 — 절대 규칙

Blogger는 **첫 발행 시점에 URL을 영구 고정**한다. LIVE 된 글의 슬러그는 어떤 API/UI로도 변경 불가능.

- **발행 전(DRAFT) 단계**에서 슬러그를 반드시 `YYYY-MM-DD` 형태로 결정해 둘 것. `publish-post.js`의 슬러그 트릭은 DRAFT → LIVE 전환 순간에만 효과가 있다.
- 이미 LIVE 된 글의 URL을 바꾸려고 **글을 삭제하고 새로 발행하지 말 것**. Google index에 옛 URL이 남아 새 URL로의 redirect chain이 만들어지고, 이게 Search Console의 "리디렉션 오류"로 분류되어 색인이 막힌다 (실제로 이 프로젝트가 한 번 겪었던 사고).
- 부득이 URL을 바꿔야 한다면:
  1. 옛 글을 `delete-post.js`로 삭제. `useTrash=false`(영구 삭제)를 명시적으로 넘기며, 삭제 후 옛 URL에 HEAD를 날려 404인지 스크립트가 직접 확인한다. 살아 있으면 **exit 7**로 중단하고 휴지통 확인을 안내한다. (`--keep-trash`를 쓰면 휴지통으로 보내지만, 그러면 옛 URL이 계속 응답할 수 있다.)
  2. exit 7이 나면 Blogger 에디터의 휴지통이 비어 있는지 확인하고, 몇 분 뒤 옛 URL을 직접 열어 404를 재확인할 것. CDN 캐시일 수도 있다.
  3. 새 글을 올바른 슬러그로 처음부터 새로 작성·발행
  4. Search Console "삭제" 도구에서 옛 URL을 명시적으로 "임시 삭제" 요청 (재크롤 가속)

## 프롬프트 파일

| 파일 | 용도 |
| --- | --- |
| `prompts/style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `prompts/system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `prompts/blog-draft.md` | 첫 초안 생성 프롬프트 |
| `prompts/visit-research.md` | 방문지 리서치 프롬프트 |
| `prompts/workflow-steps.md` | **워크플로우 정본 (Step 1~7).** `/blog` 커맨드와 `blog-agent`가 공유한다 |

블로그 글을 작성하거나 수정할 때 `style-guide.md` · `system-rules.md` · `blog-draft.md`를
반드시 읽고 규칙을 따르세요. 워크플로우 진행은 `workflow-steps.md`가 정본입니다.

## 영속화 아티팩트 (모델 간 핸드오프)

`tmp/` 디렉토리에 다음 파일들이 단계별로 영속화되어, 다른 세션·다른 모델이 중단 지점부터 재개할 수 있다:

| 파일 | 생성 단계 | 역할 |
| --- | --- | --- |
| `tmp/metadata-<날짜>.json` | EXIF 추출 직후 | 사진별 EXIF, `primary_date`, `gps_center` |
| `tmp/photo-analysis-<날짜>.json` | 시각 분석 단계 | 빈 골격을 스크립트가 만들고 비전 모델이 채움. `analyzed_by_model_capability`로 vision/text-only 분기 표시 |
| `tmp/upload-<slug>.json` | 업로드 직후 (`--output`) | 이미지별 `webpUrl`·`webpPath`·`width`·`height`. 초안의 `<img>` 치수 출처이자 lint의 `--upload-result` 입력 |
| `tmp/session-state-<slug>.json` | 업로드 성공 후 | `steps_completed`/`steps_remaining`/`post_id`/`post_url` 등. **`scripts/session-state.js`로만 갱신** (직접 Write 금지 — 두 배열을 손으로 동기화하면 재개가 조용히 깨진다) |
| `tmp/draft-<slug>.html` | 초안 작성 | Blogger에 등록된 HTML 본문 (수정 루프 시 Edit 대상) |

핵심 원칙:
- 이미 채워진 entry(`photos[].analysis_status !== "pending"`)는 재분석하지 않는다 — 모델이 바뀌어도 그대로 사용.
  `analyze-photos.js`는 사진을 추가하면 **기존 분석을 보존한 채 새 entry만 pending으로 붙인다** (병합)
- `session-state-*.json`이 존재하면 `/blog` 모드 진입 시 사용자에게 "이어서/처음부터" 분기를 물음
- 사용자가 "처음부터"를 선택하면 session-state와 draft-html은 삭제하되, metadata/photo-analysis는 멱등하므로 보존

## 이미지 보호

- GitHub Pages에 업로드된 이미지는 공개 접근 가능하므로 워터마크와 경로 난독화로 보호한다.
- 워터마크: `WATERMARK_TEXT` 환경변수로 텍스트 지정 (기본값: `electronian-review.blogspot.com`), 이미지 우측 하단에 반투명으로 합성.
- 경로 난독화: `posts/{date}-{hash12}/{photo-NN.webp}` — sha256의 **앞 12자리 hex**입니다 (`lib/asset-paths.js`).
- 블로그 HTML: CSS/JS로 우클릭 방지, 드래그 방지 적용 (`blogger-image-protection.html` 참고).

## 네이버 블로그 발행 (Playwright 자동화) — 실험적, 현재 미검증

> **경고: 이 기능은 아직 한 번도 실제로 동작한 적이 없습니다.**
> 셀렉터가 실물 네이버 SmartEditor DOM으로 검증되지 않았습니다
> (`lib/naver-selectors.js`의 `VERIFIED_AT`이 `null`).
> 지금 동작하는 것은 `naver:draft --dry-run`(브라우저 없이 블록 변환·로컬 이미지
> 해석 검증)과 `naver:doctor`뿐이고, 에디터 조작 레이어는 미구현입니다.
> 실물 검증이 끝나기 전까지는 **Blogger 경로만 사용하세요.**
>
> `playwright`는 `optionalDependencies`입니다. 미설치 상태에서 **브라우저를 여는
> 경로**(`naver:login`, `naver:inspect`, `naver:doctor`)는 exit 10과 설치 안내
> (`npm install --include=optional`, `npx playwright install chromium`)를 냅니다.
> `naver:draft`는 셀렉터 게이트(exit 12)나 이미지 해석(exit 16)에서 먼저 멈추므로
> playwright를 require하는 지점에 도달하지 않습니다 — exit 10이 아닙니다.

### 세션 설정 (1회 수행)
```bash
npm run naver:login
```
- 브라우저가 자동으로 열려 네이버 로그인 페이지가 표시됩니다.
- 직접 ID/PW로 로그인하세요.
- 로그인 후 세션은 chromium 영속 프로필 `.naver-profile/`에 유지됩니다 (gitignore 대상).
- `.naver-session.json`도 생기지만 **감사/디버그용 스냅샷**일 뿐 로그인 판정에는 쓰이지 않습니다.

### 초안 생성
```bash
npm run naver:draft -- --html ./draft.html --title "제목" [--category "카테고리"] [--tags "태그1,태그2"] [--dry-run]
```

### 발행

**현재 `naver:publish`는 미구현입니다** (임시저장 목록 UI를 실물로 확인하지 못했습니다).
`--draft-title` 없이 실행하면 exit 1, 지정해도 exit 12로 끝납니다.

발행은 작성과 한 프로세스로 수행합니다:

```bash
npm run naver:draft -- --html ./draft.html --title "제목" --publish --visibility private
```

`--visibility` 기본값은 `private`이고, `public`은 `NAVER_ALLOW_PUBLIC=1`을 함께 요구합니다 (exit 18).

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
- `NAVER_BLOG_ID` (필수) — `blog.naver.com/{여기}`. 에디터 URL·로그인 계정 검증·발행 후 URL 대조에 씁니다.
- `NAVER_PROFILE_DIR` (선택, 기본 `.naver-profile`) — 세션이 유지되는 chromium 프로필 디렉터리.
- `NAVER_ALLOW_PUBLIC` (안전장치) — 공개 발행에는 `1`이 필요합니다. `--visibility public`만으로는 exit 18로 거부됩니다.

**이미지 호스팅:**
- `GITHUB_OWNER`, `GITHUB_ASSET_REPO`, `GITHUB_ASSET_BRANCH`, `GITHUB_ASSET_BASE_URL` — GitHub Pages (Blogger 경로)
- `GITHUB_TOKEN` (선택) — GitHub API 토큰, 없으면 `gh auth token` 사용

**기타:**
- `WATERMARK_TEXT` (선택) — 워터마크 텍스트, 기본값: `electronian-review.blogspot.com`
