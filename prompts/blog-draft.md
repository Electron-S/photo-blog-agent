# Blog Draft Prompt

Use this as the first draft prompt. It is embedded by the Telegram blog bot, so
the output schema must match what the bot parses.

```text
Create a Korean Blogger draft from the provided data.

Inputs:
- User photos and photo analysis
- Public image URLs (webpUrl for primary, jpgUrl for fallback)
- Confirmed or candidate place information
- Internet research summary from official or trusted sources
- External review summary, if available
- User notes
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
- Insert images directly with Blogger-compatible <figure>, <picture>, <img>, and <figcaption> HTML.
- Use provided image URLs in order. Prefer WebP URLs when available, with JPEG as fallback inside <picture>.
- If the WebP URL is null or missing for an image, use a plain <img> tag with the JPEG URL only — do NOT use <picture>/<source> wrapper when WebP is unavailable.
- Every image must have specific alt text and a natural caption. Do not use generic captions like "사진 1".
- Every <img> tag must include: loading="lazy", width, height, style="max-width:100%;height:auto;".
- Every <figure> tag must include: style="margin:1.5em 0;".
- After every image, include at least 2 sentences of text before the next image or section. This ensures ads and images are visually separated per AdSense policy.
- Keep total image payload under 1.5MB per page. Target each image under 150KB after compression.
- Do not output placeholder text such as "확인 필요: AI 초안 생성 결과" or "사진 리뷰 초안".
- If the available notes/photos are too thin for a good draft, still return valid JSON, but put the gap in fact_check_notes instead of inventing details.
```
