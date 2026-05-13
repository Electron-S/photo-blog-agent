# Advice

이 문서는 세션이 끊겨도 프로젝트 방향을 다시 잡기 위한 운영 가이드입니다.

## Non-Negotiable Constraint

사용자는 **무료 우선**을 원합니다.

```text
Paid WordPress hosting: no
n8n Cloud paid plan: no
Airtable paid plan: no
무료 또는 이미 가진 도구 우선
```

## 아키텍처 (2026-05-12 업데이트)

```text
Telegram → codex-bot (단순 릴레이) → Claude Code → photo-blog-agent 스크립트
                                              ↓
                                       Blogger API (초안/수정/발행)
                                       GitHub Pages (이미지 호스팅)
```

- **codex-bot**: 메시지와 사진을 Claude Code에 전달만 하는 텔레그램 봇. 블로그 로직 없음.
- **photo-blog-agent**: 프롬프트, 스크립트, 스키마, 설정을 제공하는 프로젝트. Claude Code가 직접 활용.
- **Claude Code**: 모든 블로그 관련 처리를 담당 (프롬프트 읽기, 리서치, 초안 작성, API 호출).

## 현재 상태

```text
발행된 글: 2개
블로그 URL: https://electronian-review.blogspot.com
Blog ID: 109669205162281399
검색 등록: Google/Naver/Bing/Daum 기본 등록 완료
AdSense: 아직 신청 전 (글 10개 목표)
```

## 다음 목표

```text
1. 글을 총 10개까지 쓰기
2. 소개, 문의, 개인정보처리방침 페이지 만들기
3. 글 10개와 기본 페이지 준비 후 AdSense 신청
```

## 사용 가능한 스크립트

| 명령 | 용도 |
|------|------|
| `npm run blogger:auth` | Blogger OAuth 토큰 획득 |
| `npm run blogger:test` | Blogger API 연결 테스트 |
| `npm run blogger:draft` | 초안 생성 (`--title`, `--content`, `--labels`) |
| `npm run blogger:update` | 글 수정 (`--post-id`, `--title`, `--content`, `--labels`) |
| `npm run blogger:publish` | 글 발행 (`--post-id`) |
| `npm run blogger:delete` | 글 삭제 (`--post-id`, `--draft-only`) |
| `npm run assets:upload` | 이미지 압축 & GitHub Pages 업로드 |
| `npm run assets:test` | 업로드 테스트 |

## 이미지 호스팅

```text
GitHub repo: Electron-S/photo-blog-assets
Pages URL: https://electron-s.github.io/photo-blog-assets/
제한: 1GB 저장소, 월 100GB 대역폭
이미지 압축: 최대 1600px, JPEG 품질 82%
```

## 블로그 작성 스타일 가이드

고정 작성 스타일은 `prompts/style-guide.md`에 있습니다.

핵심 방향:

```text
이모지 사용 안 함
AI가 쓴 홍보글처럼 보이지 않게 작성
전문 블로거처럼 담백하지만 읽히는 문장
사진에서 보이는 구체적인 관찰 중심
랜드마크와 유명 장소는 정확한 명칭 사용 (예: "큰 건물" → "롯데타워")
독자가 당연히 아는 사실을 가르치듯 쓰지 않음
사용자 메모의 가족 관계와 사실관계 우선
"부인" 대신 "와이프"
"총평" 같은 기계적인 마무리 표현은 피함
불확실한 정보는 "확인 필요"로 표시
```

리서치 수집 항목:

```text
place_info: 공식 명칭, 카테고리, 주소, 연락처, 웹사이트
access: 대중교통, 주차, 접근성
cost_and_hours: 운영시간, 입장료, 프로모션
nearby_landmarks: 주변 유명 랜드마크·건물 정확한 명칭과 관계
neighborhood_context: 동네 특성, 알려진 이유, 계절 특징
visitor_tips: 혼잡도, 추천 시간대, 일반 동선
review_signals: 외부 리뷰 공통 장단점, 전체 분위기
```

## 프롬프트 파일

| 파일 | 용도 |
|------|------|
| `prompts/style-guide.md` | 한국어 블로그 작성 스타일 가이드 |
| `prompts/system-rules.md` | 모든 글 생성 단계에 적용되는 시스템 규칙 |
| `prompts/blog-draft.md` | 첫 초안 생성 프롬프트 |
| `prompts/visit-research.md` | 방문지 리서치 프롬프트 |

## Prompt Rules

에이전트 프롬프트에는 반드시 아래 규칙을 넣어야 합니다.

```text
사진에서 확인되지 않거나 제공된 리뷰/장소 정보에 없는 사실은 단정하지 마라.
직접 경험처럼 과장하지 마라.
외부 리뷰 원문을 길게 복사하지 말고 요약만 사용하라.
불확실한 정보는 "확인 필요"로 표시하라.
광고 클릭을 유도하는 문구는 절대 넣지 마라.
본문에는 내가 직접 찍은 사진에서 관찰 가능한 요소를 반드시 반영하라.
유명 랜드마크와 건물은 정확한 이름을 사용하라. 모호한 표현으로 넘어가지 마라.
독자가 당연히 아는 사실을 가르치듯 쓰지 마라. 자연스럽게 녹여라.
```

## AdSense Direction

```text
자동 생성 대량 발행을 피한다.
직접 찍은 사진 기반의 고유 콘텐츠를 만든다.
외부 리뷰는 요약만 하고 원문을 복사하지 않는다.
개인정보처리방침, 문의, 소개 페이지를 만든다.
빈 카테고리와 얇은 글을 만들지 않는다.
광고 클릭을 유도하는 표현을 쓰지 않는다.
초반에는 모든 글을 사람이 검수하고 발행한다.
```