# Agent Flow

## MVP 1: Claude Code 발행 플로우

```text
1. 사용자가 /blog 모드로 진입하거나 blog-agent를 호출하고, 사진 경로와 방문 메모를 제공
2. prompts/workflow-steps.md(워크플로우 정본)와 style-guide/system-rules를 읽음
3. scripts/extract-exif.js로 EXIF 메타데이터를 JSON에 저장 (primary_date = 방문 날짜)
4. scripts/analyze-photos.js로 시각 분석 골격을 만들고 Read 도구로 사진을 보며 채움
5. scripts/upload-images.js에 3의 JSON을 --metadata로, 정한 slug를 --slug로 전달해 압축·업로드
   (--slug은 필수 — 폴더 경로의 유일한 식별자다. --output으로 width/height가 담긴 결과 JSON을 남김)
6. 방문지 리서치 — 공식/신뢰 가능한 공개 정보 수집
   - place_info: 공식 명칭, 카테고리, 주소, 연락처
   - access: 대중교통(역/정류장, 노선, 출구, 도보), 주차
   - cost_and_hours: 운영시간, 입장료, 프로모션
   - nearby_landmarks: 주변 유명 랜드마크·건물 정확한 명칭 (예: 롯데타워, 63빌딩)
   - neighborhood_context: 동네 특성, 알려진 이유, 계절 특징
   - visitor_tips: 혼잡도, 추천 시간대, 일반 동선
   - review_signals: 외부 리뷰 공통 장단점, 전체 분위기
7. 블로그 초안 HTML 작성
8. scripts/lint-draft.js로 자가 검증 (exit 8이면 고치고 반복)
9. scripts/create-draft.js로 Blogger에 초안 생성
10. 사용자가 수정 요청 → scripts/update-post.js로 기존 글 수정
11. 사용자가 발행 승인
12. scripts/publish-post.js로 발행 (--slug-from-date로 URL을 촬영일에 고정)
```

> 이전 판에서는 리서치가 4번, EXIF 추출이 5번, 시각 분석이 6번으로 적혀 있었으나
> 실제 실행 순서와 뒤집혀 있었습니다. 정본은 `prompts/workflow-steps.md`입니다.

## Human Checkpoints

사람의 확인이 필요한 지점:

- 장소명 정확성
- 가격, 메뉴, 영업시간, 주소 등 사실관계
- 사진 배치와 캡션
- 어조와 개인 경험 표현
- 최종 발행 승인

## 스크립트 사용법

[README.md의 스크립트 절](../README.md#스크립트-scripts)과 [종료 코드 표](../README.md#종료-코드)를 참조하세요.
명령·플래그·exit 코드의 정본은 README입니다.

## Success Criteria

```text
사진 세트 1개당 1개의 Blogger draft 생성
사진이 자동으로 본문에 삽입됨
확인 필요 사항이 명확히 분리됨
사진 기반 관찰 내용이 본문에 반영됨
랜드마크와 유명 장소가 정확한 명칭으로 표시됨
독자가 당연히 아는 사실이 가르치는 투로 표현되지 않음
외부 리뷰 원문 복사 없음
AdSense 리스크 문구 없음
수정 요청이 기존 Blogger 글에 반영됨
```
