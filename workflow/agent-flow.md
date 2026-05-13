# Agent Flow

## MVP 1: Telegram + Claude Code Blogger Flow

```text
1. 사용자가 텔레그램에서 사진과 방문 메모를 보냄
2. codex-bot이 사진을 다운로드하고 Claude Code에 전달
3. Claude Code가 prompts/ 파일을 읽고 스타일 가이드를 준비
4. Claude Code가 사진을 분석하고 방문지를 파악
5. Claude Code가 방문지 공식/신뢰 가능한 공개 정보를 리서치
   - place_info: 공식 명칭, 카테고리, 주소, 연락처
   - access: 대중교통(역/정류장, 노선, 출구, 도보), 주차
   - cost_and_hours: 운영시간, 입장료, 프로모션
   - nearby_landmarks: 주변 유명 랜드마크·건물 정확한 명칭 (예: 롯데타워, 63빌딩)
   - neighborhood_context: 동네 특성, 알려진 이유, 계절 특징
   - visitor_tips: 혼잡도, 추천 시간대, 일반 동선
   - review_signals: 외부 리뷰 공통 장단점, 전체 분위기
6. Claude Code가 scripts/upload-images.js로 사진을 GitHub Pages에 업로드
7. Claude Code가 블로그 초안을 JSON 형식으로 작성
8. Claude Code가 scripts/create-draft.js로 Blogger에 초안 생성
9. 사용자가 텔레그램에서 수정 요청
10. Claude Code가 scripts/update-post.js로 기존 글 수정
11. 사용자가 발행 승인
12. Claude Code가 scripts/publish-post.js로 글 발행
```

## Human Checkpoints

사람의 확인이 필요한 지점:

- 장소명 정확성
- 가격, 메뉴, 영업시간, 주소 등 사실관계
- 사진 배치와 캡션
- 어조와 개인 경험 표현
- 최종 발행 승인

## 스크립트 사용법

### 이미지 업로드

```bash
node scripts/upload-images.js <이미지경로1> [이미지경로2] ... [--date YYYY-MM-DD] [--slug 슬러그]
```

### Blogger 초안 생성

```bash
node scripts/create-draft.js --title "제목" --content "HTML 본문" --labels "라벨1,라벨2"
# 또는 파일에서 본문 읽기:
node scripts/create-draft.js --title "제목" --content ./draft.html --labels "라벨1,라벨2"
```

### Blogger 글 수정

```bash
node scripts/update-post.js --post-id ID --content ./revised.html
```

### Blogger 글 발행

```bash
node scripts/publish-post.js --post-id ID
```

### Blogger 글 삭제

```bash
node scripts/delete-post.js --post-id ID
# 초안만 삭제:
node scripts/delete-post.js --post-id ID --draft-only
```