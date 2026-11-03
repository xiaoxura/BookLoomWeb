/**
 * EPUB 结构校验（epubcheck 的轻量替代，没有 Java 也能跑）。
 * 用法：node scripts/validate-epub.mjs samples/demo.epub
 */
import fs from 'node:fs';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';

const file = process.argv[2] ?? 'samples/demo.epub';
const bytes = new Uint8Array(fs.readFileSync(file));

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

let entries;
try {
  entries = unzipSync(bytes);
} catch (error) {
  console.error(`不是有效的 ZIP：${error.message}`);
  process.exit(1);
}
const names = Object.keys(entries);
const text = (name) => strFromU8(entries[name]);

/* ---- 1. OCF：mimetype 必须是第一个条目、不压缩 ---- */
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x04034b50) fail('第一个本地文件头不是 ZIP 条目');
if (names[0] !== 'mimetype') fail(`mimetype 不是第一个条目（实际是 ${names[0]}）`);
if (view.getUint16(8, true) !== 0) fail('mimetype 被压缩了，必须是 store');
const flags = view.getUint16(6, true);
if (flags & 0x08) warn('mimetype 使用了 data descriptor，个别严格阅读器可能挑剔');
const nameLength = view.getUint16(26, true);
const extraLength = view.getUint16(28, true);
const firstEntryName = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
if (firstEntryName !== 'mimetype') fail(`第一个条目名是 ${firstEntryName}`);
if (extraLength > 0) warn(`mimetype 本地头带有 ${extraLength} 字节扩展字段`);
if (text('mimetype').trim() !== 'application/epub+zip') fail('mimetype 内容不正确');

/* ---- 2. 所有 XML 文档必须良构 ---- */
const xmlFiles = names.filter((name) => /\.(xml|opf|ncx|xhtml)$/i.test(name));
for (const name of xmlFiles) {
  const result = XMLValidator.validate(text(name), { allowBooleanAttributes: true });
  if (result !== true) {
    fail(`${name} 不是良构 XML：${result.err?.msg}（第 ${result.err?.line} 行）`);
  }
}
const xhtmlFiles = names.filter((name) => name.endsWith('.xhtml'));
for (const name of xhtmlFiles) {
  if (!/<title>[\s\S]*<\/title>/.test(text(name))) fail(`${name} 缺少 <title>`);
}

/* ---- 3. container.xml ---- */
if (!names.includes('META-INF/container.xml')) {
  fail('缺少 META-INF/container.xml');
} else {
  const container = text('META-INF/container.xml');
  const match = container.match(/full-path="([^"]+)"/);
  if (!match) fail('container.xml 没有 rootfile');
  else if (!names.includes(match[1])) fail(`container.xml 指向的 ${match[1]} 不存在`);
}

/* ---- 4. OPF ---- */
const opfName = 'OEBPS/content.opf';
if (!names.includes(opfName)) {
  fail('缺少 OEBPS/content.opf');
} else {
  const opf = text(opfName);
  const opfVersion = /<package\b[^>]*version="([^"]+)"/.exec(opf)?.[1] ?? '3.0';
  const isEpub2 = opfVersion.startsWith('2');
  for (const tag of ['dc:title', 'dc:identifier', 'dc:language']) {
    if (!new RegExp(`<${tag}[\\s>]`).test(opf)) fail(`OPF 缺少 ${tag}`);
  }
  if (!isEpub2 && !opf.includes('dcterms:modified')) fail('OPF 缺少 dcterms:modified');

  const items = [];
  for (const match of opf.matchAll(/<item\b([^>]*)\/>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    items.push(attrs);
  }
  if (!items.length) fail('OPF 没有任何 manifest item');

  const ids = new Set();
  for (const item of items) {
    if (!item.id || !item.href || !item['media-type']) fail(`manifest item 缺属性：${JSON.stringify(item)}`);
    if (ids.has(item.id)) fail(`manifest id 重复：${item.id}`);
    ids.add(item.id);
    const resolved = path.posix.normalize(path.posix.join('OEBPS', item.href));
    if (!names.includes(resolved)) fail(`manifest 指向不存在的文件：${item.href}`);
  }

  if (!isEpub2 && !items.some((item) => (item.properties ?? '').split(/\s+/).includes('nav'))) {
    fail('OPF 没有声明 nav 文档');
  }
  if (!isEpub2 && !items.some((item) => (item.properties ?? '').split(/\s+/).includes('cover-image'))) {
    warn('没有 cover-image（无封面也能读）');
  }
  if (isEpub2 && !items.some((item) => item.id === 'ncx')) {
    fail('EPUB 2 缺少 NCX 目录');
  }

  const spine = [...opf.matchAll(/<itemref\b([^>]*)\/>/g)].map((match) => {
    const idref = match[1].match(/idref="([^"]+)"/);
    return idref?.[1];
  });
  if (!spine.length) fail('OPF spine 为空');
  for (const idref of spine) {
    if (!ids.has(idref)) fail(`spine 引用了不存在的 id：${idref}`);
  }
  for (const id of ids) {
    const item = items.find((candidate) => candidate.id === id);
    if (item?.['media-type'] === 'application/xhtml+xml' && id !== 'nav' && !spine.includes(id)) {
      warn(`XHTML 未进入 spine：${id}`);
    }
  }

  /* ---- 5. 清单覆盖：OEBPS 下的文件都应登记 ---- */
  const declared = new Set(items.map((item) => path.posix.normalize(path.posix.join('OEBPS', item.href))));
  for (const name of names) {
    if (!name.startsWith('OEBPS/')) continue;
    if (name === opfName) continue;
    if (!declared.has(name)) fail(`文件没有登记进 manifest：${name}`);
  }

  /* ---- 6. 内部链接 ---- */
  const checkLink = (href, base, label) => {
    const [target, fragment] = href.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
    if (!names.includes(resolved)) fail(`${label} 链接指向不存在的文件：${href}`);
    if (fragment && names.includes(resolved)) {
      const idPattern = new RegExp(`id="${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
      if (!idPattern.test(text(resolved))) fail(`${label} 锚点不存在：${href}`);
    }
  };

  const navItem = items.find((item) => (item.properties ?? '').includes('nav'));
  if (navItem) {
    const navPath = path.posix.join('OEBPS', navItem.href);
    const navDoc = text(navPath);
    const links = [...navDoc.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    if (links.length < 1) fail('nav 文档里没有链接');
    for (const href of links) checkLink(href, navPath, 'nav');
  }

  if (names.includes('OEBPS/toc.ncx')) {
    const ncx = text('OEBPS/toc.ncx');
    const srcs = [...ncx.matchAll(/<content\s+src="([^"]+)"/g)].map((match) => match[1]);
    if (!srcs.length) fail('NCX 没有 navPoint');
    for (const src of srcs) checkLink(src, 'OEBPS/toc.ncx', 'NCX');
    if (!/name="dtb:uid"/.test(ncx)) fail('NCX 缺少 dtb:uid');
  } else if (!isEpub2) {
    warn('没有 toc.ncx，EPUB2 阅读器可能没有目录');
  } else {
    fail('EPUB 2 必须有 toc.ncx');
  }
}

/* ---- 输出 ---- */
for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of errors) console.error(`ERROR ${message}`);

const stat = fs.statSync(file);
console.log(
  `\n${path.basename(file)} · EPUB ${(/<package\b[^>]*version="([^"]+)"/.exec(text(opfName))?.[1] ?? '?')} · ` +
    `${(stat.size / 1024).toFixed(1)} KB · ${names.length} 个条目 · ` +
    `${xhtmlFiles.length} 个 XHTML · ${errors.length} 个错误 · ${warnings.length} 个警告`,
);

if (errors.length) process.exit(1);
console.log('EPUB 结构校验通过 ✓');
