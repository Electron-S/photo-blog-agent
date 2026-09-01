# Blog Output Format

블로그 초안을 만들 때 아래 JSON 형식으로 결과를 냅니다.

## JSON 스키마

```json
{
  "title": "한글 블로그 제목",
  "content_html": "Blogger 호환 HTML 본문",
  "labels": ["라벨1", "라벨2"],
  "summary": "발행 전 검토용 짧은 한글 요약",
  "fact_check_notes": ["확인이 필요한 사실 1", "확인이 필요한 사실 2"]
}
```

## 필드 설명

| 필드 | 설명 |
|------|------|
| `title` | 검색 가능한 핵심어와 상황이 담긴 한국어 제목 |
| `content_html` | Blogger 호환 HTML. `<figure>`, `<img>`, `<figcaption>` 구조 사용. 1,800~2,500자 목표 |
| `labels` | 5~10개 Blogger 라벨. 핵심 키워드 포함 |
| `summary` | 발행 전 사용자가 빠르게 검토할 수 있는 짧은 요약 |
| `fact_check_notes` | 확인이 필요한 사실, 변동 가능한 정보, 누락된 내용 |

## Rules

- JSON만 출력한다. Markdown 펜스나 주석 없이 단일 JSON 객체.
- 본문은 Blogger에 넣기 쉬운 HTML로 작성.
- 이미지 URL은 제공된 순서대로 삽입.
- 모든 이미지에 구체적인 alt text와 자연스러운 캡션을 붙인다. "사진 1" 같은 일반적 캡션은 금지.
- 확인되지 않은 장소 정보, 가격, 영업시간은 `fact_check_notes`에 표시.
- 외부 리뷰는 원문 복사 없이 요약.
- 광고 클릭 유도 문구는 넣지 않는다.