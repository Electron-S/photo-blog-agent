# Blog Draft Prompt

Use this as the first draft prompt. It is embedded by the Telegram blog bot, so
the output schema must match what the bot parses.

```text
Create a Korean Blogger draft from the provided data.

Inputs:
- User photos and photo analysis
- Public image URLs (webpUrl)
- Confirmed or candidate place information
- Internet research summary from official or trusted sources
- External review summary, if available
- User notes
- Photo EXIF metadata (date, GPS coordinates, camera) — use this to verify and enrich visit date and location
- Required SEO keywords

Return only one valid JSON object. Do not wrap it in Markdown fences.

Required JSON fields:
- title: Korean blog title
- content_html: full article body as Blogger-compatible HTML
- labels: 5-10 Blogger labels
- summary: short Korean summary for Telegram review
- fact_check_notes: uncertain claims or missing facts

Writing requirements:
- Write in Korean.
- The body should normally be 1,800-2,500 Korean characters.
- Use the user's photos as the main source of originality.
- Summarize external reviews without copying review text.
- Do not overstate personal experience.
- Mark unknown details as "확인 필요".
- Use official visit information naturally when available: address, access, parking, operating-hours caution, ticket/fee ranges, and event context.
- Treat hours, prices, promotions, and parking rules as dynamic; tell readers to check the official page before visiting.
- Make the post useful for someone deciding whether to visit.
- Avoid clickbait.
- Avoid ad-click encouragement.
- Use proper names for well-known landmarks and buildings visible in photos or near the visit location. "롯데타워", not "큰 건물". If the landmark name is uncertain, mark it as "확인 필요".
- Do not state obvious facts in a preachy tone. Information that readers already know should be woven in naturally, not presented as instruction.
- Insert images directly with Blogger-compatible <figure>, <img>, and <figcaption> HTML.
- Use provided WebP image URLs in order. All images are WebP format — use a plain <img> tag with the WebP URL as src.
- If a WebP URL is null or missing for an image, skip that image entirely rather than inventing a URL.
- Every image must have specific alt text and a natural caption. Do not use generic captions like "사진 1".
- Every <img> tag must include: loading="lazy", width, height, style="max-width:100%;height:auto;".
- Every <figure> tag must include: style="margin:1.5em 0;text-align:center;". This centers the image and caption.
- The width and height attributes on <img> must match the actual image dimensions (e.g., portrait photos might be 768x1024, landscape 1024x768). Do not use a fixed size for all images.
- After every image, include at least 2 sentences of text before the next image or section. This ensures ads and images are visually separated per AdSense policy.
- Keep total image payload under 1.5MB per page. Target each image under 150KB after compression.
- Do not output placeholder text such as "확인 필요: AI 초안 생성 결과" or "사진 리뷰 초안".
- If the available notes/photos are too thin for a good draft, still return valid JSON, but put the gap in fact_check_notes instead of inventing details.

EXIF and photo metadata:
- If EXIF date is available, use it as the visit date in the article. Override any user-provided date if EXIF is more precise.
- If EXIF GPS coordinates are available, use them to confirm or correct the place name and neighborhood context.
- If camera model is available, do NOT mention it in the article unless the user explicitly asks.

SEO labels:
- Generate 5-10 Blogger labels automatically from the research data and article content.
- Labels must include: region keyword (지역, 예: 잠실, 송파, 서울), place name (장소명, 예: 석촌호수, 서울랜드), category keyword (카테고리, 예: 산책, 카페, 맛집, 가족나들이), season/timing keyword (계절/시기, 예: 봄산책, 여름휴가), and companion keyword (동행, 예: 아들, 와이프, 가족) if applicable.
- Exclude duplicate or near-duplicate labels.
- Labels should match common Korean search terms for the place and activity.

Parking and visitor tips:
- Weave parking information and visitor tips into relevant paragraphs naturally. Do NOT create a separate "주차 안내" or "방문 팁" section.
- Parking details (free/paid, validation, tips) should appear near the beginning of the article where the reader is planning their visit, or in the closing section — not as a standalone info dump.
- Essential tips that affect the visit decision (e.g., "주말 주차장 만차", "예약 필수") should be mentioned naturally in context.

Menu and pricing:
- For restaurants, cafes, and bars: mention representative dishes and price ranges naturally in the article where relevant. Do NOT create a separate menu section.
- If menu details or prices change frequently, link to the official homepage or Naver Map instead of listing exact prices: "메뉴와 최신 가격은 공식 홈페이지에서 확인할 수 있다."
- Only include confirmed prices. Mark unconfirmed prices as "확인 필요".

Official website links:
- If the place has an official website or verified Naver Map listing, include a natural link in the article body using the text "공식 홈페이지" or "공식 페이지" or the website_display_name from research data.
- Place the link where it naturally fits — near practical information (hours, prices, parking) or in the closing section.
- Do not force links if no verified website exists.
- Use Blogger-compatible HTML for links: <a href="URL" target="_blank" rel="noopener noreferrer">link text</a>
```