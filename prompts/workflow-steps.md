# Photo Blog Agent — 워크플로우 정본

이 파일은 `/blog` 슬래시 커맨드(`.claude/commands/blog.md`)와 자연어 진입
에이전트(`.claude/agents/blog-agent.md`)가 **공유하는 단일 정본**입니다.

두 진입점이 각자 Step 1~7을 복제해 갖고 있던 시절에는 `tmp/incoming` 스캔,
width/height 확인, session-state 스키마, exit 코드 안내 등 5곳이 서로 어긋나
어느 쪽으로 들어오느냐에 따라 동작이 달라졌습니다. 워크플로우를 바꿀 때는
**이 파일만** 고치세요.

진입점 파일에는 진입 방식에 고유한 것(frontmatter, tmp 스캔 명령, 첫 응답 분기,
`$ARGUMENTS` 처리)만 남깁니다.

---

## 워크플로우 (발행 외에는 자연어로 자동 진행)

각 단계가 끝나면 짧은 진행 보고("EXIF 추출 끝났어요. 방문 날짜는 ○월 ○일이네요." 정도)만 하고 바로 다음 단계로 넘어갑니다.

### Step 1 — 사진 수집

- `tmp/pending-batch/`의 사진(진입점이 자동 스캔) + 사용자가 명시한 경로를 합쳐 처리 대상을 확정합니다.
- 같은 파일이 중복되면 한 번만 처리합니다.
- 사진이 한 장도 모이지 않으면 사용자에게 경로를 다시 묻습니다. 진행을 강행하지 않습니다.

### Step 2 — EXIF 추출

```bash
node /home/cyyoo/develop/photo-blog-agent/scripts/extract-exif.js <사진들> --output /home/cyyoo/develop/photo-blog-agent/tmp/metadata-<오늘날짜>.json
```

- 출력 JSON을 Read해서 `primary_date`, `primary_date_source_count`, `gps_center`, `date_range`를 확인합니다.
- **`primary_date`가 null**이면 사용자에게 "사진 EXIF에 날짜가 없어요. 언제쯤 다녀오신 거예요? (예: 2026-05-09)" 질문 후 답을 받아 `--date`로 명시할 준비를 합니다.
- **`primary_date_source_count / 전체 사진수 < 0.5`**면 신뢰도 낮음 — 사용자에게 "사진 절반 정도만 같은 날짜 EXIF가 있어요. 방문일이 ○월 ○일 맞나요?" 확인합니다.
- exit 코드: 2(`--output` 쓰기 실패), 3(지원 이미지 없음) → 원인 진단 후 사용자에게 보고. 우회 금지.

### Step 2.5 — 사진 시각 분석 (영속화)

EXIF만으로는 부족한 장면·간판·메뉴판 정보를 디스크로 영속화해, 다른 세션·다른 모델이 그대로 재사용하게 만듭니다.

```bash
node /home/cyyoo/develop/photo-blog-agent/scripts/analyze-photos.js <사진들> \
  --output /home/cyyoo/develop/photo-blog-agent/tmp/photo-analysis-<오늘날짜>.json
```

이 스크립트는 시각 분석을 직접 하지 않고 **빈 JSON 골격만 디스크에 씁니다**. 채우는 것은 실행 중인 당신(모델)의 몫입니다.

1. 출력된 `photo-analysis-*.json`을 Read해 골격을 확인합니다.
2. 첫 번째 사진을 Read 도구로 열어봅니다.
3. **시각 정보가 보이면** (비전 가능 모델):
   - 각 사진을 Read해서 `scene_description`(1~2문장), `text_visible`(간판/메뉴판/표지판 텍스트), `notable_objects`(눈에 띄는 사물), `people_count` 등을 Edit으로 채웁니다.
   - 모든 photo entry의 `analysis_status`를 `"completed"`로 갱신합니다.
   - 최상위에 `analyzed_at`(ISO 8601 +09:00), `analyzed_by_model_capability: "vision"`, `overall_impression`(전체 분위기 한두 문장) 채웁니다.
4. **첫 사진 Read에서 시각 정보가 없거나 이미지를 보지 못한다고 판단되면** (텍스트 전용 모델):
   - 나머지 사진은 Read하지 않습니다.
   - 모든 photo entry의 `analysis_status`를 `"skipped_no_vision"`으로 갱신합니다.
   - 최상위에 `analyzed_by_model_capability: "text-only"`, `overall_impression: "Vision not available — caption/EXIF only"`로 표시합니다.
5. 이미 채워진 `photo-analysis-*.json`(`analyzed_by_model_capability`가 null이 아님)을 발견하면 **다시 Read하지 말고 그대로 사용**합니다. 다른 세션이 이미 채워뒀을 수 있습니다.

exit 코드: 2(`--output` 쓰기 실패), 3(지원 이미지 없음) → EXIF 추출과 동일하게 root cause 진단.

### Step 3 — 이미지 업로드 (멱등성 핵심)

**한 세션에서 slug는 딱 한 번만 정합니다.** 한 번 정한 slug를 모든 후속 호출(업로드, 초안 작성)에서 동일하게 씁니다. 다른 slug로 재호출하면 중복 폴더가 생성되어 깨집니다.

```bash
node /home/cyyoo/develop/photo-blog-agent/scripts/upload-images.js <사진들> \
  --metadata /home/cyyoo/develop/photo-blog-agent/tmp/metadata-<오늘날짜>.json \
  --slug <영문-슬러그>
```

- slug는 영문/숫자/하이픈만. 장소·테마를 짧게 (예: `seokchon-lake-spring`, `omurice-jamsil`).
- exit 5 (날짜 출처 미상)가 나면 metadata의 `primary_date`가 null이라는 뜻 — Step 2 결과를 다시 확인하거나 `--date YYYY-MM-DD`를 추가해 재시도. 멱등성 보호이므로 우회하지 않습니다.
- exit 4 (품질 저하: fallback/oversize/치수 결손)는 경고로만 기록하고 진행. AdSense 기준(150KB) 초과나 `summary.missingDimensions > 0`이면 사용자에게 알립니다.
- 업로드 결과 JSON의 `images[]`에서 `webpUrl`과 **`width`/`height`를 그대로 받아 둡니다.** 초안의 `<img>`에 이 값을 옮겨 적습니다. `null`이면 추측하지 말고 그 이미지를 빼거나 사용자에게 보고합니다.
- `--output tmp/upload-<slug>.json`을 함께 지정하면 결과가 파일로 남아 이후 단계에서 재사용할 수 있습니다.

**Step 3 종료 시 — session-state 첫 생성**: slug가 확정되었으므로 CLI로 상태를 만듭니다. **JSON을 직접 Write하지 마세요** — `steps_remaining`은 스크립트가 항상 재계산하며, 손으로 쓰면 두 배열이 어긋나 재개가 조용히 깨집니다.

```bash
node /home/cyyoo/develop/photo-blog-agent/scripts/session-state.js init \
  --slug <slug> \
  --primary-date <metadata의 primary_date> \
  --metadata-path tmp/metadata-<날짜>.json \
  --analysis-path tmp/photo-analysis-<날짜>.json \
  --upload-result-path tmp/upload-<slug>.json

node /home/cyyoo/develop/photo-blog-agent/scripts/session-state.js update \
  --slug <slug> --complete exif,photo_analysis,upload
```

- `primary_date`가 null이면 `--primary-date`를 생략합니다.
- 이미 파일이 있으면 `init`은 덮어쓰지 않고 현재 상태를 출력하며 exit 0으로 끝납니다 (재실행이 진행 상태를 날리지 않습니다).
- exit 9는 상태 파일 손상 — 원본은 보존되므로 파일을 열어 원인을 확인하고 사용자에게 보고합니다.

### Step 4 — 방문지 리서치

`/home/cyyoo/develop/photo-blog-agent/prompts/visit-research.md`를 Read해 규칙을 따릅니다. 핵심:

- GPS 좌표(`gps_center`) + 사용자 메모로 장소를 식별합니다.
- 우선순위: **공식 홈페이지 → 네이버/카카오 지도 → 한국관광공사 → 일반 구글 검색**.
- 식당/카페는 대표 메뉴와 가격대, 그 외 장소는 운영시간·주차·이벤트.
- 장소가 모호하면 "여기 ○○ 맞나요?" 사용자에게 확인. 단정해서 쓰지 않습니다.
- 출처 없는 가격/시간은 **"확인 필요"**로 표기하거나 본문에서 빼고 `fact_check_notes`에 남깁니다.
- `tmp/photo-analysis-<날짜>.json`을 Read해서 사진 속 간판·메뉴판 텍스트를 장소 식별의 단서로 활용합니다 (Step 2.5에서 비전 모델이 이미 채워둔 경우).

### Step 5 — 초안 작성

다음 세 파일을 **반드시 Read한 뒤** 규칙을 따릅니다:
- `/home/cyyoo/develop/photo-blog-agent/prompts/blog-draft.md` (출력 스키마·EXIF 규칙·이미지 HTML 규칙)
- `/home/cyyoo/develop/photo-blog-agent/prompts/style-guide.md` (한국어 톤·문단 분리·h3 부제목 규칙)
- `/home/cyyoo/develop/photo-blog-agent/prompts/system-rules.md` (AdSense 정책·팩트체크)

작성 시 절대 규칙:

- **방문 날짜 = EXIF `primary_date`**. 글 작성 시점(오늘)과 절대 혼동 금지. "오늘 다녀왔다" 금지, "지난 ○월 ○일", "○월 초" 등.
- `primary_date`가 null이거나 신뢰도 낮으면 "최근", "얼마 전" 등 모호 표현 사용 + `fact_check_notes`에 기록.
- 이미지: WebP `<img>` 직접 사용 (`<picture>` 래퍼 X), `<figure style="margin:1.5em 0;text-align:center;position:relative;">`로 감쌈. `<img>`에 `loading="lazy"`, `width`, `height`(실제 치수), `style="max-width:100%;height:auto;"` 필수.
- 이미지 직후에 `<h3>` 금지 (AdSense 정책). 이미지와 다음 이미지/광고 사이 2문장 이상 텍스트.
- 모든 `<figure>`에 자연스러운 `<figcaption>`. "사진 1" 같은 generic 금지.
- 본문은 1,800~2,500자, 단락(p) 2~4문장. 1,500자 이상이면 `<h3>` 3개 이상.
- SEO 라벨은 5~10개: 지역+장소명+카테고리+계절+동행 조합.

작성 절차:

1. `tmp/photo-analysis-<날짜>.json`을 Read해서 채워진 `scene_description`·`text_visible`·`notable_objects`를 본문 묘사에 활용합니다 (`analyzed_by_model_capability`가 `"text-only"`면 EXIF·캡션만으로 진행).
2. HTML 본문을 `/home/cyyoo/develop/photo-blog-agent/tmp/draft-<slug>.html`로 Write.
3. **초안을 lint로 자가 검증합니다** (Blogger에 올리기 전에 오프라인으로 끝냅니다):
   ```bash
   node /home/cyyoo/develop/photo-blog-agent/scripts/lint-draft.js \
     /home/cyyoo/develop/photo-blog-agent/tmp/draft-<slug>.html \
     --upload-result /home/cyyoo/develop/photo-blog-agent/tmp/upload-<slug>.json \
     --format json
   ```
   - exit 8이면 `errors[]`를 전부 읽고 `tmp/draft-<slug>.html`을 Edit으로 고친 뒤 **통과할 때까지 반복**합니다.
   - `warnings[]`는 차단하지 않지만, 문체 관련 지적이므로 가능하면 함께 고칩니다.
   - `stats.bodyChars`가 1,800 미만이면 내용을 늘립니다. **캡션을 늘려서 채우지 마세요** — 글자수는 figcaption·alt를 제외하고 셉니다.
   - `img-dimensions-match`가 뜨면 업로드 결과 JSON의 `width`/`height`를 그대로 옮겨 적습니다.
4. 제목·라벨을 정함.
5. Blogger 초안 등록 (여기서도 lint가 한 번 더 돌아 exit 8로 차단합니다):
   ```bash
   node /home/cyyoo/develop/photo-blog-agent/scripts/create-draft.js \
     --title "제목" \
     --content /home/cyyoo/develop/photo-blog-agent/tmp/draft-<slug>.html \
     --labels "라벨1,라벨2,..." \
     --upload-result /home/cyyoo/develop/photo-blog-agent/tmp/upload-<slug>.json
   ```
6. 응답에서 받은 `post-id`를 잘 기억해 둡니다 (이후 update/publish에 필요).
7. **session-state 갱신**:
   ```bash
   node /home/cyyoo/develop/photo-blog-agent/scripts/session-state.js update \
     --slug <slug> --complete research,draft \
     --draft-path tmp/draft-<slug>.html --post-id <ID>
   ```
8. 사용자에게 초안 요약(제목, 라벨, fact_check_notes 핵심)을 보여줍니다.

### Step 6 — 수정 루프

사용자가 자연어로 수정을 요청하면:

1. `tmp/draft-<slug>.html`을 Edit으로 수정 (전체 재생성 X — 차이만).
2. 같은 post-id로 업데이트:
   ```bash
   node /home/cyyoo/develop/photo-blog-agent/scripts/update-post.js \
     --post-id <ID> \
     --content /home/cyyoo/develop/photo-blog-agent/tmp/draft-<slug>.html
   ```
3. `--labels`는 생략해서 기존 라벨이 보존되도록 합니다. 라벨까지 바꾸려는 경우에만 명시.
   - `update-post.js`도 `--content`를 줄 때는 lint를 돌립니다. exit 8이면 본문을 고치고 재시도합니다.
4. 사용자가 명시적으로 "발행해줘", "OK 발행", "올려줘" 등 발행 의사를 표명할 때까지 이 단계 반복.

### Step 7 — 발행 (사용자 OK 필수)

수정이 마무리되면 한 번 명시적으로 확인합니다:

> "초안 확인 끝나셨으면 발행해드릴까요? URL 슬러그는 사진 촬영 날짜인 `YYYY-MM-DD.html` 형식으로 고정됩니다."

사용자가 OK를 주면:

```bash
node /home/cyyoo/develop/photo-blog-agent/scripts/publish-post.js \
  --post-id <ID> \
  --slug-from-date /home/cyyoo/develop/photo-blog-agent/tmp/metadata-<오늘날짜>.json
```

- `primary_date`가 null이면 위 명령이 실패합니다. 사용자에게 받은 날짜로 `--slug YYYY-MM-DD`로 직접 명시합니다.
- **session-state 마무리**:
  ```bash
  node /home/cyyoo/develop/photo-blog-agent/scripts/session-state.js update \
    --slug <slug> --complete publish --post-url <발행된 URL>
  ```
- 발행 결과 URL을 사용자에게 보여주고 모드를 마칩니다.

## 핵심 규칙 (모든 단계에서 항상)

1. **방문 날짜 ≠ 작성 날짜**: EXIF `primary_date`만 방문 날짜. 환경의 "Today's date"는 글 시점일 뿐 본문에 쓰지 않습니다.
2. **추측 금지**: 장소·날짜·메뉴·가격에 확신이 없으면 사용자에게 질문하거나 "확인 필요"로 표기. 만들어내지 않습니다.
3. **slug 멱등성**: 세션 내 한 번 정한 slug 유지. upload-images / draft 파일명 모두 같은 slug 사용.
4. **사용자 OK 없이 발행 금지**: 수정·업데이트는 자동, 발행만은 명시적 동의 필요.
5. **exit 코드 우회 금지**: exit 2/3/4/5/6/7/8은 모두 root cause가 있는 신호입니다. `--no-verify`나 임의 fallback 사용 금지. 특히 **exit 8(lint 위반)은 우회 플래그가 아예 없습니다** — 본문을 고치는 것이 유일한 해결입니다.
6. **사진이 한 장도 없으면 진행 안 함**: 글의 원본성은 사진에서 나옴. 텍스트만으로 글을 만들지 않습니다.
7. **시각 분석은 영속화**: Step 2.5 직후 `tmp/photo-analysis-<날짜>.json`을 채우면, 같은 글의 다음 세션/모델이 그 내용을 그대로 읽어서 사용한다. 이미 `analyzed_by_model_capability`가 채워진 파일은 다시 Read해서 재분석하지 않는다.
8. **세션 상태는 slug 단위, 갱신은 반드시 CLI로**: Step 3 이후 모든 단계 종료 시 `scripts/session-state.js update`로 상태를 갱신해 중단 지점부터 재개 가능하게 둔다. **JSON을 Write 도구로 직접 쓰지 않는다** — `steps_completed`/`steps_remaining` 두 배열을 손으로 동기화하면 하나만 틀려도 재개가 조용히 깨진다. 모드 진입 시 상태가 있으면 사용자에게 이어 진행 여부를 묻는다.

## 사진 입력 누적 처리

워크플로우 중간에 사용자가 사진을 추가로 전달하면:

- 이미 EXIF 추출/업로드 전이라면 그냥 새 사진을 처리 대상에 합칩니다.
- 이미 업로드까지 끝난 상태라면 사용자에게 "초안에 추가하시겠어요? 그러면 같은 slug로 다시 업로드하고 본문에 합칩니다." 확인. OK면 같은 slug로 upload-images 재호출 후 차이만 본문에 반영하고 update-post.
