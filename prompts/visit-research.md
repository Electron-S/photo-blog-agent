# Visit Research Prompt

방문지 리서치 단계에서 사용하는 프롬프트입니다. 블로그 초안을 작성하기 전에 공식/신뢰 가능한 공개 정보를 구조화된 카테고리별로 수집합니다.

```text
Research the visit place for a Korean Blogger draft.

Use internet access if available. Prefer official venue websites, government/tourism pages, official maps, and venue notices. Do not use copied review text.

Return ONLY one valid JSON object. Do not wrap it in Markdown fences.

Required JSON shape (follow the visit-research.schema.json):
{
  "place_query": "검색에 사용한 장소명 또는 쿼리",
  "researched_at": "ISO 8601 타임스탬프",
  "place_info": {
    "name": "공식 명칭",
    "category": "카테고리 (공원/카페/맛집/전시/체험 등)",
    "address": "주소",
    "phone": "전화번호 또는 null",
    "website": "공식 홈페이지 URL 또는 null"
  },
  "access": {
    "public_transport": "가장 가까운 역/정류장, 노선, 출구, 도보 거리",
    "parking": "주차 가능 여부, 요금, 팁",
    "accessibility": "접근성 정보 (필요한 경우만, 없으면 생략)"
  },
  "cost_and_hours": {
    "operating_hours": "운영시간과 변동 가능성 안내",
    "ticket_or_fee": "입장료/요금 범위 (없으면 생략)",
    "promotions": "현재 프로모션 (있는 경우만, 없으면 생략)"
  },
  "nearby_landmarks": [
    {
      "name": "랜드마크/건물의 정확한 명칭",
      "relation": "방문지와의 관계 (보이는 위치, 도보 거리 등)",
      "description": "독자에게 왜 의미 있는지 한 줄 설명"
    }
  ],
  "neighborhood_context": {
    "area_name": "동네/지역 명칭",
    "known_for": "이 지역이 알려진 이유 (1-2문장)",
    "seasonal_notes": "계절적 특징이나 방문 시 참고사항 (없으면 생략)"
  },
  "visitor_tips": {
    "best_times": "방문하기 좋은 시간대",
    "common_routes": "일반적인 동선이나 추천 코스 (없으면 생략)",
    "crowd_levels": "혼잡도 정보"
  },
  "review_signals": {
    "common_positives": ["자주 언급되는 장점 (없으면 생략)"],
    "common_concerns": ["자주 언급되는 아쉬운 점 (없으면 생략)"],
    "overall_sentiment": "2-3문장 전체 평가 요약"
  },
  "sources": [
    {
      "title": "출처 제목",
      "url": "https://...",
      "source_type": "official|map|tourism|review-summary|other",
      "notes": "이 출처에서 사용한 정보"
    }
  ],
  "fact_check_notes": ["불확실하거나 변동 가능한 정보"]
}

Research categories and priorities:

1. place_info — 공식 명칭, 카테고리, 주소를 최우선으로 확인. 전화번호와 웹사이트는 공식 홈페이지에서 확인.

2. access — 대중교통 정보는 가장 가까운 역/정류장의 정확한 이름, 노선, 출구 번호, 도보 거리를 포함. 주차는 가능 여부, 요금, 팁을 간단히.

3. cost_and_hours — 운영시간은 변동 가능성을 반드시 언급. 입장료와 프로모션은 현재 기준으로 수집하되 변동 가능성을 명시.

4. nearby_landmarks — 방문지에서 보이거나 가까운 유명 건물, 랜드마크, 랜드마크급 시설의 정확한 명칭을 수집. 모호한 표현(예: "큰 건물", "높은 탑") 대신 공식 명칭(예: "롯데타워", "63빌딩")을 사용. 사진에 보일 가능성이 있는 랜드마크를 우선적으로 조사.

5. neighborhood_context — 그 동네나 지역이 어떤 곳인지, 무엇으로 알려져 있는지를 파악. 실제 다녀온 사람이 글을 쓸 때 자연스럽게 녹일 수 있는 배경 지식을 수집. 계절적 특징도 포함.

6. visitor_tips — 혼잡도, 추천 시간대, 일반적인 동선 등 실용 정보. 실제 방문객들이 공통으로 언급하는 패턴을 위주로.

7. review_signals — 외부 리뷰의 공통 패턴을 요약. 원문을 복사하지 않고 장점/단점의 경향과 전체 분위기만 파악. 리뷰 원문은 절대 복사하지 않는다.

Rules:
- Write in Korean.
- Follow the Photo Blog Agent style guide and system rules.
- Use official sources first: official website > government/tourism pages > map listings > review summaries.
- Treat operating hours, prices, promotions, and parking rules as dynamic. Add "방문 전 공식 페이지 확인" to fact_check_notes when appropriate.
- Identify well-known landmarks and buildings by their proper Korean names. "롯데타워", not "큰 건물". "63빌딩", not "높은 건물". If unsure, put the name in fact_check_notes.
- Do not invent a source or URL.
- If the place cannot be identified from the notes, return empty sources and explain in fact_check_notes.
- Keep the research compact. It supports the personal photo-based review, not replaces it.
- Optional fields (accessibility, ticket_or_fee, promotions, seasonal_notes, common_routes, common_positives, common_concerns) can be omitted when not applicable. Do not fill them with trivial or invented content.
```