# Agent Flow

## MVP 1: Claude Code Blogger Flow

```text
1. 사용자가 Claude Code에서 /blog 모드로 진입하고 사진 경로와 방문 메모를 제공
2. Claude Code가 prompts/ 파일을 읽고 스타일 가이드를 준비
3. Claude Code가 사진을 분석하고 방문지를 파악
4. Claude Code가 방문지 공식/신뢰 가능한 공개 정보를 리서치
   - place_info: 공식 명칭, 카테고리, 주소, 연락처
   - access: 대중교통(역/정류장, 노선, 출구, 도보), 주차
   - cost_and_hours: 운영시간, 입장료, 프로모션
   - nearby_landmarks: 주변 유명 랜드마크·건물 정확한 명칭 (예: 롯데타워, 63빌딩)
   - neighborhood_context: 동네 특성, 알려진 이유, 계절 특징
   - visitor_tips: 혼잡도, 추천 시간대, 일반 동선
   - review_signals: 외부 리뷰 공통 장단점, 전체 분위기
5. Claude Code가 scripts/extract-exif.js로 메타데이터를 JSON에 저장하고, 그 JSON을 scripts/upload-images.js의 --metadata로 전달 (EXIF 날짜 기반 폴더 경로)
6. Claude Code가 scripts/analyze-photos.js로 시각 분석 골격을 생성하고 Read 도구로 사진을 보며 채움
7. Claude Code가 블로그 초안을 JSON 형식으로 작성
8. Claude Code가 scripts/create-draft.js로 Blogger에 초안 생성
9. 사용자가 수정 요청
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

### EXIF 추출

```bash
# 1단계: EXIF 추출 (메타데이터 JSON 저장)
node scripts/extract-exif.js <이미지경로들> --output tmp/metadata-<날짜>.json
```

### 사진 시각 분석 골격 생성

```bash
# 1.5단계: 시각 분석 JSON 골격 생성 (실제 분석은 Claude Code가 Read/Edit로 수행)
node scripts/analyze-photos.js <이미지경로들> --output tmp/photo-analysis-<날짜>.json
```

### 이미지 업로드

```bash
# 2단계: --metadata로 EXIF 날짜를 폴더 경로에 반영
node scripts/upload-images.js <이미지경로들> --metadata tmp/metadata-<날짜>.json --slug <슬러그>
```

`--metadata` 또는 `--date`를 명시하지 않으면 (또는 metadata의 `primary_date`가 null이면) **업로드 전에 즉시 exit 5로 거부된다** (네트워크 호출 없이 fail-fast — 멱등성 보호).

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
# 슬러그를 EXIF 촬영일로 강제
node scripts/publish-post.js --post-id ID --slug-from-date tmp/metadata-<날짜>.json

# 또는 직접 지정
node scripts/publish-post.js --post-id ID --slug 2026-05-10
```

### Blogger 글 삭제

```bash
node scripts/delete-post.js --post-id ID
# 초안만 삭제:
node scripts/delete-post.js --post-id ID --draft-only
```

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
