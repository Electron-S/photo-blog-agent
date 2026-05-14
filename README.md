# Photo Blog Agent

사진과 방문 메모를 바탕으로 Blogger 블로그 글을 작성하는 에이전트 프로젝트입니다.

**무료 우선**이 핵심 제약입니다. 유료 호스팅이나 유료 자동화 없이 Blogger + GitHub Pages로 운영합니다.

## 아키텍처

```text
[Telegram 앱] → [codex-bot (메시지 전달)] → [Claude Code] → [photo-blog-agent 스크립트]
                                                        ↓
                                                 [Blogger API]
                                                 [GitHub Pages]
```

- **codex-bot**: 텔레그램 메시지와 사진을 Claude Code에 전달하는 단순 릴레이 봇
- **Claude Code**: 모든 블로그 관련 처리를 담당 (프롬프트 읽기, 리서치, 초안 작성, API 호출)
- **photo-blog-agent**: 프롬프트, 스크립트, 스타일 가이드, JSON 스키마를 제공하는 프로젝트

## 구성 요소

### 프롬프트 (`prompts/`)

| 파일 | 용도 |
|------|------|
| `style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `blog-draft.md` | 첫 초안 생성 프롬프트 |
| `visit-research.md` | 방문지 리서치 프롬프트 |

### 스크립트 (`scripts/`)

| 명령 | 용도 |
|------|------|
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | Blogger 초안 생성 (`--title`, `--content`, `--labels`) |
| `npm run blogger:update` | Blogger 글 수정 (`--post-id`, `--title`, `--content`, `--labels`) |
| `npm run blogger:publish` | Blogger 글 발행 (`--post-id`) |
| `npm run blogger:delete` | Blogger 글 삭제 (`--post-id`, `--draft-only`) |
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 (`--date`, `--slug`, `--max-size-kb`) |
| `npm run assets:test` | 업로드 테스트 |

CLI 직접 호출 (1단계의 출력을 2단계 `--metadata`로 연결해야 EXIF 날짜가 일관되게 사용됨):

```bash
# 1단계: EXIF 메타데이터 추출 (날짜/GPS/카메라 정보 → JSON 저장)
node scripts/extract-exif.js <이미지경로...> --output tmp/metadata-2026-05-05.json

# 2단계: 이미지 처리 & GitHub Pages 업로드 (--metadata로 1단계 결과 연결)
node scripts/upload-images.js <이미지경로...> --metadata tmp/metadata-2026-05-05.json [--slug 슬러그] [--max-size-kb N]
```

### 라이브러리 (`lib/`)

| 모듈 | 용도 |
|------|------|
| `blogger.js` | Blogger API 클라이언트 (초안 생성, 수정, 발행) |
| `github-assets.js` | 이미지 압축(sharp) & GitHub Pages 업로드 |

### JSON 스키마 (`schemas/`)

| 파일 | 용도 |
|------|------|
| `blog-draft.schema.json` | 블로그 초안 출력 스키마 |
| `visit-research.schema.json` | 방문지 리서치 출력 스키마 |

## 사진 파이프라인

블로그 글 작성과 독립적으로 동작하며, 다른 에이전트도 메타데이터를 활용할 수 있도록 결과를 JSON 파일로 저장한다.

1. **EXIF 메타데이터 추출** (`extract-exif.js`) — 날짜, GPS, 카메라 정보 추출. 결과 JSON에 `primary_date`(가장 많이 촬영된 날짜)를 포함.
2. **이미지 처리 & 업로드** (`upload-images.js`) — `--metadata`로 1단계 결과를 받아 EXIF 날짜를 폴더 경로에 반영. WebP 변환, 리사이즈, 워터마크, GitHub Pages 업로드.

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

### 종료 코드

| 스크립트 | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| `extract-exif.js` | 성공 | 일반 실패 | `--output` 쓰기 실패 | 지원 이미지 없음 | — | — |
| `upload-images.js` | 전부 정상 | 업로드/검증 실패 | — | — | fallback/oversize (정책 점검) | 날짜 출처 미상 — 업로드 거부 (멱등성 보호) |

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
```

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

```text
발행된 글: 2개
검색 등록: Google/Naver/Bing/Daum 기본 등록 완료
AdSense: 아직 신청 전 (글 10개 목표)
```

## 다음 목표

1. 글을 총 10개까지 쓰기
2. 소개, 문의, 개인정보처리방침 페이지 만들기
3. 글 10개와 기본 페이지 준비 후 AdSense 신청