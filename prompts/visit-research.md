# Visit Research Prompt

방문지 리서치 단계에서 사용하는 프롬프트입니다. 블로그 초안을 작성하기 전에 공식/신뢰 가능한 공개 정보를 구조화된 카테고리별로 수집합니다.

```text
Research the visit place for a Korean Blogger draft.

Use internet access if available. Prefer official venue websites, government/tourism pages, official maps, and venue notices. Do not use copied review text.

For Korean venues, use these sources in priority order:
1. Official website (홈페이지)
2. Naver Map / Naver Search (네이버 지도, 네이버 검색)
3. Kakao Map (카카오맵)
4. Korea Tourism Organization (대한민국구석구석, 한국관광공사)
5. Google Maps / Google Search
6. Review summaries from Naver Blog / Tistory

If the official website is unavailable or lacks detail, actively search Naver Map listings, Kakao Map, and government tourism pages. Do not give up after checking only the official site. Korean local businesses often have more complete information on Naver than on their own websites.

For restaurants, cafes, and bars (식당, 카페, 주점 카테고리):
- Collect menu highlights, representative dishes, and price ranges from Naver Map or the official menu page.
- If exact prices cannot be confirmed, provide approximate ranges and mark them as "확인 필요".
- Note reservation policies, wait times, and whether online booking is available.
- If the menu is extensive or prices change frequently, provide the official website or Naver Map link for readers to check current information.

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
    "website": "공식 홈페이지 URL 또는 null",
    "website_display_name": "본문 링크에 표시할 짧은 이름 (예: '석촌호수 공식 페이지') 또는 null"
  },
  "access": {
    "public_transport": "가장 가까운 역/정류장, 노선, 출구, 도보 거리",
    "parking": {
      "available": "가능/불가/제한적",
      "type": "무료/유료/매장 이용 시 무료 등",
      "details": "수용 대수, 운영 시간, 요금 상세 등",
      "validation_available": true,
      "tips": "주차 꿀팁 (무료 시간대, 인근 저렴 주차장 등)"
    },
    "accessibility": "접근성 정보 (필요한 경우만, 없으면 생략)"
  },
  "cost_and_hours": {
    "operating_hours": "운영시간과 변동 가능성 안내",
    "ticket_or_fee": "입장료/요금 범위 (없으면 생략)",
    "promotions": "현재 프로모션 (있는 경우만, 없으면 생략)"
  },
  "menu_and_pricing": {
    "signature_dishes": [
      { "name": "메뉴명", "price_range": "가격 범위 또는 null", "note": "한 줄 설명 또는 null" }
    ],
    "average_price_per_person": "1인 평균 가격 범위 또는 null",
    "reservation_policy": "예약 필요 여부와 방법 또는 null"
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
    "crowd_levels": "혼잡도 정보",
    "parking_tips": "주차 관련 꿀팁 (무료 시간대, 인근 저렴 주차장, 주차장 혼잡 시간대 등)",
    "essential_info": ["방문 전 반드시 알아야 할 핵심 정보"]
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

1. place_info — 공식 명칭, 카테고리, 주소를 최우선으로 확인. 전화번호와 웹사이트는 공식 홈페이지에서 확인. website_display_name은 본문에서 링크를 걸 때 사용할 짧은 이름(예: "서울랜드 공식 티켓요금", "석촌호수 공식 페이지").

2. access — 대중교통 정보는 가장 가까운 역/정류장의 정확한 이름, 노선, 출구 번호, 도보 거리를 포함. 주차는 구조화된 정보로 제공: 가능 여부, 무료/유료 구분, 매장 이용 시 무료/할인 여부, 구체적인 팁. 주차 정보는 실용적이어야 한다 — 몇 대까지 가능한지, 무료 시간대가 있는지, 인근 대체 주차장이 있는지 등.

3. cost_and_hours — 운영시간은 변동 가능성을 반드시 언급. 입장료와 프로모션은 현재 기준으로 수집하되 변동 가능성을 명시.

4. menu_and_pricing — 카테고리가 식당/카페/주점일 때만 작성. 다른 카테고리면 null. 대표 메뉴, 1인 평균 가격대, 예약 정책을 수집. 정확한 가격을 확인할 수 없으면 "확인 필요"로 표시. 메뉴와 가격이 자주 바뀌는 곳은 공식 홈페이지나 네이버 지도 링크로 안내할 수 있도록 website_display_name도 제공.

5. nearby_landmarks — 방문지에서 보이거나 가까운 유명 건물, 랜드마크, 랜드마크급 시설의 정확한 명칭을 수집. 모호한 표현(예: "큰 건물", "높은 탑") 대신 공식 명칭(예: "롯데타워", "63빌딩")을 사용. 사진에 보일 가능성이 있는 랜드마크를 우선적으로 조사.

6. neighborhood_context — 그 동네나 지역이 어떤 곳인지, 무엇으로 알려져 있는지를 파악. 실제 다녀온 사람이 글을 쓸 때 자연스럽게 녹일 수 있는 배경 지식을 수집. 계절적 특징도 포함.

7. visitor_tips — 혼잡도, 추천 시간대, 일반적인 동선 등 실용 정보. parking_tips는 주차와 관련된 구체적인 꿀팁(무료 시간대, 인근 저렴 주차장, 피해야 할 시간대 등). essential_info는 방문 전 반드시 알아야 할 핵심 정보(예: "주말 주차장 만차", "예약 필수", "마감 1시간 전 입장 마감"). 실제 방문객들이 공통으로 언급하는 패턴을 위주로.

8. review_signals — 외부 리뷰의 공통 패턴을 요약. 원문을 복사하지 않고 장점/단점의 경향과 전체 분위기만 파악. 리뷰 원문은 절대 복사하지 않는다.

Rules:
- Write in Korean.
- Follow the Photo Blog Agent style guide and system rules.
- Use official sources first: official website > Naver Map/Kakao Map > government/tourism pages > Google Maps > review summaries.
- When the official website is unavailable or lacks detail, search Naver Map and Kakao Map for Korean local businesses. These often have more complete and up-to-date information than official websites.
- Treat operating hours, prices, promotions, and parking rules as dynamic. Add "방문 전 공식 페이지 확인" to fact_check_notes when appropriate.
- Identify well-known landmarks and buildings by their proper Korean names. "롯데타워", not "큰 건물". "63빌딩", not "높은 건물". If unsure, put the name in fact_check_notes.
- Do not invent a source or URL.
- If the place cannot be identified from the notes, return empty sources and explain in fact_check_notes.
- Keep the research compact. It supports the personal photo-based review, not replaces it.
- Optional fields (accessibility, ticket_or_fee, promotions, seasonal_notes, common_routes, common_positives, common_concerns, menu_and_pricing) can be omitted when not applicable. Do not fill them with trivial or invented content.
- menu_and_pricing is required when category is 식당, 카페, 주점, or any food/beverage category. Set it to null for other categories.
```