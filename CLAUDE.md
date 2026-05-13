# Photo Blog Agent — Claude Code 지침

이 프로젝트는 사진과 방문 메모를 바탕으로 Blogger 블로그 글을 작성하는 에이전트입니다.

## 아키텍처

텔레그램 봇(`telegram-codex-bot`)은 메시지와 사진을 이 프로젝트 작업 디렉토리에서 실행 중인 Claude Code에 전달만 합니다. 모든 블로그 관련 처리는 Claude Code가 담당합니다.

## 블로그 글 작성 워크플로우

1. 사용자가 텔레그램에서 사진과 방문 메모를 보냄
2. Claude Code가 `scripts/extract-exif.js`로 사진 메타데이터(EXIF)에서 날짜와 GPS 좌표를 추출
3. EXIF 정보와 사용자 메모를 바탕으로 방문지 리서치 (`prompts/visit-research.md`)
   - 공식 홈페이지 > 네이버/카카오 지도 > 관광공사 > 구글 검색 순으로 정보 수집
   - 식당/카페는 메뉴·가격 정보까지 수집
   - 주차 정보(무료/유료, 매장 이용 시 무료, 꿀팁)를 구조화하여 수집
4. `prompts/` 디렉토리의 스타일 가이드와 시스템 규칙을 참고하여 초안 작성
   - SEO 라벨은 지역+장소명+카테고리+계절+동행 조합으로 자동 생성
   - 주차·꿀팁·메뉴 정보는 별도 섹션 없이 본문에 자연스럽게 녹임
   - 공식 홈페이지 링크는 실용 정보 근처나 마무리 단락에 배치
   - EXIF 날짜가 있으면 방문 날짜로 사용, GPS 좌표가 있으면 장소 확인에 활용
5. `scripts/upload-images.js`로 이미지를 GitHub Pages에 업로드
6. `scripts/create-draft.js`로 Blogger에 초안 생성 (이미지 URL 검증 포함)
7. 사용자가 수정을 요청하면 `scripts/update-post.js`로 기존 글 수정
8. 사용자가 승인하면 `scripts/publish-post.js`로 발행

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
node scripts/extract-exif.js <이미지경로1> [이미지경로2] ...
```

사진에서 날짜, GPS 좌표, 카메라 정보를 추출한다. 워크플로우 2단계에서 자동으로 활용한다.

### 이미지 업로드 (CLI)

```bash
node scripts/upload-images.js <이미지경로1> [이미지경로2] ... [--date YYYY-MM-DD] [--slug 슬러그]
```

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

## 환경변수

`.env` 파일에 다음 변수가 설정되어 있어야 합니다:

- `BLOGGER_BLOG_ID`, `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET`, `BLOGGER_REFRESH_TOKEN` — Blogger API
- `GITHUB_OWNER`, `GITHUB_ASSET_REPO`, `GITHUB_ASSET_BRANCH`, `GITHUB_ASSET_BASE_URL` — GitHub Pages 이미지 호스팅
- `GITHUB_TOKEN` (선택) — GitHub API 토큰, 없으면 `gh auth token` 사용