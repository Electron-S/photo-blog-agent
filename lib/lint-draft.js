/**
 * 초안 HTML 정적 검증 — 외부 의존성 0, I/O 없음, process.exit 없음.
 *
 * prompts/{style-guide,system-rules,blog-draft}.md 와 CLAUDE.md에만 존재하던
 * 규칙을 실행되는 계약으로 승격한다. lib/verify-images.js와 같은 모양이다:
 * 여기는 순수 함수, scripts/lint-draft.js가 CLI 껍데기.
 *
 * ## 본문 글자수의 정본 정의
 *
 *   bodyChars = figcaption 서브트리 제외
 *             + script/style 서브트리 제외 (이미지 보호 CSS/JS가 분량으로 세이지 않게)
 *             + alt/속성 제외 (애초에 텍스트가 아님)
 *             + 태그 제외
 *             + HTML 엔티티 디코드
 *             + 연속 공백 1칸으로 정규화
 *             후, **공백을 포함한** 코드포인트 수
 *
 * 이 정의로 실제 초안 6건이 1396 / 2018 / 2148 / 2356 / 2372 / 2992 로 계량된다.
 * 6건 중 4건이 1,800~2,500 안에 들고, 1396은 실제로 짧은 글(body-min-chars error),
 * 2992는 실제로 긴 글(body-max-chars warn)이라 기준선이 실측과 어긋나지 않는다.
 * figcaption을 포함하면
 * "캡션만 길게 써서 1,800자 채우기"가 가능해지는데, 그건 AdSense가 요구하는
 * "페이지 주제를 판별할 수 있는 본문"이 아니다.
 *
 * 투명성을 위해 stats에 bodyChars와 charsIncludingCaptions를 둘 다 내보낸다.
 */

const {
  ancestors, elementChildren, findAll, getAttr, lineOf,
  flatElementChildren, followingSiblings, parseHtml, textOf, walk,
} = require('./html-parse');
const {
  countChars, countSentences, decodeEntities, findDecorativeArrows, findEmoji,
  normalizeWhitespace,
} = require('./korean-text');
const { errFull } = require('./err-text');

const MIN_BODY_CHARS = 1800;
const MAX_BODY_CHARS = 2500;
const H3_THRESHOLD_CHARS = 1500;
const MIN_H3_WHEN_LONG = 3;
const MIN_SENTENCES_AFTER_FIGURE = 2;
const MAX_P_CHARS = 250;
// **하한을 두지 않는다.** `prompts/style-guide.md`가 "짧은 한두 문장 단락과 조금
// 긴 단락을 번갈아 두면 호흡이 자연스러워진다"고 **명시적으로 권장**하는데,
// 하한 2가 그 권장을 따른 단락에 warn을 냈다 (실초안 draft-pancake-house에서 2건).
// 가이드의 실질 기준은 같은 파일의 "5문장 이상"이므로 상한만 남긴다.
const MAX_P_SENTENCES = 4;

// 정확 문자열만 차단한다. `확인 필요`는 system-rules.md가 *권장*하는 표기라
// 부분 매치로 잡으면 프롬프트가 요구한 올바른 동작을 lint가 막는 정면 충돌이 난다.
const PLACEHOLDERS = ['확인 필요: AI 초안 생성 결과', '사진 리뷰 초안'];

// CLAUDE.md의 절대 규칙("오늘 다녀왔다 같은 표현 금지")을 강제하는 유일한 게이트다.
//
// **열거하지 않는다.** 예전에는 `/오늘\s*(다녀|방문|갔|들렀)/` 같은 리터럴 조합
// 세 개여서, 조사 하나만 끼거나 어미가 살짝 달라도 전부 통과했다 (실측):
//   "오늘은 다녀왔습니다" · "오늘 아침 다녀왔습니다" · "오늘 가봤습니다"
//   "오늘 들러봤습니다" · "어제 다녀왔습니다" · "이번 주말에 다녀왔습니다"
// → **시제 지시어**와 **방문 동사**를 분리해 근접 매칭한다. 사이에 부사·조사가
//   끼어도 잡히고, 새 어미가 나오면 동사 목록에 한 줄만 추가하면 된다.
//
// "방금"을 그대로 금칙어로 두면 "방금 튀겨낸 치킨텐더" 같은 정당한 표현을 막는다.
// 잡으려는 건 작성 시점을 방문 시점으로 혼동한 표현이지 부사가 아니므로,
// 방문 동사가 **근처에 있을 때만** 잡는다.
const WRITING_TIME_WORDS = [
  '오늘', '어제', '그제', '방금', '조금 전', '아까', '지금', '이번 주', '이번 주말', '금일',
];
// 방문을 뜻하는 동사 어간. 어미(-았/-왔/-어/-봤/-습니다)는 뒤에 붙으므로 여기 없다.
//
// 맨 '왔'은 넣지 않는다 — "방금 튀겨낸 치킨텐더가 **나왔다**"처럼 방문과 무관한
// 동사에 걸려 정당한 음식 묘사를 차단한다. '찾았'/'찾아갔'도 뺐다 — "아까 본
// 그 가게를 다시 **찾았다**"의 지배적 의미는 '발견'이지 '방문'이 아니다.
// 방문이 명확한 어간만 넣는다.
const VISIT_VERB_STEMS = [
  '다녀', '방문', '갔', '가봤', '가 봤', '들렀', '들러', '갔다 왔',
];
// 시제 지시어와 방문 동사 사이에 허용할 최대 거리. 한국어 어순상 부사구·조사·
// 짧은 종속절이 들어가므로 "오늘 날씨가 좋아서 공원에 갔다"(13자)까지 닿아야 한다.
const WRITING_DATE_GAP = 16;
const MAX_STEM_LEN = Math.max(...VISIT_VERB_STEMS.map((v) => v.length));

// 시제 지시어가 방문 동사를 **직접 수식할 때만** 잡는다.
//
// 열거(리터럴 조합)는 너무 좁아 조사 하나에 뚫렸고, 근접 매칭만으로는 너무 넓어
// 정당한 문장을 막았다 (실측 오탐: "지금 생각해보면 방문한 게", "이번 주 내내
// 비가 와서 못 갔다"). 이 규칙은 error이고 **우회 플래그가 없어** 오탐이 곧
// 발행 불가이므로, 아래 두 신호가 있으면 시제 지시어가 다른 서술어에 걸린
// 것으로 보고 넘긴다:
//   (1) **주절을 다른 서술어로 넘기는** 연결어미가 사이에 있다
//   (2) 동사 바로 앞에 부정어(못/안)가 있다 — 방문했다는 주장이 아니다
//
// **어느 어미를 넣느냐가 규칙의 생사를 가른다.** 처음에는 `-서/-고/-러/-려고`까지
// 넣었는데, 그 어미들은 앞 절을 **뒤 절에 종속시키므로** 주절 서술어가 곧 방문
// 동사다. 즉 가드가 정확히 잡아야 할 것을 면제했다 (실측 미탐):
//   "오늘 점심 먹으러 다녀왔습니다" · "아까 밥 먹고 다녀왔습니다"
//   "지금 막 도착해서 들렀습니다"   · "오늘 날씨가 좋아서 공원에 갔다"
// 게다가 음절만 보느라 **조사**까지 걸렸다 — `-에서`(처소격), `-하고`(공동격):
//   "오늘 부산에서 다녀왔습니다" · "어제 남편하고 다녀왔어요"
// 그리고 명사 "라**면**"의 마지막 음절에도 걸렸다.
//
// **가드는 오탐을 막을 때만 존치한다.** 이것이 이 규칙의 가드 존치 기준이다.
//
// 가드는 error가 정당한 문장을 차단하는 것(=발행 불가)을 막기 위해 있다. 어떤
// 가드가 오탐을 하나도 막지 않는다면, 그것이 하는 일은 **미탐을 만드는 것뿐**이고
// 미탐은 `writing-date-word`(warn)가 이미 덮는다. 그래서 가드를 늘릴 때는
// "이 가드가 막는 오탐이 실제로 있는가"를 계량해야 한다 — 문법적으로 그럴듯한지가
// 아니다. 열일곱 라운드가 왕복한 이유가 후자로 판단했기 때문이다.
//
// 계량 결과 (test/lint-draft.test.js의 코퍼스 + 신규 표면형 35종):
//   `면` 계열 — 오탐 2건을 막는다 ("지금 생각해보면 방문한 게 잘한 일이었다").
//               용언 활용형만 본다 (-으면/-하면/-되면/-보면/-아니면) — 그래야
//               "라면"·"사발면" 같은 명사에 걸리지 않는다. **존치.**
//   `는데`·`지만`·`니까` — 오탐 **0건**을 막고 미탐 **7건**을 만든다. 그 어미들이
//               있던 정당한 문장은 과거 표지 가드가 이미 통과시킨다. **제거.**
const CLAUSE_BREAK_RE = /(?:으면|하면|되면|보면|아니면)\s/;
const NEGATION_RE = /(?:못|안)\s*$/;
// 아직 하지 않은 방문은 작성 시점 혼동이 아니다.
//   "지금은 자리가 없어서 **다음에** 방문**하기로 했다**"
// 앞(다음에/나중에)과 뒤(-하기로/-할 예정/-하려고) 양쪽 신호를 본다.
const FUTURE_BEFORE_RE = /(?:다음에|나중에|언젠가|담에)\s*$/;
const FUTURE_AFTER_RE = /^(?:하기로|할\s*예정|하려고|해야|할까|하고\s*싶)/;

// ## 이 규칙이 세 라운드를 왕복한 이유와, 그것을 끝내는 방식
//
// 11차: 리터럴 열거 → 근접 매칭   (미탐 해결, 오탐 생성)
// 12차: 연결어미 축소 + 단어 경계  (오탐 해결, 미탐 생성)
// 13차: 경계를 `갔`에만            (미탐 해결)
//
// 원인은 개별 케이스가 아니라 **한 규칙에 두 일을 시킨 것**이다. "시제 지시어가
// 이 방문 동사를 수식하는가"는 형태소 분석 질문인데, 부분 문자열 매칭 + 차단
// 목록으로 답하려 했다. 한국어 표면형은 열거로 닫히지 않으므로, 넓히면 오탐이
// 나고 좁히면 미탐이 난다 — 왕복은 필연이었다.
//
// **끝내는 방식: 정밀함과 완전함을 등급으로 나눈다.**
//   - `no-writing-date-expression` (error) — 높은 확신만. 시제 지시어가 방문
//     동사를 **직접 수식**하는 형태. 오탐이 곧 발행 불가이므로 보수적으로 둔다.
//   - `writing-date-word` (warn) — 본문에 작성 시점 지시어가 **있기만 하면**
//     보고한다. 차단하지 않으므로 오탐 비용이 없고, error 규칙이 놓치는 형태를
//     아무도 열거하지 않아도 전부 표면화한다.
//
// 근거(실측): 실초안 6건에서 이 지시어는 **총 1건**만 나오고 그것도 방문 서술이
// 아닌 비유("오늘처럼 늦은 점심")다. prompts/*는 이 단어들을 쓰지 말라고만
// 지시한다. 즉 warn이 시끄러워질 여지가 거의 없다.
//
// 이제 "미탐"은 error 규칙의 실패가 아니라 **warn으로 보이는 상태**다. 새 표면형이
// 나타나도 조용히 LIVE로 나가지 않으므로, error 규칙을 넓힐 압력이 사라진다.

// 지시어가 시간 표현이 아닌 **고정 어구**의 일부인 경우.
//
// **이 목록은 error(정밀함) 쪽에 붙는다.** 14차에서 warn 쪽에 붙였는데 담당이
// 정확히 뒤바뀐 것이었다 — 결과는 실측으로 최악이었다:
//   "오늘의 추천 메뉴를 먹으러 방문했습니다" → error 차단(발행 불가) + warn 없음
// 정당한 문장이 막히고, 막힌 이유를 warn이 설명하지도 못했다.
// workflow-steps.md가 작성 모델에게 "고정 어구라면 무시해도 됩니다"라고 지시하는데
// 그 지시를 따른 초안이 발행 불가가 됐다.
const WRITING_TIME_LEXICALIZED = [
  '오늘의', '오늘날', '오늘처럼', '오늘 같은', '오늘따라',
  '어제오늘', '지금까지', '지금껏', '지금도', '지금의', '방금까지',
];

// 방문이 **작성 시점 이전**임을 명시한 표지. 이게 있으면 CLAUDE.md가 요구하는
// 정본 표현이다 — error 메시지가 안내하는 `"지난 ○월 ○일"`이 바로 이 형태다.
// 실측 오탐: "오늘은 지난달에 다녀온 카페를 정리해봅니다" → 발행 불가.
// 숫자+월/일은 과거 표지이지만, **계수(計數) 구성**일 때는 아니다:
//   과거 표지: "5월 10일 다녀온" · "5월 초에" · "3일 전에"
//   계수 구성: "3일 **만에**" · "5월 **들어**" · "2일**차**" · "4일 **연속**"
//
// 한때 `에`를 월/일 **직후에** 요구했다. 그러면 계수 구성은 배제되지만
// **이 프로젝트의 정본 표현이 전부 error로 차단된다** (실측 11종):
//   "오늘은 5월 10일 다녀온 카페 기록입니다"  ← blog-draft.md가 지시한 어구
//   "오늘은 5월 초 다녀온 …"                ← CLAUDE.md의 "○월 초"
//   "오늘은 3일 전에 다녀온 …" · "이틀 전에" · "일주일 전에" · "한 달 전에"
// prompts/*가 작성 모델에게 **쓰라고 지시한 어구**가 lint에 막히는 상태였고,
// 이건 15차에 "최악"으로 기록한 형태와 같다.
//
// 게다가 방향이 뒤집힌 교환이었다 — 그렇게 막은 미탐 4종은 이미
// `writing-date-word`(warn)가 전부 덮고 있어 조용히 LIVE로 나가지 않았다.
// 발행을 막는 error를 얻고 보이는 warn을 잃은 셈이다.
// → **계수 구성만 배제**한다. error는 계속 좁고, 미탐은 warn이 덮는다.
const PAST_MARKER_RE = new RegExp([
  '지난', '작년', '재작년', '예전', '그때', '그날', '저번',
  '며칠\\s*전', '\\d+일\\s*전', '\\d+달\\s*전', '\\d+주\\s*전', '\\d+년\\s*전',
  '(?:이틀|사흘|나흘|닷새|엿새|일주일|한\\s*달|두\\s*달|몇\\s*달)\\s*전',
  // 계수 구성이 뒤따르지 않는 월/일
  '\\d+월(?!\\s*들어)',
  '\\d+일(?!\\s*(?:만에|차|연속|간|째|권))',
].join('|'));

// warn은 **면제하지 않는다.** 완전함을 담당하므로, 고정 어구든 과거 표지든
// "지시어가 본문에 있다"는 사실 자체를 보고한다. 차단하지 않으니 비용은
// "확인해야 할 한 줄"뿐이고, error가 놓치는 형태가 조용히 통과하지 않는다.
function findWritingTimeWords(text) {
  const found = [];
  const seen = new Set();
  for (const word of WRITING_TIME_WORDS) {
    const at = text.indexOf(word);
    if (at === -1) continue;
    // `이번 주`와 `이번 주말`처럼 겹치는 지시어를 같은 자리에서 두 번 보고하지 않는다.
    if ([...seen].some((prev) => prev <= at && at < prev + 6)) continue;
    seen.add(at);
    found.push(text.slice(at, at + Math.min(24, text.length - at)));
  }
  return found;
}

// `방문` 뒤에 붙어 **방문 사실을 주장하는** 서술어. 명사 접두와 구별하기 위해
// 1음절 어간에는 활용 음절을 함께 요구한다 (위 isNounCompound 주석 참조).
const VISIT_PREDICATE_RE = new RegExp(`^\\s*(?:${[
  '했', '였',                                    // 명사 초성으로 안 나타남
  '하(?:러|려|시|신|는|다|고|면|지|자|겠|기|였|셨)',   // 방문하러/방문하는/방문하고
  '해(?:서|도|야|본|보|주|줬|봤|요|씀|어|였)',        // 방문해서/방문해도/방문해야
  '중(?:이|입|에|일)',                              // 방문 중이다/중입니다
  '이라', '이었', '이에', '이야', '입니', '이다',        // 계사: 첫방문이라/재방문입니다
].join('|')})`);

const VISIT_VERB_RE = new RegExp(VISIT_VERB_STEMS.join('|'), 'g');
const SENTENCE_END_RE = /[.!?\u0000]/;

// 시제 지시어 한 번에 대해 **사정거리 안의 모든 방문 동사**를 본다.
//
// 하나의 정규식으로 최단 매치만 보면, 앞쪽 후보가 가드에 걸렸을 때 같은 문장
// 뒤쪽의 진짜 위반을 놓친다 (실측: "오늘 안 갔다가 결국 다시 다녀왔습니다" —
// 부정어 skip이 뒤의 '다녀'를 삼켰다). 후보를 전부 검사한다.
function findWritingDateExpression(text) {
  for (const word of WRITING_TIME_WORDS) {
    let at = text.indexOf(word);
    while (at !== -1) {
      // 지시어가 고정 어구의 일부면 시간 표현이 아니다 — error는 차단하므로
      // 여기서 걸러야 한다 (warn은 완전함을 담당하니 그대로 보고한다).
      const lexicalized = WRITING_TIME_LEXICALIZED.some((lex) => {
        const start = Math.max(0, at - lex.length + 1);
        return text.slice(start, at + lex.length).includes(lex);
      });
      if (lexicalized) {
        at = text.indexOf(word, at + 1);
        continue;
      }
      const from = at + word.length;
      // 문장 경계를 넘어가지 않는다 — 다음 문장의 동사는 이 시제 지시어와 무관하다.
      const raw = text.slice(from, from + WRITING_DATE_GAP + MAX_STEM_LEN);
      const stop = raw.search(SENTENCE_END_RE);
      const window = stop === -1 ? raw : raw.slice(0, stop);

      VISIT_VERB_RE.lastIndex = 0;
      let v = VISIT_VERB_RE.exec(window);
      while (v) {
        const between = window.slice(0, v.index);
        // `방문`은 **명사 어근**이다. 방문했다는 주장이 되는 것은 서술어가 붙을
        // 때뿐이므로, 그것을 요구하지 않으면 명사 합성이 전부 차단된다 (실측 오탐:
        // "오늘 방문 예약은 마감", "오늘 기준 방문객이 많다", "지금 인기 방문 코스").
        // 13차가 `방문`의 경계 요구를 뺀 대가였다 — 미탐을 오탐으로 교환했을 뿐이다.
        //
        // 서술어 집합: 하-계열(방문했다/방문하러/방문해서) + 상(相) 명사 `중`
        // (방문 중이다) + 계사(첫방문이라/재방문이었다). 이 셋이 붙으면 방문
        // 사실을 주장하는 것이고, 그 밖(객/자/예약/코스/후기/판매)은 명사구다.
        // `다녀`·`갔`·`들렀`·`들러`는 그 자체로 용언 어간이라 이 검사가 필요 없다.
        //
        // **1음절 서술어를 그대로 두면 안 된다.** `\s*`가 공백까지 먹으므로
        // 그 음절로 시작하는 명사가 전부 "서술어가 붙었다"로 판정돼 error 차단된다.
        // 실측으로 두 차례 나왔다:
        //   `이`·`중` → 방문 이용/이력/이후/이유/이벤트, 방문 중간/중요/중단
        //   `하`·`해` → 방문 해설/하루권/하차/해외/하한선/하이라이트/하나
        // 둘 다 CLAUDE.md가 요구하는 "주차·이용 안내를 본문에 녹여라"와 충돌한다
        // (관람 시간·하차 지점·해설 프로그램은 이 장르의 상용 정보다).
        // → **활용 음절을 함께 요구한다.** `했`·`였`은 명사 초성으로 나타나지
        //    않으므로 1음절로 남겨도 안전하다.
        const isNounCompound = v[0] === '방문'
          && !VISIT_PREDICATE_RE.test(window.slice(v.index + v[0].length));

        // **경계는 `갔`에만 건다.**
        //
        // `갔`은 합성 이동동사의 뒷음절로 나타난다 — 내려**갔**/지나**갔**/
        // 넘어**갔**/돌아**갔**. 그것들이 창에 들어오면 정당한 문장이 error로
        // 막힌다 ("오늘 기준 가격이 조금 내려갔어요").
        //
        // 그런데 이 요구를 **모든 stem에 일괄 적용하면 정반대 사고**가 난다.
        // `방문`은 접두사가 붙어도 뜻이 같은 명사 어근이라 **재방문/첫방문**이
        // 통째로 샌다 — 카페·식당 재방문기가 이 프로젝트의 주 장르이고,
        // "오늘 재방문했습니다"는 이 규칙이 막아야 할 표현 그 자체다.
        // 오탐은 발행이 막혀 즉시 드러나지만 미탐은 **아무도 모르는 채 LIVE로
        // 나간다.** 오탐↔미탐을 반대 방향으로 교환한 셈이었다.
        //
        // 구두점도 경계로 인정한다. 그러지 않으면 `오늘,다녀왔습니다`나
        // 따옴표 뒤가 "공백이 우연히 있었는가"에 따라 갈린다.
        const needBoundary = v[0] === '갔';
        const boundaryOk = !needBoundary
          || v.index === 0
          || /[\s\p{P}]/u.test(window[v.index - 1]);
        const after = window.slice(v.index + v[0].length);
        if (boundaryOk
            && !isNounCompound
            && between.length <= WRITING_DATE_GAP
            && !CLAUSE_BREAK_RE.test(between)
            && !NEGATION_RE.test(between)
            && !FUTURE_BEFORE_RE.test(between)
            && !FUTURE_AFTER_RE.test(after)
            // 과거 표지가 사이에 있으면 방문 시점을 명시한 정본 표현이다
            && !PAST_MARKER_RE.test(between)) {
          return word + window.slice(0, v.index + v[0].length);
        }
        VISIT_VERB_RE.lastIndex = v.index + 1;
        v = VISIT_VERB_RE.exec(window);
      }
      at = text.indexOf(word, at + 1);
    }
  }
  return null;
}

// **본문 텍스트가 아닌 태그.** 글자수 계산과 "이미지 다음 문장" 계산이 **같은**
// 목록을 써야 한다. 갈려 있으면 한쪽에서 제외되는 텍스트가 다른 쪽에서 본문으로
// 세어져 규칙이 우회된다 (실측: script의 한국어 주석이 4문장으로 셈됨).
const NON_TEXT_TAGS = ['script', 'style'];
const NON_BODY_TAGS = [...NON_TEXT_TAGS, 'figcaption'];

// 숫자를 **요구하지 않는다.** 예전 패턴은 `\d+`가 필수라서 가장 제네릭한 형태인
// `사진`·`이미지`·`photo` 단독과 `사진 - 1`을 놓치고 `사진1`만 잡았다.
// 금칙 어구 **직후에 부정 표현**이 오면 그 어구를 주장하는 문장이 아니다.
// 부분 문자열 매칭의 한계로 실측 오탐이 났다:
//   "완벽한 날씨는 아니었습니다" · "최고의 선택은 아니었어요"
//   "수익형 블로그와는 무관합니다"
// warn 등급이라 차단은 아니지만, 시끄러운 warn은 무시당해 규칙이 무력해진다.
//
// **`없`·`않`은 면제 집합에서 뺐다.** 한국어에서 그 음절은 부정이 아니라 **강조의
// 관용 구성 요소**로 더 흔하다. 14자 창에 들어오면 과장 표현을 **강화하는** 문맥이
// 전부 면제됐다 (실측 7건):
//   "강력 추천, 후회 **없**을 겁니다" · "최고의 맛, 두말할 것 **없**습니다"
//   "완벽한 코스, 부족함이 **없**었다" · "광고 클릭 유도는 하지 **않**습니다"
// 이 세 규칙은 error/warn 2단 구조가 없는 **warn 단일 규칙**이라, 면제되면 신호가
// 0이 된다 — "면제는 error에, warn은 면제하지 않는다"는 설계 원칙이 여기엔
// 적용되지 않았다.
//
// 남긴 것은 **계사 부정**뿐이다. 그것들은 강조의 구성 요소로 쓰이지 않으므로
// 창을 넓혀도 강화 문맥("후회 없을 겁니다")이 면제되지 않는다 — 실측 확인.
// 조사구가 길게 끼는 정당한 부정까지 닿아야 한다:
//   "완벽한 하루라고 하기에는 아니었다" · "최고의 선택이라고 말하기는 좀 아니죠"
const NEGATED_AFTER_RE = /^[^.!?\u0000]{0,18}?(?:아니|아냐|아님|무관|말고)/;

function phraseHitsExcludingNegated(text, phrases) {
  return phrases.filter((phrase) => {
    let at = text.indexOf(phrase);
    while (at !== -1) {
      if (!NEGATED_AFTER_RE.test(text.slice(at + phrase.length))) return true;
      at = text.indexOf(phrase, at + 1);
    }
    return false;
  });
}

const GENERIC_CAPTION_RE = /^\s*(사진|photo|이미지|image|그림|figure)\s*[-–—.]?\s*\d*\s*[.。]?\s*$/i;
const MECHANICAL_H3 = ['총평', '메뉴 정보', '가격 정보', '주차 안내', '방문 팁'];
const OVERCLAIM = ['강력 추천', '완벽한', '최고의', '무조건 가야'];
const AI_TELLS = ['총평하자면', '개인적으로는', '방문해보시는 걸 추천드립니다', '깔끔한 분위기', '만족스러운 경험', '가성비가 좋다'];
const AD_MENTIONS = ['애드센스', 'adsense', '광고 클릭', '클릭해 주시면', '수익'];

const REQUIRED_IMG_STYLE = { 'max-width': '100%', height: 'auto' };
const CANONICAL_IMG_STYLE = 'max-width:100%;height:auto;';
const REQUIRED_FIGURE_STYLE = { margin: '1.5em 0', 'text-align': 'center', position: 'relative' };
const CANONICAL_FIGURE_STYLE = 'margin:1.5em 0;text-align:center;position:relative;';

// style="a: 1; b: 2" → { a: '1', b: '2' }.
// 공백 차이는 브라우저 관점에서 동일하므로 선언 집합으로 비교한다.
function parseStyle(value) {
  const out = Object.create(null);
  for (const decl of String(value || '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).trim().toLowerCase().replace(/\s+/g, ' ');
    if (k) out[k] = v;
  }
  return out;
}

function missingStyleDecls(value, required) {
  const got = parseStyle(value);
  return Object.entries(required)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${k}:${v}`);
}

function srcExtension(src) {
  return String(src || '').split(/[?#]/)[0].toLowerCase();
}

function photoIndexOf(src) {
  const m = /photo-(\d+)\.webp$/i.exec(srcExtension(src));
  return m ? Number(m[1]) : null;
}

// 매칭 폴백 키. 파일명만 쓰면 모든 포스트의 이미지가 photo-01.webp … 이므로
// **다른 포스트의 이미지도 항상 매칭된다**. 그러면 img-not-in-upload-result가
// 영원히 발동하지 않고, img-dimensions-match는 엉뚱한 사진과 대조해 오진한다.
// 폴더 세그먼트까지 포함해 `{postDir}/photo-NN.webp` 단위로 맞춘다.
// (경로 인코딩 차이는 이미 decoded 맵이 흡수한다.)
//
// 구분자로 `/`와 `\` 를 둘 다 본다. --local-only 산출물의 webpPath는 path.join으로
// 만들어져 Windows에서 `tmp\assets\<postDir>\photo-01.webp`가 되는데, `/`로만
// 나누면 전체가 한 세그먼트가 되어 전량 미매칭 → upload-result-no-match(error)로
// 차단된다. local-only 경로에서는 webpPath가 유일한 매칭 키다.
function tailKeyOf(src) {
  const clean = String(src || '').split(/[?#]/)[0];
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* 잘못된 이스케이프는 원본 유지 */ }
  const parts = decoded.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

// figure 다음부터 다음 figure/h3 전까지의 텍스트를 모은다.
// (형제 순회 — 텍스트 노드와 인라인 요소 모두 포함)
// figure 다음부터 다음 figure/h3 전까지의 텍스트를 모은다.
//
// **순수 래퍼를 넘어서 본다.** `fig.parent.children`만 훑으면
// `<div><figure/></div><p>세 문장…</p>` 이 0문장으로 판정돼, 규칙을 지킨 초안이
// error로 막힌다 (followingSiblings의 주석 참조).
function textAfterFigure(fig) {
  let acc = '';
  for (const n of followingSiblings(fig)) {
    if (n.type === 'element' && (n.tag === 'figure' || n.tag === 'h3' || n.tag === 'h2')) break;
    // **skip 목록은 bodyChars와 같아야 한다.** 갈려 있으면 한쪽에서 제외되는
    // 텍스트가 다른 쪽에서 본문으로 셈된다. 실측 사고 둘:
    //   - `<script>`의 한국어 주석이 "이미지 다음 4문장"으로 세어져 **본문 없이**
    //     text-after-figure(error)를 통과했다. CLAUDE.md가 삽입을 권하는
    //     blogger-image-protection.html이 정확히 그 모양이다.
    //   - 평탄화로 figcaption이 **루트**로 올라오면 textOf의 skip이 걸러주지
    //     않는다 (`n !== node` 조건 때문에 루트 자신은 skip 대상이 아니다) —
    //     style-guide가 금지한 "캡션으로 분량 채우기"가 열렸다.
    if (n.type === 'element' && NON_BODY_TAGS.includes(n.tag)) continue;
    acc += n.type === 'text' ? n.value : textOf(n, NON_BODY_TAGS);
  }
  return acc;
}

// figure 바로 다음의 요소 — 래퍼를 넘어서 본다.
function nextContentElement(fig) {
  for (const n of followingSiblings(fig)) {
    if (n.type === 'element') return n;
    if (n.type === 'text' && n.value.trim()) return null;   // 사이에 내용이 있다
  }
  return null;
}

function buildContext(html, options) {
  const { root, errors: parseErrors, source } = parseHtml(html);

  const images = findAll(root, 'img');
  const figures = findAll(root, 'figure');
  const h3s = findAll(root, 'h3');
  const paragraphs = findAll(root, 'p');

  // script/style을 제외한다. 제외하지 않으면 CLAUDE.md가 권장하는 이미지 보호
  // CSS/JS 블록의 본문이 그대로 글자수에 들어가, "캡션만 길게 써서 1,800자 채우기"와
  // 똑같은 우회로가 열린다 (실측: <style> 하나로 ~60자).
  const bodyRaw = textOf(root, NON_BODY_TAGS);
  const bodyChars = countChars(bodyRaw);
  const charsIncludingCaptions = countChars(textOf(root, NON_TEXT_TAGS));

  // figure 직후 형제가 h3이면 no-h3-after-figure가 잡는다. 같은 figure를
  // text-after-figure에서 또 잡으면 같은 결함이 두 번 보고된다.
  const h3AfterFigure = new Set(
    figures.filter((f) => {
      const next = nextContentElement(f);
      return next && (next.tag === 'h3' || next.tag === 'h2');
    }),
  );

  const uploadIndex = buildUploadIndex(options.uploadResult);

  return {
    source,
    root,
    parseErrors,
    images,
    figures,
    h3s,
    paragraphs,
    bodyChars,
    charsIncludingCaptions,
    bodyText: normalizeWhitespace(bodyRaw),
    h3AfterFigure,
    uploadIndex,
    hasUploadResult: uploadIndex !== null,
    // **속성값은 반드시 여기를 거친다.** 파서는 텍스트도 속성도 원문으로 주고,
    // 텍스트 쪽은 규칙들이 decodeEntities를 거치는데 속성만 예외였다. 그래서
    // `alt="&nbsp;"`·`alt="&#32;"`가 img-alt-nonempty(=접근성/AdSense 때문에
    // 존재하는 규칙)를 통과했다. src도 마찬가지로, 브라우저는 `a&amp;b.webp`를
    // `a&b.webp`로 요청하는데 verify-images는 원문을 HEAD했다.
    // 규칙이 getAttr을 직접 부르지 않게 해서 "이 규칙에도 디코드를 넣는다"를
    // 매번 손으로 하는 구조를 없앤다.
    attr: (node, name) => {
      const raw = getAttr(node, name);
      return raw === undefined ? undefined : decodeEntities(raw);
    },
    line: (node) => lineOf(source, node && node.start),
  };
}

// 업로드 결과 JSON → src 매칭용 인덱스. 3단 폴백: 완전 일치 → decodeURIComponent
// → tail 키(마지막 두 경로 세그먼트 `{postDir}/photo-NN.webp`).
// uploadAsset이 경로에 encodeURIComponent를 적용하고, --local-only에서는 webpPath가
// 로컬 경로라 호스트/접두 경로가 달라지기 때문에 마지막 폴백이 필요하다.
function buildUploadIndex(uploadResult) {
  if (!uploadResult || !Array.isArray(uploadResult.images)) return null;
  const exact = new Map();
  const decoded = new Map();
  const byTail = new Map();
  for (const im of uploadResult.images) {
    if (!im || typeof im !== 'object') continue;
    for (const u of [im.url, im.webpUrl, im.webpPath]) {
      if (typeof u !== 'string' || !u) continue;
      if (!exact.has(u)) exact.set(u, im);
      let dec = u;
      try { dec = decodeURIComponent(u); } catch { /* 잘못된 이스케이프는 원본 유지 */ }
      if (!decoded.has(dec)) decoded.set(dec, im);
      const t = tailKeyOf(u);
      if (t && !byTail.has(t)) byTail.set(t, im);
    }
  }
  // `how`를 함께 돌려준다. tail 매칭은 `{postDir}/photo-NN.webp` 두 조각만 보므로
  // **호스트가 달라도 매칭된다.** 그 관용성 자체는 의도된 것이다 (URL 인코딩·
  // 에셋 base URL 변경을 흡수한다). 문제는 그게 **보이지 않는다**는 점이었다 —
  // 초안이 옛 호스트를 가리키고 있어도 치수 검증이 조용히 통과한다.
  // 관용성은 유지하고, 어떤 근거로 매칭됐는지를 표면화한다.
  const hostOf = (u) => {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(u || ''));
    return m ? m[1].toLowerCase() : null;
  };
  // **호스트를 가진 URL만 비교 대상이다.** `webpPath`는 로컬 파일시스템 절대
  // 경로라 hostOf가 항상 null인데, 예전 `some(u => hostOf(u) === null || …)`은
  // 그걸 "같은 호스트"의 근거로 삼았다. upload-images.js는 webpPath를 **모든
  // 항목에 무조건** 내보내므로 tail-other-host 판정이 실제 산출물에서는
  // 도달 불가였다 — 이 규칙이 막으려던 상태(초안이 옛 에셋 호스트를 가리켜도
  // 치수 검증이 조용히 통과)가 그대로 남아 있었다.
  const hostsOf = (im) => [im.url, im.webpUrl]
    .map((u) => hostOf(u))
    .filter((h) => h !== null);

  return {
    size: uploadResult.images.length,
    lookupDetail(src) {
      if (exact.has(src)) return { image: exact.get(src), how: 'exact' };
      let dec = src;
      try { dec = decodeURIComponent(src); } catch { /* 잘못된 이스케이프는 원본 유지 */ }
      if (decoded.has(dec)) return { image: decoded.get(dec), how: 'decoded' };
      const image = byTail.get(tailKeyOf(src)) || null;
      if (!image) return { image: null, how: 'none' };
      const srcHost = hostOf(src);
      const hosts = hostsOf(image);
      // 어느 한쪽에 호스트가 없으면(로컬 경로·상대 경로) 비교할 것이 없다.
      const sameHost = srcHost === null || hosts.length === 0 || hosts.includes(srcHost);
      return { image, how: sameHost ? 'tail' : 'tail-other-host' };
    },
    lookup(src) {
      return this.lookupDetail(src).image;
    },
  };
}

// --- 규칙 정의 ---
// 각 규칙은 ctx를 받아 finding 배열을 반환한다. 새 규칙 추가 = 항목 하나 추가.

const RULES = [
  {
    id: 'html-structure',
    severity: 'error',
    check: (ctx) => ctx.parseErrors.map((e) => ({
      line: lineOf(ctx.source, e.offset),
      message: `HTML 구조 오류: ${e.message}`,
      detail: e.code,
    })),
  },
  {
    id: 'no-picture-source',
    severity: 'error',
    check: (ctx) => [...findAll(ctx.root, 'picture'), ...findAll(ctx.root, 'source')].map((n) => ({
      line: ctx.line(n),
      message: `<${n.tag}> 금지 — WebP 전용이라 폴백 래퍼를 쓰지 않는다. <img src="...webp">를 직접 쓸 것.`,
    })),
  },
  {
    id: 'img-loading-lazy',
    severity: 'error',
    check: (ctx) => ctx.images
      // `loading`은 HTML 스펙상 **ASCII 대소문자 무시** 열거 속성이라 브라우저가
      // `LAZY`를 정상 처리한다. 엄격 비교는 오탐이고 error라 발행이 막혔다.
      .filter((n) => String(ctx.attr(n, 'loading') || '').trim().toLowerCase() !== 'lazy')
      .map((n) => ({ line: ctx.line(n), message: '<img>에 loading="lazy"가 없습니다.', detail: ctx.attr(n, 'src') })),
  },
  {
    id: 'img-width-height',
    severity: 'error',
    check: (ctx) => ctx.images.flatMap((n) => {
      // /^\d+$/ 는 "0"을 통과시킨다. width="0"은 CLS 방지에 아무 효과가 없고
      // 오히려 레이아웃을 망가뜨리므로 양의 정수만 허용한다.
      const bad = ['width', 'height'].filter((a) => !/^[1-9]\d*$/.test(String(ctx.attr(n, a) || '')));
      return bad.length
        ? [{ line: ctx.line(n), message: `<img>의 ${bad.join('/')} 속성이 없거나 양의 정수가 아닙니다 (CLS 방지에 필수).`, detail: ctx.attr(n, 'src') }]
        : [];
    }),
  },
  {
    id: 'img-style-required',
    severity: 'error',
    check: (ctx) => ctx.images.flatMap((n) => {
      const missing = missingStyleDecls(ctx.attr(n, 'style'), REQUIRED_IMG_STYLE);
      return missing.length
        ? [{ line: ctx.line(n), message: `<img> style에 ${missing.join(', ')} 선언이 없습니다.`, detail: ctx.attr(n, 'src') }]
        : [];
    }),
  },
  {
    id: 'img-alt-nonempty',
    severity: 'error',
    check: (ctx) => ctx.images
      // `.trim()`은 ZWSP를 제거하지 않는다 — `alt="<ZWSP>"`가 통과했다.
      // normalizeWhitespace가 보이지 않는 문자를 지우므로 그것을 거친다.
      .filter((n) => !normalizeWhitespace(ctx.attr(n, 'alt') || ''))
      .map((n) => ({ line: ctx.line(n), message: '<img>에 비어있지 않은 alt가 필요합니다.', detail: ctx.attr(n, 'src') })),
  },
  {
    id: 'img-src-webp',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => !srcExtension(ctx.attr(n, 'src')).endsWith('.webp'))
      .map((n) => ({ line: ctx.line(n), message: '이미지 src는 .webp여야 합니다 (JPEG 폴백 없음).', detail: ctx.attr(n, 'src') })),
  },
  {
    id: 'img-in-figure',
    severity: 'error',
    check: (ctx) => ctx.images
      .filter((n) => !ancestors(n).some((a) => a.tag === 'figure'))
      .map((n) => ({ line: ctx.line(n), message: '<img>가 <figure> 밖에 있습니다.', detail: ctx.attr(n, 'src') })),
  },
  {
    id: 'figure-style-required',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((n) => {
      const missing = missingStyleDecls(ctx.attr(n, 'style'), REQUIRED_FIGURE_STYLE);
      return missing.length
        ? [{ line: ctx.line(n), message: `<figure> style에 ${missing.join(', ')} 선언이 없습니다. position:relative는 이미지 보호 오버레이에 필요합니다.` }]
        : [];
    }),
  },
  {
    id: 'figure-figcaption-once',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((n) => {
      const caps = elementChildren(n).filter((c) => c.tag === 'figcaption');
      if (caps.length === 1) return [];
      return [{
        line: ctx.line(n),
        message: caps.length === 0
          ? '<figure>에 <figcaption>이 없습니다.'
          : `<figure>에 <figcaption>이 ${caps.length}개입니다 (1개여야 함).`,
      }];
    }),
  },
  {
    id: 'figcaption-generic',
    severity: 'error',
    check: (ctx) => findAll(ctx.root, 'figcaption')
      .filter((n) => GENERIC_CAPTION_RE.test(decodeEntities(textOf(n))))
      .map((n) => ({ line: ctx.line(n), message: `제네릭 캡션 금지: "${textOf(n).trim()}" — 장면을 설명하는 문장으로 바꾸세요.` })),
  },
  {
    id: 'no-h3-after-figure',
    severity: 'error',
    check: (ctx) => [...ctx.h3AfterFigure].map((f) => ({
      line: ctx.line(f),
      message: '이미지 직후 <h3> 금지 — AdSense의 "이미지와 광고 사이 2문장 이상" 분리 규칙을 깹니다.',
    })),
  },
  {
    id: 'text-after-figure',
    severity: 'error',
    check: (ctx) => ctx.figures.flatMap((f) => {
      if (ctx.h3AfterFigure.has(f)) return []; // no-h3-after-figure가 이미 보고함
      const n = countSentences(textAfterFigure(f));
      return n >= MIN_SENTENCES_AFTER_FIGURE ? [] : [{
        line: ctx.line(f),
        message: `이미지 다음에 텍스트가 ${n}문장뿐입니다 (${MIN_SENTENCES_AFTER_FIGURE}문장 이상 필요 — AdSense 이미지/광고 분리).`,
      }];
    }),
  },
  {
    id: 'body-min-chars',
    severity: 'error',
    check: (ctx) => (ctx.bodyChars >= MIN_BODY_CHARS ? [] : [{
      message: `본문이 ${ctx.bodyChars}자입니다 (${MIN_BODY_CHARS}자 이상 필요). figcaption 제외·공백 포함 기준.`,
      detail: `charsIncludingCaptions=${ctx.charsIncludingCaptions}`,
    }]),
  },
  {
    id: 'h3-min-count',
    severity: 'error',
    check: (ctx) => (ctx.bodyChars < H3_THRESHOLD_CHARS || ctx.h3s.length >= MIN_H3_WHEN_LONG ? [] : [{
      message: `본문이 ${ctx.bodyChars}자인데 <h3>가 ${ctx.h3s.length}개입니다 (${H3_THRESHOLD_CHARS}자 이상이면 ${MIN_H3_WHEN_LONG}개 이상).`,
    }]),
  },
  {
    id: 'no-emoji',
    severity: 'error',
    check: (ctx) => {
      // 본문뿐 아니라 캡션·alt까지 본다 (style-guide: 제목·소제목·본문·메타 전부 금지).
      const alts = ctx.images.map((n) => ctx.attr(n, 'alt') || '').join(' ');
      // **script/style을 제외한다.** skip 인자가 없어서 CSS/JS 안의 이모지가
      // 발행을 막았다 (실측: `<style>/* 좋아요 ❤️ */</style>` → error). 작성자는
      // 본문에서 그 이모지를 찾을 수 없다. figcaption은 제외하지 않는다 —
      // 캡션의 이모지도 금지 대상이다.
      const hits = findEmoji(`${textOf(ctx.root, NON_TEXT_TAGS)} ${alts}`);
      return hits.length ? [{ message: `이모지 금지: ${hits.join(' ')}`, detail: `${hits.length}종` }] : [];
    },
  },
  {
    id: 'no-placeholder',
    severity: 'error',
    check: (ctx) => PLACEHOLDERS
      .filter((p) => ctx.bodyText.includes(p))
      .map((p) => ({ message: `플레이스홀더가 본문에 남아 있습니다: "${p}"` })),
  },
  {
    id: 'no-writing-date-expression',
    severity: 'error',
    check: (ctx) => {
      const found = findWritingDateExpression(ctx.bodyText);
      return found ? [{
        message: `작성 시점 표현 금지: "${found}" — 방문 날짜는 EXIF primary_date다. "지난 ○월 ○일" 등으로 쓸 것.`,
      }] : [];
    },
  },
  {
    // error 규칙이 놓치는 형태를 **열거 없이** 표면화한다. 차단하지 않으므로
    // 오탐 비용이 없고, 새 표면형이 조용히 LIVE로 나가는 일이 없어진다.
    id: 'writing-date-word',
    severity: 'warn',
    check: (ctx) => findWritingTimeWords(ctx.bodyText).map((snippet) => ({
      message: `작성 시점 지시어가 본문에 있습니다: "${snippet.trim()}" — 방문 날짜는 `
        + 'EXIF primary_date다. 방문을 서술하는 표현이면 "지난 ○월 ○일"로 바꾸세요 '
        + '(고정 어구라면 무시해도 됩니다).',
    })),
  },
  {
    id: 'img-dimensions-match',
    severity: 'error',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images.flatMap((n) => {
        const src = ctx.attr(n, 'src');
        const up = ctx.uploadIndex.lookup(src);
        if (!up || !Number.isInteger(up.width) || !Number.isInteger(up.height)) return [];
        const w = Number(ctx.attr(n, 'width'));
        const h = Number(ctx.attr(n, 'height'));
        if (w === up.width && h === up.height) return [];
        return [{
          line: ctx.line(n),
          message: `<img> 치수가 실제와 다릅니다: 본문 ${w}x${h}, 실제 ${up.width}x${up.height} (CLS 유발).`,
          detail: src,
        }];
      });
    },
  },
  {
    id: 'img-dimensions-unknown',
    severity: 'error',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images.flatMap((n) => {
        const src = ctx.attr(n, 'src');
        const up = ctx.uploadIndex.lookup(src);
        if (!up) return [];
        if (Number.isInteger(up.width) && Number.isInteger(up.height)) return [];
        return [{
          line: ctx.line(n),
          message: '업로드 결과의 width/height가 null입니다 — 본문 치수는 추측한 값입니다. 이미지를 빼거나 재업로드하세요.',
          detail: src,
        }];
      });
    },
  },

  // --- warn ---
  {
    id: 'body-max-chars',
    severity: 'warn',
    check: (ctx) => (ctx.bodyChars <= MAX_BODY_CHARS ? [] : [{
      message: `본문이 ${ctx.bodyChars}자입니다 (권장 상한 ${MAX_BODY_CHARS}자).`,
    }]),
  },
  {
    id: 'style-canonical-form',
    severity: 'warn',
    check: (ctx) => {
      // 후행 세미콜론 하나 차이는 표기 차이가 아니라 **동일한 선언**이다.
      // 그것으로 이미지 7장 전부에 warn이 떠 순수 노이즈였다 — 시끄러운 warn은
      // 무시당해 정작 봐야 할 표기 차이를 가린다.
      const canon = (v) => String(v || '').replace(/\s/g, '').replace(/;+$/, '');
      const out = [];
      for (const n of ctx.images) {
        const s = String(ctx.attr(n, 'style') || '');
        if (s && canon(s) !== canon(CANONICAL_IMG_STYLE)
            && missingStyleDecls(s, REQUIRED_IMG_STYLE).length === 0) {
          out.push({ line: ctx.line(n), message: `<img> style 표기가 정규형과 다릅니다 (동작은 동일): "${s}" → "${CANONICAL_IMG_STYLE}"` });
        }
      }
      for (const n of ctx.figures) {
        const s = String(ctx.attr(n, 'style') || '');
        if (s && canon(s) !== canon(CANONICAL_FIGURE_STYLE)
            && missingStyleDecls(s, REQUIRED_FIGURE_STYLE).length === 0) {
          out.push({ line: ctx.line(n), message: `<figure> style 표기가 정규형과 다릅니다 (동작은 동일): "${s}"` });
        }
      }
      return out;
    },
  },
  {
    id: 'p-sentence-count',
    severity: 'warn',
    check: (ctx) => ctx.paragraphs.flatMap((n) => {
      const c = countSentences(textOf(n, NON_BODY_TAGS));
      if (c <= MAX_P_SENTENCES) return [];
      return [{ line: ctx.line(n), message: `단락이 ${c}문장입니다 (권장 ${MAX_P_SENTENCES}문장 이하).` }];
    }),
  },
  {
    id: 'p-max-chars',
    severity: 'warn',
    check: (ctx) => ctx.paragraphs.flatMap((n) => {
      const c = countChars(textOf(n, NON_BODY_TAGS));
      return c <= MAX_P_CHARS ? [] : [{ line: ctx.line(n), message: `단락이 ${c}자입니다 (권장 ${MAX_P_CHARS}자 이하 — 의미 단위로 분리).` }];
    }),
  },
  {
    id: 'h3-placement',
    severity: 'warn',
    check: (ctx) => {
      if (ctx.h3s.length === 0) return [];
      const out = [];
      // 래퍼를 평탄화한다. elementChildren만 보면 <div>로 감싼 h3의 indexOf가
      // -1이 되어 **규칙이 0개를 검사한다** (발견이 줄어드는 게 아니라 무력화).
      const blocks = flatElementChildren(ctx.root);
      const firstP = blocks.findIndex((n) => n.tag === 'p');
      const lastContent = blocks.map((n) => n.tag).lastIndexOf('p');
      for (const h of ctx.h3s) {
        const i = blocks.indexOf(h);
        if (i === -1) continue;
        if (firstP !== -1 && i < firstP) {
          out.push({ line: ctx.line(h), message: '<h3>가 도입 단락보다 앞에 있습니다 (부제목은 도입과 마무리 사이).' });
        } else if (lastContent !== -1 && i > lastContent) {
          out.push({ line: ctx.line(h), message: '<h3>가 마지막 단락보다 뒤에 있습니다 (부제목은 도입과 마무리 사이).' });
        }
      }
      return out;
    },
  },
  {
    id: 'h3-mechanical-label',
    severity: 'warn',
    check: (ctx) => ctx.h3s.flatMap((n) => {
      const t = normalizeWhitespace(textOf(n));
      return MECHANICAL_H3.includes(t)
        ? [{ line: ctx.line(n), message: `기계적인 부제목 라벨: "${t}" — 자연스러운 묘사형으로 바꾸세요.` }]
        : [];
    }),
  },
  {
    id: 'overclaim-phrase',
    severity: 'warn',
    check: (ctx) => phraseHitsExcludingNegated(ctx.bodyText, OVERCLAIM)
      .map((p) => ({ message: `과장 표현: "${p}"` })),
  },
  {
    id: 'ai-tell-phrase',
    severity: 'warn',
    check: (ctx) => phraseHitsExcludingNegated(ctx.bodyText, AI_TELLS)
      .map((p) => ({ message: `AI 티 나는 표현: "${p}"` })),
  },
  {
    id: 'spouse-wording',
    severity: 'warn',
    // `부인`은 "부인하다"(deny)와 동형이다. 부정 표현이 뒤따르면 배우자 호칭이
    // 아니다 (실측 오탐: "부인할 수 없는 맛이었다"). `부인할/부인하기/부인은`처럼
    // 용언 활용이 붙는 형태를 제외한다.
    check: (ctx) => (/부인(?!하|할|함|했|한다|치)/.test(ctx.bodyText)
      ? [{ message: '"부인" 대신 "와이프"를 사용합니다.' }] : []),
  },
  {
    id: 'no-ad-encouragement',
    severity: 'warn',
    check: (ctx) => phraseHitsExcludingNegated(ctx.bodyText.toLowerCase(),
      AD_MENTIONS.map((p) => p.toLowerCase()))
      .map((p) => ({ message: `광고/수익 언급 금지: "${p}"` })),
  },
  {
    id: 'link-target-rel',
    severity: 'warn',
    check: (ctx) => findAll(ctx.root, 'a').flatMap((n) => {
      const href = ctx.attr(n, 'href');
      if (!href) return [];
      // `target="_blank"`는 **외부로 나가는 링크**에만 의미가 있다. 내부 앵커
      // (`#section`)·상대 경로·mailto/tel에 요구하면 정당한 마크업에 warn이 뜬다.
      // 프로토콜 상대 URL(`//example.com`)도 외부로 나간다.
      if (!/^(?:https?:)?\/\//i.test(href.trim())) return [];
      const rel = String(ctx.attr(n, 'rel') || '');
      const missing = [];
      if (ctx.attr(n, 'target') !== '_blank') missing.push('target="_blank"');
      if (!rel.includes('noopener') || !rel.includes('noreferrer')) missing.push('rel="noopener noreferrer"');
      return missing.length ? [{ line: ctx.line(n), message: `<a>에 ${missing.join(', ')}가 없습니다.`, detail: ctx.attr(n, 'href') }] : [];
    }),
  },
  {
    id: 'decorative-arrow',
    severity: 'warn',
    check: (ctx) => {
      const hits = findDecorativeArrows(ctx.bodyText);
      return hits.length ? [{ message: `장식용 화살표로 보이는 문자: ${hits.join(' ')} (동선 설명이면 무시 가능).` }] : [];
    },
  },
  {
    id: 'image-order',
    severity: 'warn',
    check: (ctx) => {
      // **폴더가 바뀌면 순서를 새로 센다.** photoIndexOf가 `photo-NN.webp$`만 보므로
      // 여러 폴더의 이미지가 섞이면(이전 세션 이미지 재사용 — img-not-in-upload-result가
      // 정상 시나리오로 인정하는 경우) 각 폴더 안에서 오름차순인데도 오탐이 났다.
      // tailKeyOf가 정확히 이 이유로 폴더를 포함하도록 고쳐졌는데 여기는 안 됐다.
      const dirOf = (src) => String(src || '').split(/[?#]/)[0].split(/[\\/]/).slice(0, -1).join('/');
      let prevDir = null;
      let prevNum = null;
      for (const n of ctx.images) {
        const src = ctx.attr(n, 'src');
        const num = photoIndexOf(src);
        if (num === null) continue;
        const dir = dirOf(src);
        if (dir !== prevDir) { prevDir = dir; prevNum = num; continue; }
        if (num <= prevNum) {
          return [{
            line: ctx.line(n),
            message: `이미지 순서가 오름차순이 아닙니다: photo-${prevNum} 다음에 photo-${num}.`,
          }];
        }
        prevNum = num;
      }
      return [];
    },
  },
  {
    // 일부만 못 찾은 경우는 이전 세션 이미지 재사용일 수 있어 warn으로 남긴다.
    // (전량 미매칭은 아래 upload-result-no-match가 error로 잡는다.)
    id: 'img-not-in-upload-result',
    severity: 'warn',
    check: (ctx) => {
      if (!ctx.hasUploadResult) return [];
      return ctx.images
        .filter((n) => !ctx.uploadIndex.lookup(ctx.attr(n, 'src')))
        .map((n) => ({ line: ctx.line(n), message: '이 이미지가 업로드 결과에 없습니다 (이전 세션 이미지 재사용일 수 있음).', detail: ctx.attr(n, 'src') }));
    },
  },
  {
    // tail 매칭은 `{postDir}/photo-NN.webp` 두 조각만 보므로 호스트가 달라도
    // 매칭된다. 그 관용성은 의도된 것이지만(URL 인코딩·에셋 base URL 변경 흡수),
    // 조용하면 초안이 **옛 에셋 호스트**를 가리켜도 치수 검증이 통과한다.
    id: 'upload-match-by-filename',
    severity: 'warn',
    check: (ctx) => {
      // 이 저장소의 규칙은 when이 아니라 check 안에서 게이트한다 (러너에 when이 없다).
      if (!ctx.hasUploadResult) return [];
      return ctx.images
        .map((n) => ({ n, src: ctx.attr(n, 'src') }))
        .map((e) => ({ ...e, d: ctx.uploadIndex.lookupDetail(e.src) }))
        .filter(({ d }) => d.how === 'tail-other-host')
        .map(({ n, src, d }) => ({
          line: ctx.line(n),
          message: '업로드 결과와 파일 경로로만 매칭됐습니다 (호스트가 다릅니다). '
            + '초안이 옛 에셋 호스트를 가리키고 있는지 확인하세요.',
          detail: `초안: ${src} / 업로드: ${d.image.webpUrl || d.image.url || d.image.webpPath}`,
        }));
    },
  },
  {
    // 사용자가 --upload-result로 대조를 **요구했는데** 대조 대상이 하나도 없다면
    // 그건 경고가 아니라 실패다 (치수 규칙 두 개가 통째로 무력화된 상태).
    id: 'upload-result-no-match',
    severity: 'error',
    check: (ctx) => {
      if (!ctx.hasUploadResult || ctx.images.length === 0) return [];
      if (matchedImageCount(ctx) > 0) return [];
      return [{
        message: `--upload-result를 지정했지만 본문 이미지 ${ctx.images.length}장 중 한 장도 대조되지 않았습니다 `
          + `(업로드 결과 항목 ${ctx.uploadIndex.size}개). 치수 검증이 통째로 건너뛰어진 상태입니다.`,
        detail: '다른 슬러그의 결과 파일을 넘겼을 수 있습니다. '
          + '이전 세션 이미지를 의도적으로 재사용 중이라면 --upload-result를 빼고 실행하세요 '
          + '(그러면 치수 대조를 건너뛴다는 사실이 stats.dimensionCheck=skipped로 표시됩니다).',
      }];
    },
  },
];

/**
 * @param {string} html 초안 HTML
 * @param {{uploadResult?: object, strict?: boolean}} [options]
 */
// --upload-result로 넘어온 JSON이 upload-images.js --output 산출물이 맞는지 검사한다.
// "인자가 없다"와 "인자는 있는데 형식이 틀렸다"를 절대 같은 상태로 뭉개면 안 된다 —
// 후자를 "미지정"으로 처리하면 치수 error 규칙 두 개가 조용히 무력화된다.
function validateUploadResult(parsed, label) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${label} JSON이 객체가 아닙니다. upload-images.js --output 산출물이 필요합니다.` };
  }
  if (!Array.isArray(parsed.images)) {
    return {
      ok: false,
      error: `${label}에 images 배열이 없습니다. upload-images.js --output 산출물이 맞는지 확인하세요 `
        + '(metadata-*.json을 잘못 넘긴 경우가 많습니다). 치수 대조 없이 통과시키지 않습니다.',
    };
  }
  return { ok: true, error: null };
}

function matchedImageCount(ctx) {
  if (!ctx.hasUploadResult) return 0;
  return ctx.images.filter((n) => ctx.uploadIndex.lookup(ctx.attr(n, 'src'))).length;
}

function dimensionCheckStatus(ctx) {
  if (!ctx.hasUploadResult) return 'skipped';
  const total = ctx.images.length;
  if (total === 0) return 'no-images';
  const matched = matchedImageCount(ctx);
  return matched === total ? 'ok' : `partial (${matched}/${total})`;
}

/**
 * @param {string} html 초안 HTML
 * @param {{uploadResult?: object, strict?: boolean}} [options]
 */
function lintDraftHtml(html, options = {}) {
  const ctx = buildContext(html, options);

  const errors = [];
  const warnings = [];

  for (const rule of RULES) {
    let findings;
    try {
      findings = rule.check(ctx) || [];
    } catch (err) {
      // 규칙 하나가 터져서 전체 검증이 조용히 통과하는 일이 없어야 한다.
      errors.push({ rule: rule.id, severity: 'error', line: null, message: `규칙 실행 실패: ${errFull(err)}`, detail: null });
      continue;
    }
    for (const f of findings) {
      const entry = {
        rule: rule.id,
        severity: rule.severity,
        line: f.line ?? null,
        message: f.message,
        detail: f.detail ?? null,
      };
      // --strict는 warn을 error로 승격한다. 규칙을 강화하는 방향이라 우회가 아니다.
      if (rule.severity === 'error' || options.strict) {
        errors.push({ ...entry, severity: 'error' });
      } else {
        warnings.push(entry);
      }
    }
  }

  const sentencesAfterFigure = ctx.figures.map((f) => countSentences(textAfterFigure(f)));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      bodyChars: ctx.bodyChars,
      charsIncludingCaptions: ctx.charsIncludingCaptions,
      figures: ctx.figures.length,
      images: ctx.images.length,
      h3: ctx.h3s.length,
      paragraphs: ctx.paragraphs.length,
      sentencesAfterFigure,
      // 검증이 안 됐다는 사실 자체를 표면화한다 (조용히 통과 금지).
      // 'ok'/'skipped' 이분법으로는 "업로드 결과는 있는데 한 장도 매칭되지
      // 않았다"가 'ok'로 보고된다 — 대조 0장인데 사용자는 전수 대조로 믿는다.
      dimensionCheck: dimensionCheckStatus(ctx),
      dimensionsMatched: ctx.hasUploadResult ? matchedImageCount(ctx) : 0,
    },
  };
}

function formatLintReport(result, { only = 'all' } = {}) {
  const lines = [];
  const show = (list, tag) => {
    for (const f of list) {
      const at = f.line ? ` (line ${f.line})` : '';
      const detail = f.detail ? `\n      ${f.detail}` : '';
      lines.push(`  ${tag} [${f.rule}]${at} ${f.message}${detail}`);
    }
  };
  if (only !== 'warn' && result.errors.length) {
    lines.push(`초안 lint 실패 — error ${result.errors.length}건:`);
    show(result.errors, 'ERROR');
  }
  if (only !== 'error' && result.warnings.length) {
    lines.push(`초안 lint 경고 ${result.warnings.length}건 (차단하지 않음):`);
    show(result.warnings, 'WARN ');
  }
  return lines.join('\n');
}

module.exports = {
  H3_THRESHOLD_CHARS,
  validateUploadResult,
  MAX_BODY_CHARS,
  MIN_BODY_CHARS,
  MIN_SENTENCES_AFTER_FIGURE,
  PLACEHOLDERS,
  RULES,
  formatLintReport,
  lintDraftHtml,
  parseStyle,
};
