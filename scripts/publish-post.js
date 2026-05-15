require('dotenv').config();

const fs = require('fs');
const { getPost, publishPost, updatePost } = require('../lib/blogger');

const args = process.argv.slice(2);

function printUsage() {
  console.log('Usage: node publish-post.js --post-id ID [--slug 2026-05-10 | --slug-from-date tmp/metadata.json]');
  console.log('');
  console.log('Options:');
  console.log('  --post-id          Blogger post ID (필수)');
  console.log('  --slug             URL 슬러그 직접 지정 (예: 2026-05-10). 영문/숫자/하이픈만');
  console.log('  --slug-from-date   metadata JSON 경로 — primary_date 값을 슬러그로 사용');
  console.log('');
  console.log('슬러그 미지정 시 Blogger 자동 슬러그 사용 (title에서 파생).');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  if (idx + 1 >= args.length) {
    console.error(`Error: ${name}에 값이 필요합니다.`);
    process.exit(1);
  }
  // 다음 토큰이 `--`로 시작하면 사용자가 값을 빠뜨린 채 다음 플래그가 위치한 것.
  // 그대로 슬러그/경로로 채택되면 발행 URL이 영구히 오염되므로 fail-fast.
  const val = args[idx + 1];
  if (val.startsWith('--')) {
    console.error(`Error: ${name}의 값으로 또 다른 플래그 "${val}"가 들어왔습니다. 값을 명시하세요.`);
    process.exit(1);
  }
  return val;
}

// 알 수 없는 플래그(typo)나 중복 지정을 silent하게 흘리지 않도록 시작 시 한 번 검증.
// 예: `--slugg 2026-05-10`은 `--slug` 파싱이 null이 되어 auto-slug로 잘못 fallback되는데,
// 이건 이번 프로젝트의 발단인 "JBOUT URL" 사고와 같은 silent UX 실패 클래스다.
function validateKnownFlags(known) {
  const seen = new Set();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    if (!known.includes(arg)) {
      console.error(`Error: 알 수 없는 플래그 "${arg}". 사용 가능: ${known.join(', ')}`);
      process.exit(1);
    }
    if (seen.has(arg)) {
      console.error(`Error: 플래그 "${arg}"가 중복 지정되었습니다.`);
      process.exit(1);
    }
    seen.add(arg);
  }
}

function loadSlugFromMetadata(metadataPath) {
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!meta.primary_date) {
    throw new Error(`metadata ${metadataPath}의 primary_date가 null입니다. --slug로 직접 지정하세요.`);
  }
  // YYYY-MM-DD 형식 + 실제 유효한 달력 날짜인지 검증. 슬러그 정규식만으로는
  // "2026-13-99" 같은 invalid 날짜가 통과해서 URL이 그 문자열로 영구 고정되는 사고가 난다.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.primary_date)) {
    throw new Error(`metadata ${metadataPath}의 primary_date "${meta.primary_date}"가 YYYY-MM-DD 형식이 아닙니다.`);
  }
  const [y, mo, d] = meta.primary_date.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() + 1 !== mo || date.getDate() !== d) {
    throw new Error(`metadata ${metadataPath}의 primary_date "${meta.primary_date}"가 유효한 달력 날짜가 아닙니다.`);
  }
  return meta.primary_date;
}

async function publishWithCustomSlug(postId, slug) {
  const original = await getPost(postId);
  if (!original) {
    throw new Error(`Blogger getPost(${postId})가 빈 응답을 반환했습니다.`);
  }

  // Blogger URL은 첫 발행 시점에 title 기반으로 고정. 이미 LIVE면 슬러그 트릭은 URL을 못 바꾸고
  // title만 잠시 슬러그 문자열로 노출시키는 부작용만 남는다.
  if (original.status === 'LIVE') {
    console.log(`Post ${postId}는 이미 LIVE 상태 — URL은 첫 발행 시점에 고정되어 슬러그 트릭이 효과 없음. 단순 publish만 수행.`);
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
    err.message = `슬러그 트릭의 첫 PATCH(title=슬러그)가 실패했습니다: ${err.message}\n` +
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
      // publish 실패 + 복원 실패: 원본 title 정보를 throw하는 에러에 실어 호출자가 재시도 시
      // 슬러그를 originalTitle로 백업하는 사고를 피할 수 있게 한다.
      err.message = `${err.message}\n  + title 복원도 실패: ${restoreErr.message}\n  + 현재 Blogger title은 "${slug}"로 남아 있음. 원본 title: "${originalTitle}". 수동 복원 후 재시도.`;
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
    // 발행 성공 + 복원 실패 = silent success로 종료되면 안 됨. throw로 비-제로 exit 보장.
    throw new Error(
      `발행은 성공했으나 title 복원 실패: ${err.message}\n` +
      `  + 현재 Blogger title은 "${slug}"로 남아 있음. 원본 title: "${originalTitle}".\n` +
      `  + 수동 복원: Blogger 에디터에서 post-id ${postId}의 title을 위 원본으로 변경.`,
    );
  }

  // 슬러그 사후 검증 — 매치 실패도 silent하지 않게 명시적으로 경고한다.
  if (published.url) {
    const match = published.url.match(/\/([^/]+)\.html$/);
    if (!match) {
      console.warn(`경고: 발행 URL 형식을 파싱할 수 없어 슬러그 검증을 건너뜁니다: ${published.url}`);
    } else if (match[1] !== slug) {
      console.warn(`경고: 요청한 슬러그 "${slug}"와 실제 슬러그 "${match[1]}"가 다릅니다. (슬러그 충돌이거나 Blogger 처리 차이)`);
    }
  } else {
    console.warn(`경고: 발행 응답에 url이 없어 슬러그 검증 불가.`);
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

  // 빈 슬러그(예: 셸 변수 치환 실패로 `--slug ""`)가 silent하게 auto-slug로 fallback되는 사고 차단.
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
      console.error(`Error: --slug-from-date 로드 실패 — ${err.message}`);
      process.exit(1);
    }
  }

  if (slug && !/^[a-zA-Z0-9-]+$/.test(slug)) {
    console.error(`Error: 슬러그는 영문/숫자/하이픈만 가능합니다. (받음: "${slug}")`);
    process.exit(1);
  }

  console.log(`Publishing Blogger post ${postId}...`);
  const post = slug
    ? await publishWithCustomSlug(postId, slug)
    : await publishPost(postId);

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    published: post.published,
  }, null, 2));
}

main().catch((err) => {
  // err.message와 err.response.data를 모두 출력 — 한쪽을 다른 쪽이 덮어 사용자 안내 문구
  // (예: 슬러그 트릭의 수동 복원 가이드)가 silent하게 사라지는 사고를 막는다.
  console.error('Publish failed:', err.message);
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data));
  }
  process.exit(1);
});
