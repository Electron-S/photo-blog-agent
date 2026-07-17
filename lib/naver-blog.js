const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSION_FILE = '.naver-session.json';

async function loadSessionState() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE}. Run 'npm run naver:login' first.`);
  }
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load session: ${err.message}`);
  }
}

async function saveSessionState(storageState) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');
}

async function launchBrowser() {
  return chromium.launch();
}

async function createAuthenticatedContext(browser) {
  const sessionState = await loadSessionState();
  const context = await browser.newContext({ storageState: sessionState });
  return context;
}

async function loginToNaver(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('네이버 로그인 페이지로 이동 중...');
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });

  console.log('브라우저에서 로그인을 완료해주세요. (타임아웃: 5분)');

  try {
    await page.waitForNavigation({ timeout: 5 * 60 * 1000, waitUntil: 'networkidle' });
  } catch (err) {
    console.error('로그인 타임아웃 또는 실패:', err.message);
    await context.close();
    throw err;
  }

  const storageState = await context.storageState();
  await context.close();

  return storageState;
}

async function createDraftPost(context, { title, blocks, images, category, tags }) {
  const page = await context.newPage();

  try {
    console.log('네이버 블로그 글쓰기 에디터로 이동 중...');
    await page.goto('https://blog.naver.com/NaverBlogCreate.naver', { waitUntil: 'networkidle', timeout: 30000 });

    // 제목 입력
    console.log('제목 입력 중...');
    const titleInput = page.locator('input[name="title"], input[placeholder*="제목"], input.se-input-title');
    await titleInput.first().fill(title);

    // 본문 블록 삽입 (순서대로 문단/이미지 교대로)
    console.log('본문 블록 삽입 중...');
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'paragraph') {
        await insertParagraph(page, block.text, i);
      } else if (block.type === 'image') {
        const imageUrl = images[block.imageIndex];
        if (imageUrl) {
          await insertImage(page, imageUrl);
        }
      }
    }

    // 카테고리/태그 설정
    if (category) {
      await setCategory(page, category);
    }
    if (tags && tags.length > 0) {
      await setTags(page, tags);
    }

    // 임시저장
    console.log('글을 임시저장 중...');
    const saveButton = page.locator('button:has-text("임시저장"), button.btn-post-save');
    await saveButton.first().click();
    await page.waitForTimeout(2000);

    console.log('✓ 네이버 블로그 글 생성 완료 (임시저장함)');

    // 발행 전까지의 post ID 반환 (네이버는 발행 후에만 logNo가 정해짐)
    return {
      id: null,
      status: 'DRAFT',
      url: page.url(),
      message: '임시저장 완료. 발행 시 최종 URL이 결정됩니다.',
    };
  } finally {
    await page.close();
  }
}

async function insertParagraph(page, text, blockIndex) {
  const editorArea = page.locator('.se-wrapper, .naver_editor, [contenteditable="true"]').first();

  if (blockIndex === 0) {
    await editorArea.click();
  } else {
    await editorArea.press('End');
    await editorArea.press('Enter');
  }

  await editorArea.type(text);
  await editorArea.press('Enter');
}

async function insertImage(page, imagePath) {
  const uploadButton = page.locator('button:has-text("사진"), button[title*="사진"], .se-image-insert');
  await uploadButton.first().click();

  await page.waitForTimeout(500);

  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.isVisible()) {
    await fileInput.setInputFiles(imagePath);
    await page.waitForTimeout(2000);
  }
}

async function setCategory(page, category) {
  const categorySelect = page.locator('select[name="category"], .select-category');
  if (await categorySelect.isVisible()) {
    await categorySelect.first().selectOption(category);
  }
}

async function setTags(page, tags) {
  const tagsInput = page.locator('input[name="tag"], input[placeholder*="태그"]');
  if (await tagsInput.isVisible()) {
    const tagsStr = tags.join(',');
    await tagsInput.first().fill(tagsStr);
  }
}

async function publishPost(context, { isDraft = false }) {
  const page = await context.newPage();

  try {
    // 현재 페이지가 에디터라고 가정 (실제로는 context 유지 필요)
    const publishButton = page.locator('button:has-text("발행"), button.btn-publish');
    const draftButton = page.locator('button:has-text("임시저장"), button.btn-draft');

    if (isDraft) {
      await draftButton.first().click();
    } else {
      await publishButton.first().click();
    }

    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log(`✓ 네이버 블로그 글 ${isDraft ? '임시저장' : '발행'} 완료: ${finalUrl}`);

    return {
      status: isDraft ? 'DRAFT' : 'PUBLISHED',
      url: finalUrl,
    };
  } finally {
    await page.close();
  }
}

module.exports = {
  loadSessionState,
  saveSessionState,
  launchBrowser,
  createAuthenticatedContext,
  loginToNaver,
  createDraftPost,
  publishPost,
};
