# Photo Blog Agent — Claude Code 지침

이 프로젝트는 사진과 방문 메모를 바탕으로 Blogger 블로그 글을 작성하는 에이전트입니다.

## 아키텍처

텔레그램 봇(`cy-telegram-bot`, `/blog` 모드)이 메시지와 사진을 이 프로젝트 작업 디렉토리에서 실행 중인 Claude Code에 전달만 합니다. 모든 블로그 관련 처리는 Claude Code가 담당합니다.

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
- `upload-images.js`: 0=전부 정상, 1=업로드/검증 실패, 4=fallback/oversize 품질 저하, 5=날짜 출처 미상으로 업로드 거부 (`--metadata` 또는 `--date` 명시 필요, 멱등성 보호)

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

## 이미지 포맷 규칙

- 모든 이미지는 WebP만 사용. JPEG 폴백은 제공하지 않는다.
- `<picture>/<source>` 래퍼 없이 `<img src="...webp">` 직접 사용.
- `<figure>`에 `style="margin:1.5em 0;text-align:center;"` 적용.
- `<img>`에 `width`, `height`, `loading="lazy"`, `style="max-width:100%;height:auto;"` 필수.
- `width`/`height`는 실제 이미지 치수와 일치해야 함 (세로 사진: 768x1024, 가로: 1024x768 등).
- 워터마크가 이미지 우측 하단에 자동 삽입됨.

## 사용 가능한 스크립트

| 명령 | 용도 |
| --- | --- |
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 테스트 |
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | Blogger 초안 생성 |
| `npm run blogger:update` | Blogger 글 수정 |
| `npm run blogger:publish` | Blogger 글 발행 |

### EXIF 메타데이터 추출 (CLI)

```bash
node scripts/extract-exif.js <이미지경로1> [이미지경로2] ... [--output tmp/metadata-YYYY-MM-DD.json]
```

사진에서 날짜, GPS 좌표, 카메라 정보를 추출한다. `--output`으로 JSON 파일을 저장하면 다른 에이전트가 메타데이터를 활용할 수 있다.

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
node scripts/publish-post.js --post-id POST_ID
```

## 프롬프트 파일

| 파일 | 용도 |
| --- | --- |
| `prompts/style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `prompts/system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `prompts/blog-draft.md` | 첫 초안 생성 프롬프트 |

블로그 글을 작성하거나 수정할 때 반드시 이 세 파일을 읽고 규칙을 따르세요.

## 이미지 보호

- GitHub Pages에 업로드된 이미지는 공개 접근 가능하므로 워터마크와 경로 난독화로 보호한다.
- 워터마크: `WATERMARK_TEXT` 환경변수로 텍스트 지정 (기본값: `electronian-review.blogspot.com`), 이미지 우측 하단에 반투명으로 합성.
- 경로 난독화: `posts/{date}-{sha256hash}/{photo-NN.webp}` 형식으로 URL 추측 방지.
- 블로그 HTML: CSS/JS로 우클릭 방지, 드래그 방지 적용 (`blogger-image-protection.html` 참고).

## 환경변수

`.env` 파일에 다음 변수가 설정되어 있어야 합니다:

- `BLOGGER_BLOG_ID`, `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET`, `BLOGGER_REFRESH_TOKEN` — Blogger API
- `GITHUB_OWNER`, `GITHUB_ASSET_REPO`, `GITHUB_ASSET_BRANCH`, `GITHUB_ASSET_BASE_URL` — GitHub Pages 이미지 호스팅
- `GITHUB_TOKEN` (선택) — GitHub API 토큰, 없으면 `gh auth token` 사용
- `WATERMARK_TEXT` (선택) — 워터마크 텍스트, 기본값: `electronian-review.blogspot.com`