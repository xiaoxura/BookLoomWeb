import puppeteer from 'puppeteer-core';

const html = `<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;width:1200px;height:630px;background:radial-gradient(900px 500px at 30% 0%, #fbf7ee, #f4efe4 70%);font-family:'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;inset:0;display:flex;align-items:center;gap:56px;padding:76px 84px;box-sizing:border-box">
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:40px">
        <div style="width:54px;height:54px;border-radius:14px;background:#2f2a22;color:#f6efe0;display:flex;align-items:center;justify-content:center;font-family:'Songti SC','Noto Serif CJK SC',serif;font-size:30px">书</div>
        <div style="font-size:27px;font-weight:700;color:#2c2720;letter-spacing:.02em">txt2book</div>
      </div>
      <div style="font-family:'Songti SC','Noto Serif CJK SC',serif;font-size:70px;line-height:1.16;color:#2c2720;font-weight:700">把 TXT 变成<br/>好读的 EPUB</div>
      <div style="margin-top:30px;font-size:23px;color:#8a7f6c">自动识别编码与章节 · 人工校对 · EPUB 3 / 2</div>
      <div style="margin-top:12px;font-size:21px;color:#2f2a22">纯本地运行，文件不出浏览器</div>
    </div>
    <div style="width:320px;height:430px;border-radius:10px;background:linear-gradient(160deg,#faf4e6,#e2d2b4);box-shadow:0 24px 60px rgba(60,45,20,.28);position:relative;transform:rotate(4deg);flex:none">
      <div style="position:absolute;inset:16px;border:1px solid rgba(104,82,52,.28)"></div>
      <div style="position:absolute;right:46px;top:54px;writing-mode:vertical-rl;font-family:'Songti SC','Noto Serif CJK SC',serif;font-size:42px;color:#2f2a22;letter-spacing:10px">雾港灯塔</div>
      <div style="position:absolute;left:44px;bottom:54px;writing-mode:vertical-rl;font-family:'Kaiti SC','KaiTi',serif;font-size:22px;color:#6b5d45;letter-spacing:6px">林间</div>
    </div>
  </div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.screenshot({ path: 'public/og.png' });
await browser.close();
console.log('wrote public/og.png');
