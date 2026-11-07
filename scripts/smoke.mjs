/**
 * 端到端冒烟测试：用真实 Chrome 打开构建产物，载入示例、导出 EPUB 并校验。
 * 用法：先 `npm run build && npx vite preview --port 4173`，再 `node scripts/smoke.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const OUT = path.resolve('samples');
// Linux CI 用 /tmp；Windows 上 Chrome 无法写入 "/tmp"，换成系统临时目录
const DOWNLOADS =
  process.platform === 'win32'
    ? path.join(os.tmpdir(), 'bookloom-downloads')
    : '/tmp/bookloom-downloads';

fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openRailDialog(page, pane) {
  const trigger = pane === 'export' ? '#rail-export' : `#settings-rail [data-pane="${pane}"]`;
  await page.click(trigger);
  await page.waitForFunction(
    (id) => document.querySelector(`#dialog-${id}`)?.hidden === false,
    {},
    pane,
  );
}

async function closeDialog(page, pane) {
  await page.click(`#dialog-${pane}-close`);
  await page.waitForFunction(
    (id) => document.querySelector(`#dialog-${id}`)?.hidden === true,
    {},
    pane,
  );
}

async function closeDiagDialog(page) {
  await page.click('#diag-dialog-close');
  await page.waitForFunction(() => document.querySelector('#diag-dialog')?.hidden === true, {
    timeout: 5000,
  });
}

async function clearCurrentBook(page) {
  // 删除入口在「书籍信息」弹窗里：打开，再两段式确认
  await openRailDialog(page, 'info');
  await page.evaluate(() => {
    const button = document.querySelector('#clear-draft');
    button.click();
    button.click();
  });
}

async function undoShortcut(page, shift = false) {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}

async function waitForDownload(dir, extensions, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(dir).filter((name) => extensions.some((ext) => name.endsWith(ext)));
    const done = files.find((name) => !fs.readdirSync(dir).some((other) => other === `${name}.crdownload`));
    if (done) {
      const full = path.join(dir, done);
      const size = fs.statSync(full).size;
      await sleep(200);
      if (fs.statSync(full).size === size && size > 0) return full;
    }
    await sleep(150);
  }
  throw new Error(`等待下载超时：${dir}`);
}

async function readSessionIds(page) {
  return page.evaluate(async () => {
    const open = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('bookloom');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    const read = (db, store, run) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readonly');
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const db = await open();
    if (!db.objectStoreNames.contains('books')) {
      db.close();
      return { bookCount: 0, bookIds: [], bookTitles: [] };
    }
    const books = await read(db, 'books', (store) => store.getAll());
    // 软删除只是打了 deletedAt 标记的记录，应用语义里它已经不在书架上
    const active = books.filter((book) => !book.deletedAt);
    const sorted = active.sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = sorted[0];
    if (!latest) {
      db.close();
      return { bookCount: 0, bookIds: [], bookTitles: [] };
    }
    const draft = await read(db, 'drafts', (store) => store.get(`draft:${latest.id}`));
    const source = await read(db, 'drafts', (store) => store.get(`source:${latest.id}`));
    db.close();
    return {
      bookCount: sorted.length,
      bookIds: sorted.map((book) => book.id),
      bookTitles: sorted.map((book) => book.title),
      latestBookId: latest.id,
      draftFilename: draft?.filename ?? null,
      draftSourceId: draft?.sourceId ?? null,
      sourceId: source?.id ?? null,
      hasSource: Boolean(latest.hasSource),
    };
  });
}

async function resetLibrary(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('bookloom');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
  await page.reload({ waitUntil: 'networkidle0' });
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 1 });
  // 主流程先跳过更新公告弹窗，公告本身在最后单独用干净上下文验证
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
  });

  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  // 应用现在有「未保存改动」的 beforeunload 保护，这个弹窗 puppeteer 不会自动关掉
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'beforeunload') await dialog.accept();
    else await dialog.dismiss();
  });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, 'shot-landing.png'), fullPage: true });

  // 页脚已移除，开源地址指向改名后的仓库
  if (await page.$('.footer')) throw new Error('页脚仍存在，应已删除');
  const githubHref = await page.$eval('#github-link', (el) => el.getAttribute('href'));
  if (!githubHref.includes('github.com/xiaoxura/BookLoomWeb')) {
    throw new Error(`开源地址没有换成新仓库：${githubHref}`);
  }
  const bodyText = await page.evaluate(() => document.body.textContent ?? '');
  if (bodyText.includes('%APP_VERSION%') || bodyText.includes('%BUILD_ISO%')) {
    throw new Error('页面存在未替换的占位符');
  }

  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (initialTheme !== 'light' && initialTheme !== 'dark') throw new Error(`初始主题异常：${initialTheme}`);
  await page.click('#theme-toggle');
  const toggledTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (toggledTheme === initialTheme) throw new Error('主题切换没有生效');
  const pressed = await page.$eval('#theme-toggle', (el) => el.getAttribute('aria-pressed'));
  if (pressed !== String(toggledTheme === 'dark')) throw new Error(`主题按钮状态不对：${pressed}`);
  await page.click('#theme-toggle');
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== initialTheme) {
    throw new Error('主题没有切回原来的模式');
  }

  await page.click('#load-sample');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length >= 7, { timeout: 20000 });

  const stats = await page.$eval('#stats', (el) => el.textContent ?? '');
  if (!stats.includes('7 章')) throw new Error(`章节数不对：${stats}`);

  const titles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!titles.includes('第一章 守塔人')) throw new Error(`章节标题缺失：${titles.join(' / ')}`);

  // 搜索
  await page.type('#chapter-search', '第四章');
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 1, { timeout: 10000 });
  const filtered = await page.$eval('.ch-title', (el) => el.value);
  if (filtered !== '第四章 灯还亮着') throw new Error(`搜索过滤不对：${filtered}`);
  await page.evaluate(() => {
    const input = document.querySelector('#chapter-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 7, { timeout: 10000 });

  // 从段落分章，再撤销
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    const target = rows.find((row) => row.querySelector('.ch-title')?.value === '第一章 守塔人');
    target?.querySelector('.ch-title')?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('#preview h2')?.textContent === '第一章 守塔人',
    { timeout: 10000 },
  );
  await page.evaluate(() => document.querySelector('#preview p[data-index="1"]')?.click());
  await page.waitForSelector('#selection-bar:not([hidden])', { timeout: 5000 });
  await page.click('#selection-bar [data-act="split"]');
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 8, { timeout: 10000 });
  const splitTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!splitTitles.includes('新章节')) throw new Error(`分章后没看到新章节：${splitTitles.join(' / ')}`);
  await page.screenshot({ path: path.join(OUT, 'shot-split.png') });
  await page.click('#toast button');
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 7, { timeout: 10000 });

  // E1 撤销 / 重做：删除最后一章 → ⋯菜单 → 删除确认 → Ctrl+Z → Shift+Ctrl+Z → Ctrl+Z
  const draftStampBeforeDelete = await page.$eval('#draft-status', (el) => el.dataset.savedAt ?? '');
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    rows[rows.length - 1].querySelector('.row-menu-btn').click();
  });
  await page.waitForSelector('#row-menu:not([hidden])', { timeout: 5000 });
  await page.evaluate(() => {
    // 两段式确认：第一次只武装按钮，第二次才执行（菜单保持打开）
    const clickDelete = () =>
      [...document.querySelectorAll('#row-menu [data-act="delete"]')].forEach((button) => button.click());
    clickDelete();
    clickDelete();
  });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 6, { timeout: 10000 });
  } catch {
    await page.screenshot({ path: path.join(OUT, 'debug-delete.png') });
    const menuAct = await page.$eval('#row-menu', (el) => ({ hidden: el.hidden, items: [...el.querySelectorAll('button')].map((b) => `${b.dataset.act}:${b.dataset.confirm ?? ''}:${b.disabled ? 'd' : ''}`) }));
    console.log('DEBUG delete state:', JSON.stringify(menuAct));
    throw new Error('删除后行数没变成 6');
  }
  const deleteToast = await page.$eval('#toast', (el) => el.textContent ?? '');
  if (!deleteToast.includes('已删除')) throw new Error(`删除后没有提示：${deleteToast}`);

  await undoShortcut(page);
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 7, { timeout: 10000 });
  if (!(await page.$eval('#undo-btn', (el) => el.disabled))) throw new Error('撤销回到初始状态后撤销按钮仍可用');
  if (await page.$eval('#redo-btn', (el) => el.disabled)) throw new Error('撤销后重做按钮被禁用');

  // 撤销后要重新触发草稿保存
  await page.waitForFunction(
    (previous) => {
      const el = document.querySelector('#draft-status');
      return Boolean(el?.dataset.savedAt) && el.dataset.savedAt !== previous;
    },
    { timeout: 15000 },
    draftStampBeforeDelete,
  );

  await undoShortcut(page, true);
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 6, { timeout: 10000 });
  await undoShortcut(page);
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 7, { timeout: 10000 });
  if (!(await page.$eval('#undo-btn', (el) => el.disabled))) {
    throw new Error('撤销回到初始状态后按钮仍可用');
  }
  if (await page.$eval('#redo-btn', (el) => el.disabled)) {
    throw new Error('回到初始状态后重做按钮不可用');
  }

  // 改标题也进历史：双击标题进入编辑 → 改值 → 失焦 → Ctrl+Z 还原
  const firstTitle = await page.$eval('.chapter-row .ch-title', (el) => el.value);
  await page.evaluate(() => {
    const input = document.querySelector('.chapter-row .ch-title');
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.evaluate(() => {
    const input = document.querySelector('.chapter-row .ch-title.editing');
    input.value = '标题撤销测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await page.waitForFunction(
    () => document.querySelector('.chapter-row .ch-title')?.value === '标题撤销测试',
    { timeout: 5000 },
  );
  await undoShortcut(page);
  await page.waitForFunction(
    (expected) => document.querySelector('.chapter-row .ch-title')?.value === expected,
    { timeout: 10000 },
    firstTitle,
  );

  // E2 批量替换 / 清洗：预览命中数 → 执行 → 撤销
  await openRailDialog(page, 'rules');
  await page.type('#replace-find', '灯塔');
  await page.type('#replace-with', '孤塔');
  await page.select('#replace-scope', 'body');
  await page.click('#replace-preview');
  await page.waitForSelector('#replace-results:not([hidden])', { timeout: 10000 });
  const previewStatus = await page.$eval('#replace-status', (el) => el.textContent ?? '');
  const previewTotal = Number((previewStatus.match(/共命中 ([\d,]+) 处/) ?? [])[1]?.replace(/,/g, ''));
  if (!previewTotal) throw new Error(`替换预览没有命中数：${previewStatus}`);
  const firstHit = await page.$eval('.replace-hit', (el) => el.textContent ?? '');
  if (!firstHit.includes('灯塔')) throw new Error(`替换预览上下文不对：${firstHit}`);
  await page.screenshot({ path: path.join(OUT, 'shot-replace.png') });

  await page.click('#replace-apply');
  await page.waitForFunction(
    () => (document.querySelector('#replace-status')?.textContent ?? '').includes('已替换'),
    { timeout: 15000 },
  );
  const applyStatus = await page.$eval('#replace-status', (el) => el.textContent ?? '');
  const appliedTotal = Number((applyStatus.match(/已替换 ([\d,]+) 处/) ?? [])[1]?.replace(/,/g, ''));
  if (appliedTotal !== previewTotal) {
    throw new Error(`替换计数与预览不一致：预览 ${previewTotal} · 实际 ${appliedTotal}`);
  }

  // 取消焦点后 Ctrl+Z 撤销整次替换
  await page.evaluate(() => document.activeElement?.blur());
  await undoShortcut(page);
  await page.click('#replace-preview');
  await page.waitForFunction(
    () => (document.querySelector('#replace-status')?.textContent ?? '').includes('共命中'),
    { timeout: 10000 },
  );
  const afterUndoHits = await page.$eval('#replace-results', (el) => el.textContent ?? '');
  if (!afterUndoHits.includes('灯塔')) throw new Error('撤销后替换内容没有恢复');
  await closeDialog(page, 'rules');

  // E5 快捷键：↓ / K 切章、/ 聚焦搜索、Esc 关闭浮层、Ctrl+S 导出
  const activeHeading = () => page.$eval('#preview h1, #preview h2', (el) => el.textContent ?? '');
  await page.evaluate(() => document.querySelector('#chapter-search')?.blur());
  const headingBeforeKeys = await activeHeading();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    (previous) => {
      const heading = document.querySelector('#preview h1, #preview h2');
      return Boolean(heading) && heading.textContent !== previous;
    },
    { timeout: 5000 },
    headingBeforeKeys,
  );
  const headingAfterDown = await activeHeading();
  await page.keyboard.press('KeyK');
  await page.waitForFunction(
    (expected) => (document.querySelector('#preview h1, #preview h2')?.textContent ?? '') === expected,
    { timeout: 5000 },
    headingBeforeKeys,
  );

  await page.keyboard.press('/');
  const focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
  if (focusedId !== 'chapter-search') throw new Error(`/ 没有聚焦章节搜索：${focusedId}`);
  // 输入框里单键不切章
  const headingInInput = await activeHeading();
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  if ((await activeHeading()) !== headingInInput) throw new Error('搜索框聚焦时仍触发了切章');
  await page.keyboard.press('Escape');

  // Esc 关闭段落选择浮层
  await page.evaluate(() => document.querySelector('#preview p[data-index="0"]')?.click());
  await page.waitForSelector('#selection-bar:not([hidden])', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#selection-bar')?.hidden === true, {
    timeout: 5000,
  });

  // Ctrl+S 直接导出，并拦下浏览器默认的「保存网页」
  await page.evaluate(() => {
    window.__shortcutDefaultPrevented = null;
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 's') window.__shortcutDefaultPrevented = event.defaultPrevented;
    });
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  const shortcutFile = await waitForDownload(DOWNLOADS, ['.epub'], 30000);
  await page.waitForFunction(
    () => (document.querySelector('#status')?.textContent ?? '').includes('已导出'),
    { timeout: 15000 },
  );
  fs.rmSync(shortcutFile);
  const ctrlSPrevented = await page.evaluate(() => window.__shortcutDefaultPrevented);
  if (ctrlSPrevented !== true) throw new Error('Ctrl+S 没有 preventDefault');
  await page.evaluate(() => {
    delete window.__shortcutDefaultPrevented;
  });

  // 快捷切换后的章节和标题不受影响，回到第一章继续后面的检查
  if (!headingAfterDown) throw new Error('↓ 没有切到下一章');
  await page.evaluate((title) => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    const target = rows.find((row) => row.querySelector('.ch-title')?.value === title);
    target?.querySelector('.ch-title')?.click();
  }, '第一章 守塔人');
  await page.waitForFunction(
    () => document.querySelector('#preview h2')?.textContent === '第一章 守塔人',
    { timeout: 10000 },
  );

  // 元数据 / 封面都在「书籍信息」弹窗里，先打开
  await openRailDialog(page, 'info');
  await page.type('#meta-author', '林间');
  await page.waitForFunction(() => Boolean(document.querySelector('#cover-thumb img')), { timeout: 15000 });
  await sleep(700);

  // X1 元数据：简介 / 系列 / 出版社 / 标签 / 出版日期
  await page.type('#meta-description', '一座灯塔与一封没有寄出的信。');
  await page.type('#meta-series', '雾港三部曲');
  await page.type('#meta-publisher', '潮声出版社');
  await page.type('#meta-tags', '悬疑, 海洋');
  await page.$eval('#meta-published', (el) => {
    el.value = '2026-01-02';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // X3 封面编辑器：配色 / 字号 / 作者位置 → 实时预览与导出封面一致
  await page.select('#cover-palette', 'sea');
  await page.select('#cover-author-position', 'top');
  await page.$eval('#cover-title-scale', (el) => {
    el.value = '1.2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelector('#cover-title-scale-value')?.textContent === '120%',
    { timeout: 5000 },
  );
  await sleep(1300);
  const coverCompare = await page.evaluate(async () => {
    const preview = document.querySelector('#cover-preview');
    const image = document.querySelector('#cover-thumb img');
    if (!preview || !image) return null;
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch {
        /* 已经解码完成 */
      }
    }
    const average = (source) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, 4, 4);
      const data = ctx.getImageData(0, 0, 4, 4).data;
      const sums = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        sums[0] += data[i];
        sums[1] += data[i + 1];
        sums[2] += data[i + 2];
      }
      return sums.map((sum) => sum / (data.length / 4));
    };
    const a = average(preview);
    const b = average(image);
    if (!a || !b) return null;
    return { preview: a, cover: b, maxDiff: Math.max(...a.map((value, index) => Math.abs(value - b[index]))) };
  });
  if (!coverCompare) throw new Error('封面预览或缩略图缺失');
  if (coverCompare.maxDiff > 25) {
    throw new Error(`封面预览与导出图颜色差距过大：${JSON.stringify(coverCompare)}`);
  }
  await page.screenshot({ path: path.join(OUT, 'shot-cover-editor.png') });

  // 恢复自动封面不报错
  await page.click('#cover-remove');
  await page.waitForFunction(() => !document.querySelector('#cover-thumb img'), { timeout: 5000 });
  await page.click('#cover-auto');
  await page.waitForFunction(() => Boolean(document.querySelector('#cover-thumb img')), {
    timeout: 15000,
  });
  await page.click('#cover-reset-options');
  await page.waitForFunction(
    () =>
      document.querySelector('#cover-palette')?.value === 'auto' &&
      document.querySelector('#cover-title-scale-value')?.textContent === '100%',
    { timeout: 5000 },
  );
  await closeDialog(page, 'info');

  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    const target = rows.find((row) => row.querySelector('.ch-title')?.value === '第二章 无名信');
    target?.querySelector('.ch-title')?.click();
  });
  await sleep(400);
  const previewText = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (!previewText.includes('门外站着个女孩')) throw new Error('预览内容与所选章节不符');

  await page.screenshot({ path: path.join(OUT, 'shot-workspace.png') });

  // 新增的排版开关：章号分离 + 附加 CSS
  await openRailDialog(page, 'layout');
  await page.evaluate(() => {
    const css = document.querySelector('#custom-css');
    css.value = 'p { letter-spacing: 0.02em; }';
    css.dispatchEvent(new Event('input', { bubbles: true }));
    const sep = document.querySelector('#separate-number');
    sep.checked = true;
    sep.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await closeDialog(page, 'layout');

  await openRailDialog(page, 'export');
  await page.click('#export');
  const file = await waitForDownload(DOWNLOADS, ['.epub'], 30000);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);

  if (names[0] !== 'mimetype') throw new Error(`mimetype 不是第一个条目：${names[0]}`);
  if (strFromU8(entries['mimetype']) !== 'application/epub+zip') throw new Error('mimetype 内容不对');
  const opf = strFromU8(entries['OEBPS/content.opf']);
  if (!opf.includes('雾港灯塔')) throw new Error('OPF 缺少书名');
  if (!opf.includes('林间')) throw new Error('OPF 缺少作者');
  if (!names.includes('OEBPS/images/cover.jpg')) throw new Error('缺少封面图片');
  if (!names.includes('OEBPS/toc.ncx')) throw new Error('缺少 NCX');
  if (!names.includes('OEBPS/nav.xhtml')) throw new Error('缺少 nav');

  const epubCss = strFromU8(entries['OEBPS/styles/style.css']);
  if (!epubCss.includes('letter-spacing: 0.02em')) throw new Error('附加 CSS 没有写进 EPUB');
  const firstChapter = strFromU8(entries['OEBPS/text/c0003-1.xhtml']);
  if (!firstChapter.includes('chapter-number')) throw new Error('章号没有单独成行');

  // X1 扩展元数据
  if (!opf.includes('<dc:description>一座灯塔与一封没有寄出的信。</dc:description>')) {
    throw new Error('EPUB 缺少简介元数据');
  }
  if (!opf.includes('<dc:publisher>潮声出版社</dc:publisher>')) throw new Error('EPUB 缺少出版社');
  if (!opf.includes('<dc:subject>悬疑</dc:subject>') || !opf.includes('<dc:subject>海洋</dc:subject>')) {
    throw new Error('EPUB 缺少标签');
  }
  if (!opf.includes('<dc:date>2026-01-02</dc:date>')) throw new Error('EPUB 缺少出版日期');
  if (!opf.includes('property="belongs-to-collection" id="series">雾港三部曲</meta>')) {
    throw new Error('EPUB 缺少系列元数据');
  }

  // X2 内嵌目录页：封面之后、正文之前，目录链接能跳到章节
  if (!names.includes('OEBPS/text/toc.xhtml')) throw new Error('EPUB 缺少内嵌目录页');
  const tocPage = strFromU8(entries['OEBPS/text/toc.xhtml']);
  if (!tocPage.includes('href="c0003-1.xhtml"') || !tocPage.includes('第一章 守塔人')) {
    throw new Error('内嵌目录页的章节链接不对');
  }
  const spineOrder = [...(opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] ?? '').matchAll(/idref="([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (spineOrder[0] !== 'cover' || spineOrder[1] !== 'toc-page') {
    throw new Error(`内嵌目录页不在封面之后：${spineOrder.slice(0, 3).join(' / ')}`);
  }

  const status = await page.$eval('#status', (el) => el.textContent ?? '');
  if (!status.includes('已导出')) throw new Error(`导出状态异常：${status}`);

  if (errors.length) throw new Error(`页面报错：\n${errors.join('\n')}`);

  fs.copyFileSync(file, path.join(OUT, 'browser-demo.epub'));
  fs.writeFileSync(path.join(OUT, 'cover-preview.jpg'), entries['OEBPS/images/cover.jpg']);

  // F5 单文件 HTML 导出：样式内联、目录锚点可跳转
  await page.select('#export-format', 'html');
  await page.click('#export');
  const htmlFile = await waitForDownload(DOWNLOADS, ['.html'], 30000);
  const html = fs.readFileSync(htmlFile, 'utf8');
  if (!html.startsWith('<!doctype html>')) throw new Error('HTML 导出缺少 doctype');
  if (!html.includes('雾港灯塔') || !html.includes('第一章 守塔人')) {
    throw new Error('HTML 导出缺少书名或章节');
  }
  if (!html.includes('href="#c-1"') || !html.includes('id="c-1"')) {
    throw new Error('HTML 目录锚点不正确');
  }
  if (html.includes('<script') || html.includes('<link')) throw new Error('HTML 依赖了外部资源');
  fs.rmSync(htmlFile);

  // F5 DOCX 导出：Word 必需的部件和标题样式都在
  await page.select('#export-format', 'docx');
  await page.click('#export');
  const docxFile = await waitForDownload(DOWNLOADS, ['.docx'], 30000);
  const docxEntries = unzipSync(new Uint8Array(fs.readFileSync(docxFile)));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
    if (!docxEntries[name]) throw new Error(`DOCX 缺少 ${name}`);
  }
  const docxBody = strFromU8(docxEntries['word/document.xml']);
  if (!docxBody.includes('Heading1') || !docxBody.includes('Heading2')) {
    throw new Error('DOCX 没有使用标题样式');
  }
  if (
    !docxBody.includes('雾港灯塔') ||
    !docxBody.includes('第一章') ||
    !docxBody.includes('守塔人')
  ) {
    throw new Error('DOCX 缺少书名或章节');
  }
  if (!docxBody.includes('<w:br/>')) throw new Error('DOCX 没有应用「章号单独一行」');
  if (!strFromU8(docxEntries['word/styles.xml']).includes('w:styleId="Normal"')) {
    throw new Error('DOCX 样式表缺少 Normal');
  }
  fs.rmSync(docxFile);
  await page.select('#export-format', 'epub');

  // EPUB 2 兼容模式走一遍完整链路
  fs.rmSync(file);
  await page.select('#epub-version', '2');
  await page.click('#export');
  const file2 = await waitForDownload(DOWNLOADS, ['.epub'], 30000);
  const entries2 = unzipSync(new Uint8Array(fs.readFileSync(file2)));
  const opf2 = strFromU8(entries2['OEBPS/content.opf']);
  if (!opf2.includes('version="2.0"')) throw new Error('EPUB 2 导出没有切换包版本');
  if (entries2['OEBPS/nav.xhtml']) throw new Error('EPUB 2 不应包含 nav.xhtml');
  if (!entries2['OEBPS/toc.ncx']) throw new Error('EPUB 2 缺少 NCX');
  if (!entries2['OEBPS/text/toc.xhtml']) throw new Error('EPUB 2 缺少内嵌目录页');
  if (opf2.includes('belongs-to-collection')) throw new Error('EPUB 2 不应输出系列元数据');
  if (strFromU8(entries2['OEBPS/text/c0001-1.xhtml']).includes('epub:type')) {
    throw new Error('EPUB 2 文档里残留 epub:type');
  }
  fs.rmSync(file2);

  await closeDialog(page, 'export');

  // 脏数据回归：站点水印与第一章标题粘在同一行；
  // 卷首的『状态/内容简介』信息章会自动识别进书籍信息，整章不再显示
  const input = await page.$('#file-input');
  await input.uploadFile(path.resolve('tests/fixtures/messy.txt'));
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 3, { timeout: 20000 });
  const messyTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (messyTitles[0] !== '第1章 穿越重生') throw new Error(`第一章标题未救回：${messyTitles.join(' / ')}`);
  if (messyTitles.some((t) => t.includes('内容简介'))) throw new Error('简介卷首章没有被隐藏');
  const messyPreview = await page.$eval('#preview', (el) => el.textContent ?? '');
  // 简介章被隐藏后，默认打开的第一章就是「第1章 穿越重生」，正文应当正常展示
  if (!messyPreview.includes('尘屑飞扬')) throw new Error('第一章正文没有进预览');
  if (messyPreview.includes('萌师在上')) throw new Error('卷首简介还残留显示');
  const guessedAuthor = await page.$eval('#meta-author', (el) => el.value);
  if (guessedAuthor !== '风与天幕') throw new Error(`作者未自动识别：${guessedAuthor}`);
  const intactStatus = await page.$eval('#meta-status', (el) => el.value);
  if (intactStatus !== '已完结') throw new Error(`连载状态没有识别：${intactStatus}`);
  const intactIntro = await page.$eval('#meta-description', (el) => el.value);
  if (!intactIntro.includes('穿进修仙小说')) throw new Error(`简介没有识别：${intactIntro.slice(0, 40)}`);
  await page.screenshot({ path: path.join(OUT, 'shot-messy.png') });

  // F1 书架：两本书切换、重命名、删除；切换不能丢章节
  await page.click('#shelf-btn');
  await page.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 2, { timeout: 10000 });
  const shelfStorageText = await page.$eval('#shelf-storage', (el) => el.textContent ?? '');
  if (!shelfStorageText.includes('本地书架')) throw new Error(`书架缺少容量信息：${shelfStorageText}`);
  await page.screenshot({ path: path.join(OUT, 'shot-shelf.png') });

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === '雾港灯塔',
    );
    card?.querySelector('[data-shelf-act="open"]')?.click();
  });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ch-title')].some((el) => el.value === '第一章 守塔人'),
    { timeout: 15000 },
  );
  const switchedAuthor = await page.$eval('#meta-author', (el) => el.value);
  if (switchedAuthor !== '林间') throw new Error(`切换后作者信息丢失：${switchedAuthor}`);

  await page.click('#shelf-btn');
  await page.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value !== '雾港灯塔',
    );
    const input = card?.querySelector('.shelf-title');
    if (!input) throw new Error('没找到第二本书');
    input.focus();
    input.value = '书架改名测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.shelf-title')].some((el) => el.value === '书架改名测试'),
    { timeout: 15000 },
  );
  let renamedSession = await readSessionIds(page);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    renamedSession = await readSessionIds(page);
    if (renamedSession.bookTitles.includes('书架改名测试')) break;
    await sleep(100);
  }
  if (!renamedSession.bookTitles.includes('书架改名测试')) {
    throw new Error(`重命名没有写进数据库：${JSON.stringify(renamedSession)}`);
  }

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === '书架改名测试',
    );
    card?.querySelector('[data-shelf-act="delete"]')?.click();
  });
  const deleteConfirmText = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === '书架改名测试',
    );
    return card?.querySelector('[data-shelf-act="delete"]')?.textContent ?? '';
  });
  if (!deleteConfirmText.includes('再点')) throw new Error(`删除没有二次确认：${deleteConfirmText}`);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === '书架改名测试',
    );
    card?.querySelector('[data-shelf-act="delete"]')?.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 1, {
    timeout: 15000,
  });
  const remainingShelfTitles = await page.$$eval('.shelf-title', (els) => els.map((el) => el.value));
  if (!remainingShelfTitles.includes('雾港灯塔')) {
    throw new Error(`删除一本书后书架内容不对：${remainingShelfTitles.join(' / ')}`);
  }
  const shelfSession = await readSessionIds(page);
  if (shelfSession.bookCount !== 1) throw new Error(`书架数量不对：${shelfSession.bookCount}`);
  await page.click('#shelf-close');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 10000 });

  // 诊断：漏掉的标题可以一键设为标题（现在在体检弹窗里查看）
  await input.uploadFile(path.resolve('tests/fixtures/missed.txt'));
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 2, { timeout: 20000 });
  const diagBadge = await page.$eval('#diag-badge', (el) => el.textContent ?? '');
  if (!diagBadge.trim()) throw new Error(`体检按钮徽标没有数量：${diagBadge}`);
  await page.click('#diag-btn');
  await page.waitForSelector('#diag-dialog:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(
    () => (document.querySelector('#diagnostics')?.hidden ?? true) === false,
    { timeout: 10000 },
  );
  const diagCount = await page.$$eval('.diag-item', (els) => els.length);
  if (diagCount !== 1) throw new Error(`诊断数量不对：${diagCount}`);
  await page.screenshot({ path: path.join(OUT, 'shot-diagnostics.png') });
  await page.click('.diag-item [data-role="title"]');
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 3, { timeout: 10000 });
  const fixedTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!fixedTitles.includes('第9章 决战')) throw new Error(`诊断修复失败：${fixedTitles.join(' / ')}`);
  await page.waitForFunction(() => document.querySelectorAll('.diag-item').length === 0, {
    timeout: 10000,
  });

  // E3 全书体检：修好漏章后应报告章号缺号，手动重编号把第 9 章接成第 3 章
  const auditText = await page.$eval('#diag-list', (el) => el.textContent ?? '');
  if (!auditText.includes('章号缺号')) throw new Error(`体检没有报告缺号：${auditText}`);
  if (!auditText.includes('缺少第 3')) throw new Error(`缺号提示不准确：${auditText}`);
  await page.screenshot({ path: path.join(OUT, 'shot-audit.png') });
  await page.click('#audit-renumber');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ch-title')].some((el) => el.value === '第3章 决战'),
    { timeout: 10000 },
  );
  const renumberTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (renumberTitles[0] !== '第1章 开始' || renumberTitles[2] !== '第3章 决战') {
    throw new Error(`重编号结果不对：${renumberTitles.join(' / ')}`);
  }
  const renumberToast = await page.$eval('#toast', (el) => el.textContent ?? '');
  if (!renumberToast.includes('重编号')) throw new Error(`重编号没有提示：${renumberToast}`);
  // 撤销重编号，后面的草稿测试仍从第 9 章开始
  await page.evaluate(() => document.activeElement?.blur());
  await undoShortcut(page);
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ch-title')].some((el) => el.value === '第9章 决战'),
    { timeout: 10000 },
  );
  await closeDiagDialog(page);

  // 本地草稿：改标题 → 等自动保存 → 刷新恢复 → 清除 → 刷新回到首页
  const previousSavedAt = await page.$eval('#draft-status', (el) => el.dataset.savedAt ?? '');
  await page.evaluate(() => {
    const input = document.querySelector('.chapter-row .ch-title');
    input.value = '草稿测试章';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('#draft-status');
      return Boolean(el?.dataset.savedAt) && el.dataset.savedAt !== prev;
    },
    { timeout: 15000 },
    previousSavedAt,
  );

  // 草稿和原文必须带同一个 sourceId
  let session = { draftSourceId: null, sourceId: null };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    session = await readSessionIds(page);
    if (session.draftSourceId && session.draftSourceId === session.sourceId) break;
    await sleep(100);
  }
  if (!session.draftSourceId || session.draftSourceId !== session.sourceId) {
    throw new Error(`草稿与原文没有建立关联：${JSON.stringify(session)}`);
  }

  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.chapter-row .ch-title')?.value === '草稿测试章',
    { timeout: 15000 },
  );
  if (await page.$eval('#reparse', (el) => el.disabled)) throw new Error('恢复草稿后「重新识别」被禁用');
  await openRailDialog(page, 'rules');
  await page.click('#reparse');
  await page.waitForFunction(
    () => (document.querySelector('#status')?.textContent ?? '').includes('识别完成'),
    { timeout: 30000 },
  );
  await closeDialog(page, 'rules');

  // 换书时模拟原文写入失败：新草稿不能继续使用上一本的原文
  await page.evaluate(() => {
    const prototype = IDBObjectStore.prototype;
    const original = prototype.put;
    window.__bookloomOriginalPut = original;
    prototype.put = function (value, key) {
      if (typeof key === 'string' && key.startsWith('source:')) throw new DOMException('模拟原文保存失败', 'QuotaExceededError');
      return original.call(this, value, key);
    };
  });

  // 换一本时必须重新自动检测编码，不能沿用上一本残留的 UTF-8
  const gbkInput = await page.$('#file-input');
  await gbkInput.uploadFile(path.resolve('tests/fixtures/gbk.txt'));
  await page.waitForFunction(
    () => {
      // 编码不再显示在左栏统计里；改从编码下拉的自动检测结果断言
      return (document.querySelector('#stats')?.textContent ?? '').includes('3 章');
    },
    { timeout: 30000 },
  );
  if ((await page.$eval('#encoding', (el) => el.value)) !== 'gb18030') {
    throw new Error('换书后没有重新自动检测出 GB18030 编码');
  }
  const gbkPreview = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (gbkPreview.includes('\uFFFD')) throw new Error('GBK 文件仍被旧编码解码，出现替换符');
  if (!gbkPreview.includes('雾从海面漫上来')) throw new Error('GBK 正文解码错误');

  // 等新书的草稿写入完成：此时 sourceId 已更新，但原文因为被拦截仍是旧的
  for (let attempt = 0; attempt < 100; attempt += 1) {
    session = await readSessionIds(page);
    if (session.draftFilename === 'gbk.txt' && session.draftSourceId) break;
    await sleep(100);
  }
  if (session.draftFilename !== 'gbk.txt' || !session.draftSourceId) {
    throw new Error(`换书后的草稿没有保存：${JSON.stringify(session)}`);
  }
  if (session.sourceId !== null || session.hasSource) {
    throw new Error(`原文写入本应失败，但书架仍标记有原文：${JSON.stringify(session)}`);
  }

  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.__bookloomOriginalPut;
    delete window.__bookloomOriginalPut;
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => (document.querySelector('#warnings')?.textContent ?? '').includes('原文件缺失或已失效'),
    { timeout: 15000 },
  );
  if (!(await page.$eval('#reparse', (el) => el.disabled))) {
    throw new Error('原文与草稿不匹配时仍允许重新识别');
  }
  if (!(await page.$eval('#encoding', (el) => el.disabled))) {
    throw new Error('原文与草稿不匹配时仍允许切换编码');
  }
  const restoredGbk = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (!restoredGbk.includes('雾从海面漫上来')) throw new Error('恢复的草稿不是刚导入的 GBK 文件');

  // 三本书来回切换：书架里同时有样书、missed 和 gbk
  await page.click('#shelf-btn');
  await page.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 3, {
    timeout: 10000,
  });
  const threeBookTitles = await page.$$eval('.shelf-title', (els) => els.map((el) => el.value));
  if (!threeBookTitles.includes('雾港灯塔') || !threeBookTitles.includes('gbk')) {
    throw new Error(`三本书书架内容不对：${threeBookTitles.join(' / ')}`);
  }
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === '雾港灯塔',
    );
    card?.querySelector('[data-shelf-act="open"]')?.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ch-title')].some((el) => el.value === '第一章 守塔人'),
    { timeout: 15000 },
  );
  if ((await page.$eval('#meta-author', (el) => el.value)) !== '林间') {
    throw new Error('三书切换后样书作者丢失');
  }
  await page.click('#shelf-btn');
  await page.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  const clearingBookId = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.shelf-card')].find(
      (item) => item.querySelector('.shelf-title')?.value === 'gbk',
    );
    const id = card?.dataset.id ?? null;
    card?.querySelector('[data-shelf-act="open"]')?.click();
    return id;
  });
  if (!clearingBookId) throw new Error('没找到 gbk 这本书的 id');
  await page.waitForFunction(
    () => (document.querySelector('#preview')?.textContent ?? '').includes('雾从海面漫上来'),
    { timeout: 15000 },
  );

  // 编辑后立刻删除当前书：待执行的自动保存不能再把这本写回来
  const beforeClear = await readSessionIds(page);
  await page.evaluate(() => {
    const input = document.querySelector('.chapter-row .ch-title');
    input.value = '清除竞争测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clearCurrentBook(page);
  await page.waitForFunction(
    () => (document.querySelector('#draft-status')?.textContent ?? '').includes('已从书架删除'),
    { timeout: 10000 },
  );
  await sleep(2000);
  const cleared = await readSessionIds(page);
  if (cleared.bookIds.includes(clearingBookId)) {
    throw new Error(`删除当前书后书架里仍然有它：${JSON.stringify(cleared)}`);
  }
  if (cleared.bookCount !== beforeClear.bookCount - 1) {
    throw new Error(`删除当前书后书架数量不对：${JSON.stringify({ beforeClear, cleared })}`);
  }
  await page.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });

  // 后面从干净的落地页开始
  await resetLibrary(page);
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 15000 });

  // 批量转换：两本 → 一个 ZIP
  const batchInput = await page.$('#file-input');
  await batchInput.uploadFile(path.resolve('public/sample.txt'), path.resolve('tests/fixtures/messy.txt'));
  await page.waitForSelector('#batch:not([hidden])', { timeout: 15000 });
  // 批量完成后不再自动打包下载：等状态就绪，手动点「下载 ZIP」
  await page.waitForFunction(
    () => (document.querySelector('#batch-status')?.textContent ?? '').includes('完成'),
    { timeout: 90000 },
  );
  await page.click('#batch-download');
  await page.waitForFunction(
    () => (document.querySelector('#batch-status')?.textContent ?? '').includes('已打包'),
    { timeout: 90000 },
  );
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'shot-batch.png') });
  const zipFile = await waitForDownload(DOWNLOADS, ['.zip'], 30000);
  const outer = unzipSync(new Uint8Array(fs.readFileSync(zipFile)));
  const epubNames = Object.keys(outer).filter((name) => name.endsWith('.epub'));
  if (epubNames.length !== 2) throw new Error(`批量 ZIP 里的 EPUB 数量不对：${epubNames.join(', ')}`);
  for (const name of epubNames) {
    const inner = unzipSync(outer[name]);
    if (!inner['mimetype']) throw new Error(`${name} 不是合法 EPUB`);
  }
  await page.click('#batch-close');
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 10000 });

  // EPUB 导入 → TXT 导出：互转链路走一遍
  const epubInput = await page.$('#file-input');
  await epubInput.uploadFile(path.resolve('samples/demo.epub'));
  await page.waitForFunction(
    () => (document.querySelector('#stats')?.textContent ?? '').includes('EPUB'),
    { timeout: 30000 },
  );
  const epubTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!epubTitles.includes('第一章 守塔人')) throw new Error(`EPUB 导入缺少章节：${epubTitles.join(' / ')}`);
  if (!epubTitles.includes('第一卷 潮声')) throw new Error(`EPUB 导入丢了卷层级：${epubTitles.join(' / ')}`);
  if (!(await page.$('#cover-thumb img'))) throw new Error('EPUB 封面没有带出来');
  if (!(await page.$eval('#encoding', (el) => el.disabled))) throw new Error('导入 EPUB 后仍允许切换编码');
  if (!(await page.$eval('#reparse', (el) => el.disabled))) throw new Error('导入 EPUB 后仍允许重新识别');

  await openRailDialog(page, 'export');
  await page.select('#export-format', 'txt');
  await page.click('#export');
  const txtFile = await waitForDownload(DOWNLOADS, ['.txt'], 30000);
  const txt = fs.readFileSync(txtFile, 'utf8');
  if (!txt.includes('第一章 守塔人')) throw new Error('导出的 TXT 缺少章节标题');
  if (!txt.includes('雾是从凌晨四点开始漫上礁石的')) throw new Error('导出的 TXT 缺少正文');
  fs.rmSync(txtFile);
  await page.select('#export-format', 'epub');
  await closeDialog(page, 'export');

  // 删掉这本 EPUB 的书架记录，再清空书架给后面的页面一个干净的落地页
  const beforeEpubClear = await readSessionIds(page);
  await clearCurrentBook(page);
  await page.waitForFunction(
    () => (document.querySelector('#draft-status')?.textContent ?? '').includes('已从书架删除'),
    { timeout: 10000 },
  );
  const afterEpubClear = await readSessionIds(page);
  if (afterEpubClear.bookCount !== beforeEpubClear.bookCount - 1) {
    throw new Error(`删除 EPUB 后书架数量不对：${JSON.stringify({ beforeEpubClear, afterEpubClear })}`);
  }
  await resetLibrary(page);
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 15000 });

  // F3 DOCX 导入：按标题样式还原卷章，DOCX 不需要再选编码 / 重新识别
  const docxInput = await page.$('#file-input');
  await docxInput.uploadFile(path.resolve('tests/fixtures/docx-demo.docx'));
  await page.waitForFunction(
    () => {
      const stats = document.querySelector('#stats')?.textContent ?? '';
      return stats.includes('DOCX') && stats.includes('3 章');
    },
    { timeout: 30000 },
  );
  const docxTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!docxTitles.includes('第一卷 潮声') || !docxTitles.includes('第一章 守塔人')) {
    throw new Error(`DOCX 卷章还原失败：${docxTitles.join(' / ')}`);
  }
  if ((await page.$eval('#meta-author', (el) => el.value)) !== '林间') {
    throw new Error('DOCX 作者信息没有读出来');
  }
  if (!(await page.$eval('#encoding', (el) => el.disabled))) throw new Error('导入 DOCX 后仍允许切换编码');
  if (!(await page.$eval('#reparse', (el) => el.disabled))) throw new Error('导入 DOCX 后仍允许重新识别');
  const docxPreview = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (!docxPreview.includes('DOCX 导入的第一段正文')) throw new Error('DOCX 正文没有进预览');
  await page.screenshot({ path: path.join(OUT, 'shot-docx.png') });

  // DOCX 草稿刷新后可以恢复
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => (document.querySelector('#stats')?.textContent ?? '').includes('DOCX'),
    { timeout: 15000 },
  );
  const restoredDocxTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!restoredDocxTitles.includes('第一章 守塔人')) {
    throw new Error(`DOCX 草稿恢复失败：${restoredDocxTitles.join(' / ')}`);
  }
  await resetLibrary(page);
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 15000 });

  // F2 繁简转换：简体 → 繁体 → 刷新后保留 → 切回简体
  await page.click('#load-sample');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length >= 7);
  const convertBefore = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (!convertBefore.includes('雾港的灯塔')) throw new Error('繁简测试的原始正文不对');
  await page.select('#convert', 'traditional');
  await page.waitForFunction(
    () => (document.querySelector('#preview')?.textContent ?? '').includes('霧港的燈塔'),
    { timeout: 30000 },
  );
  const traditionalTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!traditionalTitles.includes('第一卷 潮聲')) {
    throw new Error(`繁简转换没有作用于章节标题：${traditionalTitles.join(' / ')}`);
  }
  await page.waitForFunction(
    () => (document.querySelector('#draft-status')?.textContent ?? '').includes('草稿已自动保存'),
    { timeout: 15000 },
  );
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => (document.querySelector('#preview')?.textContent ?? '').includes('霧港的燈塔'),
    { timeout: 15000 },
  );
  if ((await page.$eval('#convert', (el) => el.value)) !== 'traditional') {
    throw new Error('刷新后繁简转换选项没有恢复');
  }
  await page.select('#convert', 'none');
  await page.waitForFunction(
    () => (document.querySelector('#preview')?.textContent ?? '').includes('雾港的灯塔'),
    { timeout: 30000 },
  );
  const restoredTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!restoredTitles.includes('第一卷 潮声')) {
    throw new Error(`切回简体后标题没有恢复：${restoredTitles.join(' / ')}`);
  }
  await page.screenshot({ path: path.join(OUT, 'shot-convert.png') });

  await resetLibrary(page);
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 15000 });

  // Worker 崩溃：待处理请求要被拒绝，不能卡在「处理中」，下次操作要能重建 Worker
  const crashContext = await browser.createBrowserContext();
  const crashPage = await crashContext.newPage();
  await crashPage.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await crashPage.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
  });
  const crashClient = await crashPage.createCDPSession();
  await crashClient.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
  });
  await crashPage.goto(BASE, { waitUntil: 'networkidle0' });
  await crashPage.click('#load-sample');
  await crashPage.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await crashPage.waitForFunction(() => document.querySelectorAll('.chapter-row').length >= 7);
  const workers = crashPage.workers();
  if (!workers.length) throw new Error('页面没有启动 Worker');
  await workers[0].evaluate(() => {
    setTimeout(() => {
      throw new Error('模拟 Worker 崩溃');
    }, 0);
  });
  await crashPage.waitForFunction(
    () => (document.querySelector('#status')?.textContent ?? '').includes('处理过程意外中断'),
    { timeout: 15000 },
  );
  const crashState = await crashPage.evaluate(() => ({
    toast: document.querySelector('#toast')?.textContent ?? '',
    reparseDisabled: Boolean(document.querySelector('#reparse')?.disabled),
    exportDisabled: Boolean(document.querySelector('#export')?.disabled),
  }));
  if (!crashState.toast.includes('已重置')) throw new Error(`Worker 崩溃后没有提示重置：${crashState.toast}`);
  if (!crashState.reparseDisabled) throw new Error('Worker 崩溃后仍允许重新识别');
  if (crashState.exportDisabled) throw new Error('Worker 崩溃后导出按钮仍被禁用，可能卡在忙碌状态');

  await openRailDialog(crashPage, 'export');
  await crashPage.click('#export');
  const crashFile = await waitForDownload(DOWNLOADS, ['.epub'], 30000);
  fs.rmSync(crashFile);
  await crashContext.close();

  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
  });
  await mobile.goto(BASE, { waitUntil: 'networkidle0' });
  await mobile.click('#load-sample');
  await mobile.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await sleep(1200);
  await mobile.evaluate(() => {
    const rows = [...document.querySelectorAll('.chapter-row')];
    const target = rows.find((row) => row.querySelector('.ch-title')?.value === '第一章 守塔人');
    target?.querySelector('.ch-title')?.click();
  });
  await sleep(300);
  await mobile.evaluate(() => document.querySelector('#preview p[data-index="1"]')?.click());
  await sleep(300);
  const mobileOverflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  if (!mobileOverflow) throw new Error('390 宽度下出现横向溢出');
  await mobile.screenshot({ path: path.join(OUT, 'shot-mobile.png') });

  await mobile.click('#shelf-btn');
  await mobile.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  await mobile.waitForFunction(() => document.querySelectorAll('.shelf-card').length >= 1, {
    timeout: 10000,
  });
  const mobileShelfOverflow = await mobile.evaluate(() => {
    const list = document.querySelector('#shelf-list');
    return Boolean(list) && list.scrollWidth <= list.clientWidth + 1;
  });
  if (!mobileShelfOverflow) throw new Error('390 宽度下书架出现横向溢出');
  await mobile.screenshot({ path: path.join(OUT, 'shot-mobile-shelf.png') });
  await mobile.close();

  // 1024 宽度：三栏压缩后不出现横向溢出
  const tablet = await browser.newPage();
  await tablet.setViewport({ width: 1024, height: 900, deviceScaleFactor: 1 });
  await tablet.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
  });
  await tablet.goto(BASE, { waitUntil: 'networkidle0' });
  // 前面的页面可能留下草稿，恢复后工作区会直接出现
  if (await tablet.$eval('#drop-zone', (el) => !el.hidden)) {
    await tablet.click('#load-sample');
  }
  await tablet.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await tablet.waitForFunction(() => document.querySelectorAll('.chapter-row').length >= 7);
  const tabletOverflow = await tablet.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  if (!tabletOverflow) throw new Error('1024 宽度下出现横向溢出');
  await tablet.screenshot({ path: path.join(OUT, 'shot-1024.png') });
  await tablet.close();

  // 旧版单草稿自动迁移：隔离上下文里先造一个 v1 数据库，再打开首页
  const migrationContext = await browser.createBrowserContext();
  const migrationPage = await migrationContext.newPage();
  await migrationPage.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await migrationPage.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
  });
  // 先在同源的静态页（不运行应用脚本）里预置 v1 数据库，再打开首页触发迁移
  await migrationPage.goto(`${BASE}robots.txt`, { waitUntil: 'networkidle0' });
  await migrationPage.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('bookloom', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('drafts');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('drafts', 'readwrite');
          const store = transaction.objectStore('drafts');
          const draft = {
            version: 2,
            savedAt: Date.parse('2026-01-01T00:00:00Z'),
            filename: '迁移旧书.txt',
            meta: { title: '迁移旧书', author: '旧作者', language: 'zh-CN' },
            chapters: [{ id: 'ch-1', title: '第一章 迁移', level: 2, paragraphs: ['迁移后的正文。'] }],
            layout: { lineHeight: 1.75, indent: true, paragraphSpacing: 0, font: 'serif', justify: true },
            cover: null,
            coverAuto: true,
            activeId: 'ch-1',
            options: { encoding: 'auto', filterAds: true },
            parse: {
              encoding: 'utf-8',
              confidence: 1,
              chars: 8,
              warnings: [],
              titleGuess: '迁移旧书',
              authorGuess: '旧作者',
            },
            sourceId: 'migrate-src',
          };
          store.put(draft, 'current');
          store.put(
            { id: 'migrate-src', name: '迁移旧书.txt', data: new Uint8Array([49, 50]).buffer },
            'source',
          );
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await migrationPage.goto(BASE, { waitUntil: 'networkidle0' });
  await migrationPage.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await migrationPage.waitForFunction(
    () => document.querySelector('#preview h2')?.textContent === '第一章 迁移',
    { timeout: 15000 },
  );
  const migratedAuthor = await migrationPage.$eval('#meta-author', (el) => el.value);
  if (migratedAuthor !== '旧作者') throw new Error(`迁移后作者丢失：${migratedAuthor}`);
  if (await migrationPage.$eval('#reparse', (el) => el.disabled)) {
    throw new Error('迁移后原文不可用，重新识别被禁用');
  }
  await migrationPage.click('#shelf-btn');
  await migrationPage.waitForSelector('#shelf:not([hidden])', { timeout: 10000 });
  const migratedTitles = await migrationPage.$$eval('.shelf-title', (els) => els.map((el) => el.value));
  if (!migratedTitles.includes('迁移旧书')) {
    throw new Error(`迁移后的书没有进书架：${migratedTitles.join(' / ')}`);
  }
  await migrationPage.screenshot({ path: path.join(OUT, 'shot-migrated-shelf.png') });
  await migrationContext.close();

  // 无痕 / 禁用 IndexedDB：要提示降级，但不能卡住导入和编辑
  const degradedContext = await browser.createBrowserContext();
  const degradedPage = await degradedContext.newPage();
  await degradedPage.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await degradedPage.evaluateOnNewDocument(() => {
    localStorage.setItem('bookloom.noticeSeen', 'welcome-2026-11');
    try {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    } catch {
      /* 某些环境禁止覆盖，忽略 */
    }
  });
  await degradedPage.goto(BASE, { waitUntil: 'networkidle0' });
  await degradedPage.waitForFunction(
    () => (document.querySelector('#toast')?.textContent ?? '').includes('本地书架不可用'),
    { timeout: 10000 },
  );
  await degradedPage.click('#load-sample');
  await degradedPage.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
  await degradedPage.waitForFunction(
    () => document.querySelector('#draft-status')?.classList.contains('error') === true,
    { timeout: 15000 },
  );
  await degradedContext.close();

  // 更新公告：首访只显示提示条 → 主动打开弹窗 → 关闭 → 图标重开 → Esc → 刷新不再出现
  const noticeContext = await browser.createBrowserContext();
  const noticePage = await noticeContext.newPage();
  await noticePage.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 });
  await noticePage.goto(BASE, { waitUntil: 'networkidle0' });
  await noticePage.waitForSelector('#notice-banner:not([hidden])', { timeout: 8000 });
  if (!(await noticePage.$eval('#notice', (el) => el.hidden))) {
    throw new Error('首访公告不应再自动弹窗阻塞操作');
  }
  await noticePage.screenshot({ path: path.join(OUT, 'shot-notice-banner.png') });
  await noticePage.click('#notice-banner-more');
  await noticePage.waitForSelector('#notice:not([hidden])', { timeout: 5000 });
  const noticeTitle = await noticePage.$eval('#notice-title', (el) => el.textContent ?? '');
  if (!noticeTitle.includes('开始之前')) throw new Error(`公告标题异常：${noticeTitle}`);
  await noticePage.screenshot({ path: path.join(OUT, 'shot-notice.png') });
  await noticePage.click('#notice-ok');
  await noticePage.waitForFunction(() => document.querySelector('#notice')?.hidden === true, {
    timeout: 5000,
  });
  const dotAfterClose = await noticePage.$eval('#notice-btn', (el) => el.classList.contains('has-dot'));
  if (dotAfterClose) throw new Error('看完公告后未读红点没有消失');
  await noticePage.click('#notice-btn');
  await noticePage.waitForFunction(() => document.querySelector('#notice')?.hidden === false, {
    timeout: 5000,
  });
  await noticePage.keyboard.press('Escape');
  await noticePage.waitForFunction(() => document.querySelector('#notice')?.hidden === true, {
    timeout: 5000,
  });
  await noticePage.reload({ waitUntil: 'networkidle0' });
  await sleep(600);
  if (!(await noticePage.$eval('#notice', (el) => el.hidden))) throw new Error('刷新后公告又自动弹出来了');
  if (!(await noticePage.$eval('#notice-banner', (el) => el.hidden))) {
    throw new Error('刷新后首访提示条又出现了');
  }
  await noticeContext.close();

  console.log(`SMOKE OK · ${path.basename(file)} · ${bytes.length} bytes · ${stats}`);
} finally {
  await browser.close();
}
