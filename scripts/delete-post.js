require('dotenv').config();

const axios = require('axios');
const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { getPost, deletePost } = require('../lib/blogger');
const { errExitCode, errFull } = require('../lib/err-text');

function printUsage() {
  console.log('Usage: node delete-post.js --post-id ID [--draft-only] [--keep-trash]');
  console.log('');
  console.log('Options:');
  console.log('  --post-id      Blogger post ID (required)');
  console.log('  --draft-only   Only delete if the post is still a draft');
  console.log('  --keep-trash   휴지통으로 보냄 (useTrash=true). 기본은 영구 삭제');
  console.log('');
  console.log('종료 코드: 0=성공(또는 --draft-only로 건너뜀), 1=일반 실패, 7=삭제 후 옛 URL이 살아 있음');
  process.exit(1);
}

// 삭제 후 옛 URL이 404가 아니면 Google 색인에서 자연 제거되지 않는다. 이 상태를
// exit 0으로 끝내면 자동화가 "삭제 완료"로 인식하므로 publish-post.js와 같은
// 의미(exit 7 = URL 상태가 의도와 다름)로 분류해 수동 확인 분기를 강제한다.
async function verifyUrlGone(url) {
  try {
    const res = await axios.head(url, { timeout: 10000, validateStatus: () => true });
    return { gone: res.status === 404 || res.status === 410, status: res.status };
  } catch (err) {
    // 네트워크 오류는 "404 확인됨"이 아니다 — 판정 불가로 보고한다.
    return { gone: false, status: 0, error: err.code || errFull(err) };
  }
}

async function main() {
  validateKnownFlags(['--post-id', '--draft-only', '--keep-trash']);

  const postId = getArg('--post-id');
  const draftOnly = process.argv.includes('--draft-only');
  const keepTrash = process.argv.includes('--keep-trash');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
  }

  // view=ADMIN이 필요하다. 기본 READER 뷰는 DRAFT를 404로 가려서
  // --draft-only가 원리적으로 동작하지 않는다.
  const post = await getPost(postId);
  if (!post) {
    throw new Error(`Blogger getPost(${postId})가 빈 응답을 반환했습니다.`);
  }

  if (draftOnly && post.status !== 'DRAFT') {
    console.log(`Post ${postId} is not a draft (status: ${post.status}). Skipping delete.`);
    console.log(JSON.stringify({ id: post.id, title: post.title, status: post.status }, null, 2));
    return;
  }

  const wasLiveUrl = post.status === 'LIVE' ? post.url : null;
  console.log(`Deleting post ${postId}: "${post.title}" (status: ${post.status}, useTrash=${keepTrash})...`);

  await deletePost(postId, { useTrash: keepTrash });
  console.log(`Post ${postId} deleted.`);

  if (!wasLiveUrl) return;

  console.log(`옛 URL이 실제로 사라졌는지 확인 중: ${wasLiveUrl}`);
  const check = await verifyUrlGone(wasLiveUrl);
  if (check.gone) {
    console.log(`확인 완료: ${wasLiveUrl} → HTTP ${check.status}`);
    return;
  }

  const detail = check.error ? `${check.error}` : `HTTP ${check.status}`;
  const err = new Error(
    `삭제 API는 성공했으나 옛 URL이 아직 살아 있습니다 (${detail}): ${wasLiveUrl}\n`
    + `  + 옛 URL이 응답하는 동안에는 Google 색인에서 제거되지 않고, 새 글을 올리면\n`
    + `    옛 URL → 새 URL redirect로 오인되어 Search Console "리디렉션 오류"가 납니다.\n`
    + (keepTrash
      ? '  + --keep-trash로 실행했으므로 글이 휴지통에 있습니다. Blogger 에디터에서 휴지통을 비우세요.\n'
      : '  + Blogger 에디터의 휴지통이 비어 있는지 확인하세요 (남아 있으면 비우기까지 진행).\n')
    + '  + CDN 캐시일 수도 있으니 몇 분 뒤 위 URL을 직접 열어 404를 재확인하세요.\n'
    + '  + 그래도 200/3xx면 Search Console "삭제" 도구에서 임시 삭제를 요청하세요.',
  );
  err.exitCode = 7;
  throw err;
}

main().catch((err) => {
  console.error('Delete failed:', errFull(err));
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data));
  }
  process.exit(errExitCode(err) || 1);
});
