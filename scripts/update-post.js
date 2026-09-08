require('dotenv').config();

const fs = require('fs');
const { updatePost } = require('../lib/blogger');
const { getArg, validateKnownFlags } = require('../lib/cli-args');
const { lintDraftHtml, formatLintReport, validateUploadResult } = require('../lib/lint-draft');
const { verifyImageUrls } = require('../lib/verify-images');
const { errFull, reportFatal } = require('../lib/err-text');

function printUsage() {
  console.log('Usage: node update-post.js --post-id ID [--title "제목"] [--content "HTML 본문"] [--labels "라벨1,라벨2"]');
  console.log('');
  console.log('Options:');
  console.log('  --post-id   Blogger post ID (필수)');
  console.log('  --title     수정할 제목 (생략하면 기존 제목 유지)');
  console.log('  --content   수정할 HTML 본문 (생략하면 기존 본문 유지, 파일 경로도 가능)');
  console.log('  --labels    라벨 (쉼표 구분, 생략하면 기존 라벨 유지)');
  console.log('  --upload-result  upload-images.js --output 결과 JSON (--content와 함께 쓸 때만 의미 있음)');
  console.log('');
  console.log('종료 코드: 0=성공, 1=일반 실패, 8=초안 lint 규칙 위반');
  process.exit(1);
}

async function main() {
  validateKnownFlags(['--post-id', '--title', '--content', '--labels', '--upload-result']);

  const postId = getArg('--post-id');
  const title = getArg('--title');
  let content = getArg('--content');
  const labelsArg = getArg('--labels');
  const uploadResultPath = getArg('--upload-result');

  if (!postId) {
    console.error('Error: --post-id is required');
    printUsage();
  }

  // content가 '<'를 포함하지 않으면 인라인 HTML이 아니므로 파일 경로로 간주.
  // 존재하지 않으면 fail-fast — 경로 문자열을 본문으로 그대로 PUT하는 사고 방지.
  if (content && !content.includes('<')) {
    if (!fs.existsSync(content)) {
      console.error(`Error: --content에 '<'가 없어 파일 경로로 해석했지만 "${content}"가 존재하지 않습니다. 인라인 HTML 또는 실제 파일 경로를 넘기세요.`);
      process.exit(1);
    }
    try {
      content = fs.readFileSync(content, 'utf8');
    } catch (err) {
      console.error(`Error reading content file: ${errFull(err)}`);
      process.exit(1);
    }
  }

  const updateData = {};
  if (title) updateData.title = title;
  if (content) updateData.content = content;
  if (labelsArg) {
    const labels = labelsArg.split(',').map((l) => l.trim()).filter(Boolean);
    // **빈 배열을 조용히 보내지 않는다.** `if (labelsArg)`는 "플래그가 왔는가"만
    // 보는데 `filter(Boolean)`이 빈 배열을 낼 수 있고, 그것이 PATCH에 실리면
    // **라벨이 전량 삭제**된다 (실측: `--labels ","`·`--labels " "` -> exit 0,
    // 경고 0건). `--labels ""`(보존)과 `--labels " "`(삭제)가 정반대 의미였다.
    // 워크플로우가 `--labels "$LABELS"`로 호출하고 join 결과가 비면 SEO 라벨
    // 5~10개가 아무 표시 없이 사라진다 — CLAUDE.md가 보장한 "생략 시 보존"과
    // 반대 방향이다.
    if (labels.length === 0) {
      console.error(`Error: --labels에 유효한 라벨이 없습니다 (받음: ${JSON.stringify(labelsArg)}).`);
      console.error('  라벨을 **보존**하려면 --labels를 아예 생략하세요 (PATCH에 labels를 넣지 않습니다).');
      // 라벨을 **비우는** 방법이 없다는 것을 명시한다. 안 적어 두면 사용자가
      // `--labels ""`, `--labels " "`, `--labels ","`를 번갈아 시도하게 된다.
      console.error('  라벨을 전량 비우는 것은 지원하지 않습니다 — Blogger 편집기에서 직접 지우세요.');
      process.exit(1);
    }
    updateData.labels = labels;
  }

  if (Object.keys(updateData).length === 0) {
    console.error('Error: at least one of --title, --content, or --labels is required');
    printUsage();
  }

  // --content가 없으면 검증할 본문 자체가 넘어오지 않는다. Blogger에서 현재 본문을
  // GET해서 lint하지는 않는다 — 라벨 하나 고치려던 호출이 예상 밖 exit 8로 죽으면
  // 수정 루프가 막힌다. 다만 검증을 건너뛴다는 사실은 조용히 넘기지 않는다.
  if (content) {
    let uploadResult;
    if (uploadResultPath) {
      try {
        uploadResult = JSON.parse(fs.readFileSync(uploadResultPath, 'utf8'));
      } catch (err) {
        console.error(`Error: --upload-result를 읽을 수 없음 (${uploadResultPath}): ${errFull(err)}`);
        process.exit(1);
      }
      const shape = validateUploadResult(uploadResult, `--upload-result "${uploadResultPath}"`);
      if (!shape.ok) {
        console.error(`Error: ${shape.error}`);
        process.exit(1);
      }
    }

    console.log('Linting draft HTML...');
    const lint = lintDraftHtml(content, { uploadResult });
    if (lint.warnings.length) {
      console.warn(formatLintReport(lint, { only: 'warn' }));
    }
    if (!lint.ok) {
      console.error(formatLintReport(lint, { only: 'error' }));
      console.error(`stats: ${JSON.stringify(lint.stats)}`);
      const err = new Error('초안 HTML 규칙 위반으로 글 수정을 중단합니다. 전체 findings는 `node scripts/lint-draft.js <파일> --format json`으로 확인하세요.');
      err.exitCode = 8;
      throw err;
    }
    if (lint.stats.dimensionCheck === 'skipped') {
      console.log('Draft lint passed. (--upload-result 미지정 — img 치수 대조는 건너뜀)');
    } else if (lint.stats.dimensionCheck !== 'ok') {
      console.log(`Draft lint passed. (치수 대조 커버리지 ${lint.stats.dimensionCheck})`);
    } else {
      console.log('Draft lint passed.');
    }

    console.log('Verifying image URLs...');
    const imageCheck = await verifyImageUrls(content);
    if (!imageCheck.ok) {
      console.error('Broken image URLs found:');
      // reason을 버리지 않는다 — 이유는 scripts/create-draft.js의 같은 지점 주석 참조.
      for (const { url, status, reason, attempts } of imageCheck.broken) {
        const detail = reason ? ` (${reason})` : '';
        const tries = attempts > 1 ? ` [${attempts}회 시도]` : '';
        console.error(`  ${status || 'ERR'}${tries}: ${url}${detail}`);
      }
      process.exit(1);
    }
  } else {
    console.error('[update-post] --content 미지정 — 본문 lint/이미지 URL 검증을 생략합니다 (본문 미변경).');
    if (uploadResultPath) {
      console.error('[update-post] --upload-result는 --content와 함께 쓸 때만 의미가 있습니다 — 무시합니다.');
    }
  }

  console.log(`Updating Blogger post ${postId}...`);
  const post = await updatePost(postId, updateData);

  console.log(JSON.stringify({
    id: post.id,
    title: post.title,
    status: post.status,
    url: post.url,
    editUrl: `https://www.blogger.com/blog/post/edit/${process.env.BLOGGER_BLOG_ID}/${post.id}`,
  }, null, 2));
}

main().catch((err) => {
  // 핸들러가 err를 직접 만지지 않는다 — reportFatal이 message/stack/response.data와
  // exit 코드를 전부 가드해서 꺼낸다 (`Promise.reject(null)`에서도 죽지 않는다).
  //
  // exit 8(lint 위반)은 **정책적 거부**이지 버그가 아니므로 스택 트레이스를 내지
  // 않는다 — lint-draft.js와 같은 모양이어야 사용자가 "무엇을 고쳐야 하는지"만 본다.
  process.exit(reportFatal(err, 'Post update failed:', { quietStackFor: [8] }));
});