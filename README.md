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
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 |
| `npm run assets:test` | 업로드 테스트 |

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

## 블로그 글 작성 워크플로우

```text
1. 사용자가 텔레그램에서 사진과 방문 메모를 보냄
2. Claude Code가 사진을 분석하고 방문지를 파악
3. Claude Code가 prompts/ 파일을 읽고 스타일 가이드를 준수
4. Claude Code가 방문지 리서치 (공식 페이지, 관광 정보, 주변 랜드마크)
5. Claude Code가 scripts/upload-images.js로 사진을 GitHub Pages에 업로드
6. Claude Code가 초안을 작성 (JSON 형식: title, content_html, labels, summary, fact_check_notes)
7. Claude Code가 scripts/create-draft.js로 Blogger에 초안 생성
8. 사용자가 텔레그램에서 수정 요청
9. Claude Code가 scripts/update-post.js로 기존 글 수정
10. 사용자가 발행 승인
11. Claude Code가 scripts/publish-post.js로 글 발행
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