/**
 * 端到端冒烟测试：用真实 Chrome 打开构建产物，载入示例、导出 EPUB 并校验。
 * 用法：先 `npm run build && npx vite preview --port 4173`，再 `node scripts/smoke.mjs`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const OUT = path.resolve('samples');
const DOWNLOADS = '/tmp/txt2book-downloads';

fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, 'shot-landing.png'), fullPage: true });

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

  await page.type('#meta-author', '林间');
  await page.waitForFunction(() => Boolean(document.querySelector('#cover-thumb img')), { timeout: 15000 });
  await sleep(700);

  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    const target = rows.find((row) => row.querySelector('.ch-title')?.value === '第二章 无名信');
    target?.querySelector('.ch-title')?.click();
  });
  await sleep(400);
  const previewText = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (!previewText.includes('门外站着个女孩')) throw new Error('预览内容与所选章节不符');

  await page.screenshot({ path: path.join(OUT, 'shot-workspace.png') });

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

  const status = await page.$eval('#status', (el) => el.textContent ?? '');
  if (!status.includes('已导出')) throw new Error(`导出状态异常：${status}`);

  if (errors.length) throw new Error(`页面报错：\n${errors.join('\n')}`);

  fs.copyFileSync(file, path.join(OUT, 'browser-demo.epub'));
  fs.writeFileSync(path.join(OUT, 'cover-preview.jpg'), entries['OEBPS/images/cover.jpg']);

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
  if (strFromU8(entries2['OEBPS/text/c0001-1.xhtml']).includes('epub:type')) {
    throw new Error('EPUB 2 文档里残留 epub:type');
  }
  fs.rmSync(file2);

  // 脏数据回归：站点水印与第一章标题粘在同一行
  const input = await page.$('#file-input');
  await input.uploadFile(path.resolve('tests/fixtures/messy.txt'));
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 4, { timeout: 20000 });
  const messyTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (messyTitles[1] !== '第1章穿越重生') throw new Error(`第一章标题未救回：${messyTitles.join(' / ')}`);
  const messyPreview = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (messyPreview.includes('尘屑飞扬')) throw new Error('第一章正文仍被并入卷首');
  const guessedAuthor = await page.$eval('#meta-author', (el) => el.value);
  if (guessedAuthor !== '风与天幕') throw new Error(`作者未自动识别：${guessedAuthor}`);
  await page.screenshot({ path: path.join(OUT, 'shot-messy.png') });

  // 诊断：漏掉的标题可以一键设为标题
  await input.uploadFile(path.resolve('tests/fixtures/missed.txt'));
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 2, { timeout: 20000 });
  await page.waitForSelector('#diagnostics:not([hidden])', { timeout: 10000 });
  const diagCount = await page.$$eval('.diag-item', (els) => els.length);
  if (diagCount !== 1) throw new Error(`诊断数量不对：${diagCount}`);
  await page.screenshot({ path: path.join(OUT, 'shot-diagnostics.png') });
  await page.click('.diag-item [data-role="title"]');
  await page.waitForFunction(() => document.querySelectorAll('.chapter-row').length === 3, { timeout: 10000 });
  const fixedTitles = await page.$$eval('.ch-title', (els) => els.map((el) => el.value));
  if (!fixedTitles.includes('第9章 决战')) throw new Error(`诊断修复失败：${fixedTitles.join(' / ')}`);
  await page.waitForFunction(() => document.querySelector('#diagnostics')?.hidden === true, {
    timeout: 10000,
  });

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
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.chapter-row .ch-title')?.value === '草稿测试章',
    { timeout: 15000 },
  );
  if (await page.$eval('#reparse', (el) => el.disabled)) throw new Error('恢复草稿后「重新识别」被禁用');
  await page.click('#reparse');
  await page.waitForFunction(
    () => (document.querySelector('#status')?.textContent ?? '').includes('识别完成'),
    { timeout: 30000 },
  );

  // 换一本时必须重新自动检测编码，不能沿用上一本残留的 UTF-8
  const gbkInput = await page.$('#file-input');
  await gbkInput.uploadFile(path.resolve('tests/fixtures/gbk.txt'));
  await page.waitForFunction(
    () => {
      const stats = document.querySelector('#stats')?.textContent ?? '';
      return stats.includes('GB18030') && stats.includes('3 章');
    },
    { timeout: 30000 },
  );
  const gbkPreview = await page.$eval('#preview', (el) => el.textContent ?? '');
  if (gbkPreview.includes('\uFFFD')) throw new Error('GBK 文件仍被旧编码解码，出现替换符');
  if (!gbkPreview.includes('雾从海面漫上来')) throw new Error('GBK 正文解码错误');

  await page.click('#clear-draft');
  await page.waitForFunction(
    () => (document.querySelector('#draft-status')?.textContent ?? '').includes('草稿已清除'),
    { timeout: 10000 },
  );
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#drop-zone:not([hidden])', { timeout: 15000 });
  if (!(await page.$eval('#workspace', (el) => el.hidden))) throw new Error('清除草稿后仍然恢复了草稿');

  // 批量转换：两本 → 一个 ZIP
  const batchInput = await page.$('#file-input');
  await batchInput.uploadFile(path.resolve('public/sample.txt'), path.resolve('tests/fixtures/messy.txt'));
  await page.waitForSelector('#batch:not([hidden])', { timeout: 15000 });
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

  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
  await mobile.screenshot({ path: path.join(OUT, 'shot-mobile.png') });
  await mobile.close();

  console.log(`SMOKE OK · ${path.basename(file)} · ${bytes.length} bytes · ${stats}`);
} finally {
  await browser.close();
}
