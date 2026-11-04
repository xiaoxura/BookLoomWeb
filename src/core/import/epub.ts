import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import type { Chapter, CoverData } from '../../types';
import { buildParagraphs } from '../text';

export interface EpubBook {
  title: string;
  author: string;
  language: string;
  description: string;
  publisher: string;
  tags: string[];
  publishedAt: string;
  series: string;
  chapters: Chapter[];
  cover: CoverData | null;
  warnings: string[];
}

/** preserveOrder 模式下，属性统一放在 `:@` 里 */
type XmlAttrs = Record<string, string>;
type XmlNode = { [key: string]: XmlNode[] | XmlAttrs | string | undefined };

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
  /** href 相对 OPF 解析后的 zip 内路径 */
  path: string;
}

interface TocEntry {
  href: string;
  title: string;
  depth: number;
}

interface OpfData {
  title: string;
  author: string;
  language: string;
  description: string;
  publisher: string;
  tags: string[];
  publishedAt: string;
  series: string;
  coverId: string;
  items: ManifestItem[];
  byId: Map<string, ManifestItem>;
  spineRefs: string[];
  spineTocId: string;
}

interface Archive {
  exact: Map<string, Uint8Array>;
  lower: Map<string, Uint8Array>;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  // text/html 条目里常见未闭合的 <br>，按空元素处理，避免把后文吞进 br
  // 只列正文里常见的空元素；meta / link 在 OPF 里可能是成对写法，不能当空元素
  unpairedTags: ['br', 'hr', 'img'],
});

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'section',
  'article',
  'td',
  'th',
  'pre',
  'figure',
  'figcaption',
  'dt',
  'dd',
]);

/** 这些标签不参与正文提取；图片只丢掉，不转成文字 */
const SKIP_TAGS = new Set(['head', 'script', 'style', 'svg', 'rt', 'rp', 'img', 'nav']);

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const VOLUME_TITLE_RE = /^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[卷部篇集]/;
const CHAPTER_TITLE_RE = /^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回话]/;
const FONT_EXT_RE = /\.(?:ttf|otf|woff|woff2)$/i;

// ---------------------------------------------------------------------------
// XML 小工具：fast-xml-parser 的 preserveOrder 节点形如
// { 标签名: [子节点], ':@': { '@_属性名': '值' } }，文本节点形如 { '#text': '...' }
// ---------------------------------------------------------------------------

function parseXml(text: string): XmlNode[] {
  const parsed: unknown = parser.parse(text);
  return Array.isArray(parsed) ? (parsed as XmlNode[]) : [];
}

/** 关键文件解析失败时给出能直接展示给用户的错误 */
function parseXmlFriendly(text: string, message: string): XmlNode[] {
  try {
    return parseXml(text);
  } catch {
    throw new Error(message);
  }
}

function nodeTag(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return '';
}

function localName(tag: string): string {
  const index = tag.lastIndexOf(':');
  return index >= 0 ? tag.slice(index + 1) : tag;
}

function nodeChildren(node: XmlNode): XmlNode[] {
  const tag = nodeTag(node);
  if (!tag || tag === '#text') return [];
  const value = node[tag];
  return Array.isArray(value) ? value : [];
}

function attrsOf(node: XmlNode): XmlAttrs {
  const raw = node[':@'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const attrs: XmlAttrs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') attrs[key] = value;
  }
  return attrs;
}

/** 属性名宽容匹配：同时兼容 `@_href`、`href` 以及 `epub:type` 这类带命名空间的属性 */
function getAttr(node: XmlNode, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(attrsOf(node))) {
    const bare = key.replace(/^@_/, '');
    if (bare === name || bare.toLowerCase() === wanted || localName(bare).toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function nodeText(node: XmlNode): string {
  const tag = nodeTag(node);
  if (!tag) return '';
  if (tag === '#text') {
    const value = node[tag];
    return typeof value === 'string' ? value : '';
  }
  let out = '';
  for (const child of nodeChildren(node)) out += nodeText(child);
  return out;
}

function findElements(nodes: XmlNode[], local: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (!tag || tag === '#text') continue;
    if (localName(tag) === local) out.push(node);
    out.push(...findElements(nodeChildren(node), local));
  }
  return out;
}

function findFirstElement(nodes: XmlNode[], local: string): XmlNode | null {
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (!tag || tag === '#text') continue;
    if (localName(tag) === local) return node;
    const nested = findFirstElement(nodeChildren(node), local);
    if (nested) return nested;
  }
  return null;
}

function findDirectChild(node: XmlNode, local: string): XmlNode | null {
  for (const child of nodeChildren(node)) {
    const tag = nodeTag(child);
    if (tag && tag !== '#text' && localName(tag) === local) return child;
  }
  return null;
}

function cleanText(input: string): string {
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOfElement(nodes: XmlNode[], local: string): string {
  const node = findFirstElement(nodes, local);
  return node ? cleanText(nodeText(node)) : '';
}

// ---------------------------------------------------------------------------
// zip 路径与解码
// ---------------------------------------------------------------------------

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** 统一 zip 内路径：去掉前导 ./，处理 ..，统一斜杠 */
function normalizeZipPath(input: string): string {
  const parts: string[] = [];
  for (const part of input.replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** href 相对 baseFile（OPF / nav / ncx）解析，去掉 fragment 并 decode */
function resolveHref(baseFile: string, href: string): string {
  const raw = href.trim();
  if (!raw) return normalizeZipPath(baseFile);
  const withoutFragment = raw.split('#')[0].split('?')[0];
  const decoded = safeDecode(withoutFragment);
  if (!decoded) return normalizeZipPath(baseFile);

  const baseDir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/')) : '';
  const combined = decoded.startsWith('/')
    ? decoded.replace(/^\/+/, '')
    : baseDir
      ? `${baseDir}/${decoded}`
      : decoded;
  return normalizeZipPath(combined);
}

function buildArchive(files: Record<string, Uint8Array>): Archive {
  const exact = new Map<string, Uint8Array>();
  const lower = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    const normalized = normalizeZipPath(name);
    if (!normalized) continue;
    exact.set(normalized, data);
    lower.set(normalized.toLowerCase(), data);
    const decoded = safeDecode(normalized);
    if (decoded !== normalized) {
      exact.set(decoded, data);
      lower.set(decoded.toLowerCase(), data);
    }
  }
  return { exact, lower };
}

function getFile(archive: Archive, path: string): Uint8Array | null {
  const normalized = normalizeZipPath(path);
  if (!normalized) return null;
  return archive.exact.get(normalized) ?? archive.lower.get(normalized.toLowerCase()) ?? null;
}

/** XML 基本是 UTF-8，这里顺手兼容带 BOM 的 UTF-16 */
function decodeXml(data: Uint8Array): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(data.subarray(2));
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(data.subarray(2));
  }
  return new TextDecoder('utf-8').decode(data);
}

// ---------------------------------------------------------------------------
// OPF
// ---------------------------------------------------------------------------

function readMetadata(opf: XmlNode[]): {
  title: string;
  author: string;
  language: string;
  description: string;
  publisher: string;
  tags: string[];
  publishedAt: string;
  series: string;
  coverId: string;
} {
  const metadata = findFirstElement(opf, 'metadata');
  if (!metadata) {
    return {
      title: '',
      author: '',
      language: '',
      description: '',
      publisher: '',
      tags: [],
      publishedAt: '',
      series: '',
      coverId: '',
    };
  }

  const children = nodeChildren(metadata);
  const title = textOfElement(children, 'title');
  const language = textOfElement(children, 'language');
  const description = textOfElement(children, 'description');
  const publisher = textOfElement(children, 'publisher');
  const authors = findElements(children, 'creator')
    .map((node) => cleanText(nodeText(node)))
    .filter(Boolean);
  const tags = [...new Set(findElements(children, 'subject').map((node) => cleanText(nodeText(node))).filter(Boolean))];

  let publishedAt = '';
  const rawDate = textOfElement(children, 'date').trim();
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate);
  if (dateMatch) publishedAt = dateMatch[1];

  let coverId = '';
  let series = '';
  for (const meta of findElements(children, 'meta')) {
    const name = (getAttr(meta, 'name') ?? '').trim().toLowerCase();
    const property = (getAttr(meta, 'property') ?? '').trim().toLowerCase();
    if (name === 'cover') {
      coverId = (getAttr(meta, 'content') ?? '').trim();
    } else if (name === 'calibre:series') {
      series = (getAttr(meta, 'content') ?? '').trim() || cleanText(nodeText(meta));
    } else if (!series && property === 'belongs-to-collection') {
      series = cleanText(nodeText(meta));
    }
  }

  return { title, author: authors.join(' / '), language, description, publisher, tags, publishedAt, series, coverId };
}

function readOpf(opf: XmlNode[], opfPath: string): OpfData {
  const meta = readMetadata(opf);
  const items: ManifestItem[] = [];
  const byId = new Map<string, ManifestItem>();

  const manifest = findFirstElement(opf, 'manifest');
  if (manifest) {
    for (const node of findElements(nodeChildren(manifest), 'item')) {
      const id = (getAttr(node, 'id') ?? '').trim();
      const href = (getAttr(node, 'href') ?? '').trim();
      if (!id || !href) continue;
      const item: ManifestItem = {
        id,
        href,
        mediaType: (getAttr(node, 'media-type') ?? '').trim(),
        properties: (getAttr(node, 'properties') ?? '').split(/\s+/).filter(Boolean),
        path: resolveHref(opfPath, href),
      };
      items.push(item);
      if (!byId.has(id)) byId.set(id, item);
    }
  }

  const spine = findFirstElement(opf, 'spine');
  const spineRefs: string[] = [];
  if (spine) {
    for (const node of findElements(nodeChildren(spine), 'itemref')) {
      const idref = (getAttr(node, 'idref') ?? '').trim();
      if (idref) spineRefs.push(idref);
    }
  }

  return {
    ...meta,
    items,
    byId,
    spineRefs,
    spineTocId: spine ? (getAttr(spine, 'toc') ?? '').trim() : '',
  };
}

// ---------------------------------------------------------------------------
// 目录：EPUB3 nav 或 EPUB2 NCX
// ---------------------------------------------------------------------------

function collectNavList(ol: XmlNode, depth: number, baseFile: string, out: TocEntry[]): void {
  for (const li of nodeChildren(ol)) {
    const tag = nodeTag(li);
    if (!tag || tag === '#text' || localName(tag) !== 'li') continue;

    const children = nodeChildren(li);
    const anchor = children.find((child) => {
      const childTag = nodeTag(child);
      return Boolean(childTag && childTag !== '#text' && localName(childTag) === 'a');
    });

    if (anchor) {
      const href = (getAttr(anchor, 'href') ?? '').trim();
      const title = cleanText(nodeText(anchor));
      if (href && title) out.push({ href: resolveHref(baseFile, href), title, depth });
    }

    for (const child of children) {
      const childTag = nodeTag(child);
      if (childTag && childTag !== '#text' && localName(childTag) === 'ol') {
        collectNavList(child, depth + 1, baseFile, out);
      }
    }
  }
}

function readEpub3Nav(archive: Archive, nav: ManifestItem): TocEntry[] {
  const data = getFile(archive, nav.path);
  if (!data) return [];
  let doc: XmlNode[];
  try {
    doc = parseXml(decodeXml(data));
  } catch {
    return [];
  }
  const navs = findElements(doc, 'nav');
  const target =
    navs.find((node) => {
      const type = (getAttr(node, 'type') ?? '').trim().toLowerCase();
      return type === 'toc' || type.split(/\s+/).includes('toc');
    }) ??
    navs[0] ??
    null;
  if (!target) return [];

  const list = findFirstElement(nodeChildren(target), 'ol');
  if (!list) return [];

  const out: TocEntry[] = [];
  collectNavList(list, 0, nav.path, out);
  return out;
}

function collectNavPoints(
  parent: XmlNode,
  depth: number,
  baseFile: string,
  out: TocEntry[],
): void {
  for (const child of nodeChildren(parent)) {
    const tag = nodeTag(child);
    if (!tag || tag === '#text' || localName(tag) !== 'navPoint') continue;

    const label = findDirectChild(child, 'navLabel');
    const textNode = label ? findDirectChild(label, 'text') : null;
    const title = cleanText(textNode ? nodeText(textNode) : label ? nodeText(label) : '');
    const content = findDirectChild(child, 'content');
    const src = content ? (getAttr(content, 'src') ?? '').trim() : '';

    if (src && title) out.push({ href: resolveHref(baseFile, src), title, depth });
    collectNavPoints(child, depth + 1, baseFile, out);
  }
}

function readNcx(archive: Archive, ncx: ManifestItem): TocEntry[] {
  const data = getFile(archive, ncx.path);
  if (!data) return [];
  let doc: XmlNode[];
  try {
    doc = parseXml(decodeXml(data));
  } catch {
    return [];
  }
  const navMap = findFirstElement(doc, 'navMap');
  if (!navMap) return [];
  const out: TocEntry[] = [];
  collectNavPoints(navMap, 0, ncx.path, out);
  return out;
}

// ---------------------------------------------------------------------------
// 正文提取
// ---------------------------------------------------------------------------

interface ExtractState {
  paragraphs: string[];
  /** 当前块内由 <br> 切开的行 */
  lines: string[];
  /** 当前块内正在拼接的一行 */
  current: string;
}

const CJK_CLASS = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
/** XHTML 源码里夹在两个汉字之间的硬换行，是排版噪音 */
const CJK_WRAP_RE = new RegExp(`([${CJK_CLASS}])[ \\t]*\\r?\\n[ \\t]*(?=[${CJK_CLASS}])`, 'g');

function cleanLine(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(CJK_WRAP_RE, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function breakLine(state: ExtractState): void {
  const line = cleanLine(state.current);
  state.current = '';
  if (line) state.lines.push(line);
}

function flushBlock(state: ExtractState): void {
  breakLine(state);
  const lines = state.lines;
  state.lines = [];
  if (!lines.length) return;
  if (lines.length === 1) {
    state.paragraphs.push(lines[0]);
    return;
  }
  // 只有 <br> 造成的多行才并段，正常 <p> 不会走到这里
  state.paragraphs.push(...buildParagraphs(lines, { filterAds: false }));
}

function extractNodes(nodes: XmlNode[], state: ExtractState): void {
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (!tag) continue;

    if (tag === '#text') {
      const value = node[tag];
      if (typeof value === 'string') state.current += value;
      continue;
    }

    const local = localName(tag);
    if (SKIP_TAGS.has(local)) continue;
    if (local === 'br') {
      breakLine(state);
      continue;
    }

    if (BLOCK_TAGS.has(local)) {
      flushBlock(state);
      extractNodes(nodeChildren(node), state);
      flushBlock(state);
      continue;
    }

    extractNodes(nodeChildren(node), state);
  }
}

function extractParagraphs(doc: XmlNode[]): string[] {
  const body = findFirstElement(doc, 'body');
  const state: ExtractState = { paragraphs: [], lines: [], current: '' };
  extractNodes(body ? nodeChildren(body) : doc, state);
  flushBlock(state);
  return state.paragraphs;
}

function firstHeadingText(nodes: XmlNode[]): string {
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (!tag || tag === '#text') continue;
    const local = localName(tag);
    if (local === 'head') continue;
    if (local === 'h1' || local === 'h2' || local === 'h3') {
      const text = cleanText(nodeText(node));
      if (text) return text;
    }
    const nested = firstHeadingText(nodeChildren(node));
    if (nested) return nested;
  }
  return '';
}

function documentTitle(doc: XmlNode[]): string {
  const head = findFirstElement(doc, 'head');
  const title = findFirstElement(head ? nodeChildren(head) : doc, 'title');
  return title ? cleanText(nodeText(title)) : '';
}

/** 内嵌目录页（h1/head 标题是目录且有一堆链接）不应该被当成正文章节 */
function looksLikeTocPage(doc: XmlNode[]): boolean {
  const title = (documentTitle(doc).trim() || firstHeadingText(doc).trim());
  if (!/^(?:目录|目錄|contents|table of contents)$/i.test(title)) return false;
  return findElements(doc, 'a').length >= 3;
}

function guessTitleFromParagraph(paragraph: string): string {
  const text = paragraph.trim();
  if (!text || text.length > 40 || /[。！？]$/.test(text)) return '';
  return text;
}

// ---------------------------------------------------------------------------
// 封面与 DRM
// ---------------------------------------------------------------------------

function guessImageMime(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? '';
}

function isImageItem(item: ManifestItem): boolean {
  return item.mediaType.toLowerCase().startsWith('image/') || guessImageMime(item.path) !== '';
}

function readCover(archive: Archive, opf: OpfData): CoverData | null {
  const propertyCover = opf.items.find((item) => item.properties.includes('cover-image'));
  const metaCover = opf.coverId ? opf.byId.get(opf.coverId) : undefined;
  const namedCover = opf.items.find(
    (item) => isImageItem(item) && (/cover/i.test(item.href) || /cover/i.test(item.id)),
  );

  let item: ManifestItem | undefined;
  if (propertyCover) item = propertyCover;
  else if (metaCover && isImageItem(metaCover)) item = metaCover;
  else if (namedCover) item = namedCover;
  if (!item) return null;

  const data = getFile(archive, item.path);
  if (!data) return null;

  const mime = item.mediaType || guessImageMime(item.path) || 'image/jpeg';
  return { data, mime };
}

function checkDrm(archive: Archive): void {
  const data = getFile(archive, 'META-INF/encryption.xml');
  if (!data) return;

  let doc: XmlNode[];
  try {
    doc = parseXml(decodeXml(data));
  } catch {
    throw new Error('这个 EPUB 有 DRM 加密，无法读取');
  }

  const refs = [...findElements(doc, 'CipherReference'), ...findElements(doc, 'EncryptedReference')];
  for (const ref of refs) {
    const uri = (getAttr(ref, 'URI') ?? getAttr(ref, 'uri') ?? '').trim();
    if (!uri) continue;
    const path = normalizeZipPath(safeDecode(uri.split('#')[0].split('?')[0]));
    if (!path) continue;
    if (!FONT_EXT_RE.test(path)) throw new Error('这个 EPUB 有 DRM 加密，无法读取');
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function importEpub(bytes: Uint8Array): EpubBook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('这个 EPUB 文件已损坏，无法解压');
  }

  const archive = buildArchive(files);

  const containerData = getFile(archive, 'META-INF/container.xml');
  if (!containerData) throw new Error('这不像是标准的 EPUB：缺少 container.xml');

  const containerDoc = parseXmlFriendly(decodeXml(containerData), '这个 EPUB 的 container.xml 无法解析');
  const rootfile = findFirstElement(containerDoc, 'rootfile');
  const opfHref = rootfile ? (getAttr(rootfile, 'full-path') ?? '').trim() : '';
  if (!opfHref) throw new Error('这不像是标准的 EPUB：找不到 OPF 文件');

  const opfPath = normalizeZipPath(safeDecode(opfHref));
  const opfData = getFile(archive, opfPath);
  if (!opfData) throw new Error('这不像是标准的 EPUB：找不到 OPF 文件');

  checkDrm(archive);

  const opf = parseXmlFriendly(decodeXml(opfData), '这个 EPUB 的 OPF 文件无法解析');
  const meta = readOpf(opf, opfPath);

  const navItem = meta.items.find((item) => item.properties.includes('nav')) ?? null;
  const ncxItem =
    (meta.spineTocId ? meta.byId.get(meta.spineTocId) : undefined) ??
    meta.items.find(
      (item) => item.mediaType.trim().toLowerCase() === 'application/x-dtbncx+xml',
    ) ??
    null;

  let tocEntries = navItem ? readEpub3Nav(archive, navItem) : [];
  if (!tocEntries.length && ncxItem) tocEntries = readNcx(archive, ncxItem);

  const tocMap = new Map<string, TocEntry>();
  for (const entry of tocEntries) {
    if (!tocMap.has(entry.href)) tocMap.set(entry.href, entry);
  }
  const hasNested = tocEntries.some((entry) => entry.depth > 0);
  // 紧跟着子条目的那一项是父节点（卷），单独一项的顶层条目仍然算章
  const parents = new Set<TocEntry>();
  for (let i = 0; i + 1 < tocEntries.length; i++) {
    if (tocEntries[i + 1].depth > tocEntries[i].depth) parents.add(tocEntries[i]);
  }

  const cover = readCover(archive, meta);
  const navPath = navItem ? navItem.path : '';

  const chapters: Chapter[] = [];
  let emptyDocs = 0;

  for (const idref of meta.spineRefs) {
    const item = meta.byId.get(idref);
    if (!item) continue;

    const mediaType = item.mediaType.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/xhtml+xml' && mediaType !== 'text/html') continue;
    if (navPath && item.path === navPath) continue;

    const data = getFile(archive, item.path);
    if (!data) continue;

    let doc: XmlNode[];
    try {
      doc = parseXml(decodeXml(data));
    } catch {
      emptyDocs++;
      continue;
    }

    if (looksLikeTocPage(doc)) continue;

    const paragraphs = extractParagraphs(doc);
    if (!paragraphs.length) {
      emptyDocs++;
      continue;
    }

    const tocEntry = tocMap.get(item.path);
    const heading = firstHeadingText(doc);
    const headTitle = documentTitle(doc);
    let title = tocEntry?.title || heading || headTitle;
    if (!title) title = guessTitleFromParagraph(paragraphs[0]);
    if (!title) title = `第${chapters.length + 1}章`;

    // 有些 EPUB 把标题也写进了正文（<h2>），导入时去掉这份重复
    if (paragraphs.length && paragraphs[0].replace(/\s+/g, '') === title.replace(/\s+/g, '')) {
      paragraphs.shift();
    }

    let level: 1 | 2 = 2;
    if (tocEntry) {
      if (VOLUME_TITLE_RE.test(tocEntry.title)) {
        level = 1;
      } else if (
        hasNested &&
        tocEntry.depth === 0 &&
        parents.has(tocEntry) &&
        !CHAPTER_TITLE_RE.test(tocEntry.title)
      ) {
        level = 1;
      }
    }

    chapters.push({
      id: `ch-${chapters.length + 1}`,
      title,
      level,
      paragraphs,
    });
  }

  if (!chapters.length) throw new Error('没能从这个 EPUB 里读出正文');

  const warnings: string[] = [];
  if (emptyDocs > 0) warnings.push(`有 ${emptyDocs} 个空文档已跳过`);

  return {
    // 没有 dc:title 时留空，交给上层用文件名兜底
    title: meta.title,
    author: meta.author,
    language: meta.language || 'zh-CN',
    description: meta.description,
    publisher: meta.publisher,
    tags: meta.tags,
    publishedAt: meta.publishedAt,
    series: meta.series,
    chapters,
    cover,
    warnings,
  };
}
