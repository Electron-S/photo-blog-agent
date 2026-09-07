require('dotenv').config();

const { getPost, publishPost, updatePost } = require('../lib/blogger');
const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { errFull, errStack, reportFatal } = require('../lib/err-text');
const {
  extractSlugFromUrl,
  loadSlugFromMetadata,
  slugMatchesWithAutoSuffix,
  validateSlugArg,
} = require('../lib/slug');

// IMPORTANT: 이 함수는 출력 후 `process.exit(1)`로 종료한다. 호출자에 컨트롤이 돌아오지 않는다.
// 미래 리팩터링 시 exit를 떼어내면 호출 측에서 fall-through로 silent 진행되는 사고가 나니
// 함수 이름/시그니처를 바꿀 때 호출자에서도 명시적 exit를 함께 추가할 것.
function printUsage() {
  console.log('Usage: node publish-post.js --post-id ID (--slug 2026-05-10 | --slug-from-date tmp/metadata.json)');
  console.log('');
  console.log('Options:');
  console.log('  --post-id          Blogger post ID (필수)');
  console.log('  --slug             URL 슬러그 직접 지정 (예: 2026-05-10). 영문/숫자/하이픈만');
  console.log('  --slug-from-date   metadata JSON 경로 — primary_date 값을 슬러그로 사용');
  console.log('');
  console.log('--slug 또는 --slug-from-date 중 하나는 반드시 동반해야 합니다.');
  console.log('둘 다 없으면 Blogger가 title 기반 한글 슬러그를 영구 고정하므로,');
  console.log('이후 URL 변경 시도 자체가 차단되고 Google Search Console "리디렉션 오류"의 원인이 됩니다.');
  console.log('');
  console.log('종료 코드: 0=성공, 1=일반 실패, 6=슬러그 미지정 거부, 7=슬러그 검증 실패 (LIVE 영구 고정 mismatch 또는 발행 후 mismatch)');
  process.exit(1);
}

// 슬러그 검증 실패는 exit 7 — exit 1(일반 실패)/exit 6(슬러그 미지정)과 구분해
// 자동화 파이프라인이 "URL이 의도와 다름" 사고를 별도로 처리할 수 있게 한다.
function failWithExit(code, message) {
  const err = new Error(message);
  err.exitCode = code;
  return err;
}

async function publishWithCustomSlug(postId, slug) {
  const original = await getPost(postId);
  if (!original) {
    throw new Error(`Blogger getPost(${postId})가 빈 응답을 반환했습니다.`);
    }

  // Blogger URL은 첫 발행 시점에 title 기반으로 고정. 이미 LIVE면 슬러그 트릭은 URL을 못 바꾸고
  // title만 잠시 슬러그 문자열로 노출시키는 부작용만 남는다. 슬러그 불일치 상태에서 publish가
  // exit 0으로 끝나면 자동화 파이프라인이 사고를 "성공"으로 인식하므로 (silent failure 사례),
  // 슬러그가 일치하거나 Blogger 자동 suffix(`-N`) 패턴에만 해당할 때 republish를 허용한다.
  if (original.status === 'LIVE') {
    if (!original.url) {
      throw failWithExit(7, `Post ${postId}는 LIVE인데 응답에 url이 없습니다 — Blogger API 응답 이상. 수동 확인 필요.`);
    }
    const currentSlug = extractSlugFromUrl(original.url);
    if (!currentSlug) {
      throw failWithExit(7, `Post ${postId}의 LIVE URL "${original.url}"에서 슬러그를 파싱할 수 없습니다. URL 컨벤션 변경 가능성 — 수동 확인.`);
    }
    if (!slugMatchesWithAutoSuffix(currentSlug, slug)) {
      throw failWithExit(
        7,
        `Post ${postId}는 이미 LIVE이고 URL 슬러그가 "${currentSlug}"로 영구 고정되어 있습니다. ` +
        `요청한 슬러그 "${slug}"와 일치하지 않으며 Blogger 자동 suffix(-N) 패턴도 아닙니다 — silent republish 차단.\n` +
        `  + 단순 재발행이 의도였다면 --slug ${currentSlug}로 호출하세요.\n` +
        `  + URL을 정말 바꿔야 한다면: delete-post.js로 이 글을 영구 삭제 + 새로 작성·발행 + Search Console에서 옛 URL 임시 삭제.\n` +
        `  + 옛 글 삭제 없이 같은 내용을 새 슬러그로 재발행하면 Google이 옛 URL→새 URL redirect로 오인하여 색인 실패합니다.`,
      );
    }
    console.log(`Post ${postId}는 이미 LIVE 상태 (URL 슬러그 "${currentSlug}"). 요청 슬러그와 일치 — 단순 publish 수행.`);
    return await publishPost(postId);
    }
  // DRAFT 외 상태(SOFT_TRASHED/SCHEDULED/미지)는 슬러그 트릭이 안전하지 않다 — 휴지통의 글에 title을
  // PATCH한 뒤 publish가 실패하면 슬러그 문자열이 남는 등 silent 데이터 손상 가능.
  if (original.status !== 'DRAFT') {
    throw new Error(
      `Post ${postId}의 상태가 "${original.status}"입니다 (DRAFT/LIVE만 처리 가능). ` +
      `SOFT_TRASHED라면 복원, SCHEDULED라면 예약 해제 후 재시도하세요.`,
    );
    }

  const originalTitle = original.title;
  if (!originalTitle) {
    throw new Error(`Post ${postId}의 title이 비어 있어 슬러그 트릭의 안전한 복원이 불가능합니다. 먼저 title을 채운 뒤 다시 시도하세요.`);
    }
  console.log(`원래 title 백업: "${originalTitle}"`);

  console.log(`title을 슬러그용으로 변경: "${slug}"`);
  try {
    await updatePost(postId, { title: slug });
  } catch (err) {
    // 1단계 PATCH 실패 시 서버가 부분 commit했을 수 있다. 사용자가 Blogger title 상태를
    // 확인할 수 있도록 augmented 안내를 throw 전에 메시지에 실어둔다.
    err.message = `슬러그 트릭의 첫 PATCH(title=슬러그)가 실패했습니다: ${errFull(err)}\n` +
      `  + 부분 commit 가능성 — Blogger 에디터에서 post-id ${postId}의 현재 title을 확인하세요.\n` +
      `  + 원본 title: "${originalTitle}". 슬러그 문자열로 남아 있다면 원본으로 수동 복원 후 재시도.`;
    throw err;
    }

  let published;
  try {
    console.log('발행 중...');
    published = await publishPost(postId);
  } catch (err) {
    console.error('발행 실패. title 복원 시도 중...');
    const errMsg = (err && errFull(err)) || String(err);
    try {
      // 복원 응답에서 실제 title을 확인 — Blogger의 silent 정규화/truncate가 있으면 그쪽에서도
      // "복원 완료"라는 거짓 메시지가 나가지 않도록 한다 (정상 복원 경로와 대칭).
      const restored = await updatePost(postId, { title: originalTitle });
      if (restored?.title && restored.title !== originalTitle) {
        console.error(`경고: title 복원은 됐으나 Blogger가 정규화함. 요청: "${originalTitle}", 실제: "${restored.title}".`);
      } else {
        console.error(`title 복원 완료. 다시 시도하세요.`);
      }
    } catch (restoreErr) {
      // publish 실패 + 복원 실패: title이 슬러그 문자열로 남은 채 글은 DRAFT. 이 상태에서
      // 자동화가 exit 1을 "일반 실패 → 재시도"로 분류하면 두 번째 호출이 originalTitle을
      // 슬러그로 백업해 슬러그가 영구 손실되는 멱등성 사고가 난다. exit 7로 분류해
      // 자동화가 "수동 확인 필요"로 분기하도록 강제.
      const wrapped = new Error(
        `${errMsg}\n  + title 복원도 실패: ${errFull(restoreErr)}\n  + 현재 Blogger title은 "${slug}"로 남아 있음. 원본 title: "${originalTitle}". 수동 복원 후 재시도.`,
      );
      wrapped.exitCode = 7;
      throw wrapped;
    }
    throw err;
    }

  try {
    console.log('title을 원래대로 복원...');
    // 복원 응답에서 실제로 저장된 title을 채택 — Blogger가 silently 정규화/truncate하는 경우
    // 출력 JSON이 거짓 정보(originalTitle 그대로)를 보여주지 않도록 한다.
    const restored = await updatePost(postId, { title: originalTitle });
    published.title = restored?.title ?? originalTitle;
    if (restored?.title && restored.title !== originalTitle) {
      console.warn(`경고: 복원 후 Blogger가 title을 정규화함. 요청: "${originalTitle}", 실제: "${restored.title}".`);
    }
  } catch (err) {
    // 발행 성공 + 복원 실패 = LIVE인데 title이 슬러그 문자열로 노출된 상태. 자동화가 exit 1을
    // "일반 실패 → 재시도"로 분류하면 두 번째 호출이 LIVE 분기로 진입하고 original.title(=슬러그)을
    // originalTitle로 백업해버려 슬러그가 영구 손실. exit 7로 분류해 멱등성 보호.
    throw failWithExit(
      7,
      `발행은 성공했으나 title 복원 실패: ${errFull(err)}\n` +
      `  + 현재 Blogger title은 "${slug}"로 남아 있음. 원본 title: "${originalTitle}".\n` +
      `  + 수동 복원: Blogger 에디터에서 post-id ${postId}의 title을 위 원본으로 변경.`,
    );
    }

  // 슬러그 사후 검증 — 발행은 됐지만 URL이 의도와 다른 상태가 exit 0으로 끝나면
  // 자동화 파이프라인이 사고를 "성공"으로 인식한다 (silent failure). 자동 suffix `-N`만 허용.
  if (!published.url) {
    throw failWithExit(7, `발행 응답에 url이 없어 슬러그 검증 불가합니다. Blogger 에디터에서 post-id ${postId}의 URL을 수동 확인하세요.`);
    }
  const actualSlug = extractSlugFromUrl(published.url);
  if (!actualSlug) {
    throw failWithExit(
      7,
      `발행 URL 형식을 파싱할 수 없어 슬러그 검증 불가: ${published.url}. URL 컨벤션 변경 가능성 — 수동 확인.\n` +
      `  + 글은 이미 LIVE 상태로 ${published.url}에 게시됨. 자동 재시도 금지 (재발행 시 옛 URL이 살아남아 redirect 사고 재발).`,
    );
    }
  if (!slugMatchesWithAutoSuffix(actualSlug, slug)) {
    throw failWithExit(
      7,
      `발행은 됐으나 슬러그 검증 실패. 요청: "${slug}", 실제: "${actualSlug}" (Blogger 자동 suffix -N 패턴에도 해당 없음).\n` +
      `  + 글은 이미 LIVE 상태로 ${published.url}에 게시됨.\n` +
      `  + 의도와 다른 URL이면 delete-post.js로 영구 삭제 후 슬러그를 재확인하고 새 글로 재발행하세요.`,
    );
    }
  if (actualSlug !== slug) {
    console.log(`정보: Blogger가 자동 suffix를 추가했습니다. 요청: "${slug}", 실제: "${actualSlug}" (같은 날짜의 N번째 글).`);
    }

  return published;
}

async function main() {
  validateKnownFlags(['--post-id', '--slug', '--slug-from-date']);

  const postId = getArg('--post-id');
  const slugArg = getArg('--slug');
  const slugFromDate = getArg('--slug-from-date');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
    }

  if (slugArg !== null && slugFromDate !== null) {
    console.error('Error: --slug와 --slug-from-date는 동시에 지정할 수 없습니다.');
    process.exit(1);
    }

  // 빈 슬러그(예: 셸 변수 치환 실패로 `--slug ""`)를 "슬러그 미지정"(exit 6)으로
  // 뭉뚱그리면 사용자가 원인을 못 찾는다. --slug를 넘겼다는 사실 자체가 신호이므로
  // 별도 메시지로 먼저 거른다.
  if (slugArg !== null && slugArg.trim() === '') {
    console.error('Error: --slug에 빈 문자열이 전달되었습니다. (변수 치환 실패 의심)');
    process.exit(1);
  }

  let slug = slugArg;
  if (!slug && slugFromDate) {
    try {
      slug = loadSlugFromMetadata(slugFromDate);
    } catch (err) {
      // metadata 로드 실패는 publish 단계 실패와 구분되어야 사용자가 올바른 후속 조치를 한다.
      // JSON parse/readFile 에러의 위치 정보(stack)를 보존해 깨진 파일 라인을 디버그할 수 있게 한다.
      console.error(`Error: --slug-from-date 로드 실패 — ${errFull(err)}`);
      if (errStack(err)) console.error(errStack(err));
      process.exit(1);
    }
    }

  // 슬러그 미지정으로 publish하면 Blogger가 title 기반 한글 슬러그를 영구 고정한다.
  // 이후 URL 변경 시도(글 삭제 후 재발행 등)는 Google index에 옛 URL을 남기고
  // Search Console의 "리디렉션 오류" 색인 실패로 직결되므로 (실제 사고 이력 있음),
  // 슬러그를 명시하지 않은 publish는 거부한다. exit 6 = silent auto-slug 거부.
  if (!slug) {
    console.error('Error: --slug 또는 --slug-from-date 중 하나는 반드시 지정해야 합니다.');
    console.error('  + 슬러그 없이 publish하면 Blogger가 title 기반 한글 슬러그를 영구 고정하고,');
    console.error('    이후 URL 변경 시도는 색인 오류(리디렉션 오류)의 직접 원인이 됩니다.');
    process.exit(6);
    }

  const slugCheck = validateSlugArg(slug);
  if (!slugCheck.ok) {
    console.error(slugCheck.error);
    process.exit(1);
    }

  console.log(`Publishing Blogger post ${postId} with slug "${slug}"...`);
  const post = await publishWithCustomSlug(postId, slug);

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    published: post.published,
  }, null, 2));
}

// require.main 가드: 테스트가 이 파일을 require해도 CLI가 실행되지 않게 한다.
// (예전에는 require만 해도 usage를 찍고 process.exit(1) 했다.)
if (require.main === module) {
  main().catch((err) => {
    // message와 response.data를 모두 출력 — 한쪽을 다른 쪽이 덮어 사용자 안내 문구
    // (예: 슬러그 트릭의 수동 복원 가이드)가 silent하게 사라지는 사고를 막는다.
    // failWithExit가 부여한 의미별 exit code(7=슬러그 검증 실패 등)도 여기서 전파된다.
    process.exit(reportFatal(err, 'Publish failed:'));
  });
}

module.exports = { publishWithCustomSlug };
