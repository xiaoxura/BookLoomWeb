import { strToU8, zipSync, type Zippable } from 'fflate';
import type { BookMeta, Chapter, CoverData, LayoutOptions } from '../types';

const MAX_DOC_CHARS = 40000;

export interface EpubInput {
  chapters: Chapter[];
  meta: BookMeta;
  layout: LayoutOptions;
  cover: CoverData | null;
  /** 2 = EPUB 2.0（老设备兼容），3 = EPUB 3（默认） */
  version?: 2 | 3;
}

interface Doc {
  id: string;
  href: string;
  title: string;
  level: 1 | 2;
  body: string;
}

const FONT_STACK: Record<LayoutOptions['font'], string> = {
  serif: `"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`,
  sans: `"PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
  kai: `"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif`,
};

export function escapeXml(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function splitParagraphs(chapters: Chapter[], epub2: boolean): Doc[] {
  const docs: Doc[] = [];
  chapters.forEach((chapter, ci) => {
    const parts: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const p of chapter.paragraphs) {
      if (current.length && size + p.length > MAX_DOC_CHARS) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(p);
      size += p.length;
    }
    if (current.length || parts.length === 0) parts.push(current);

    parts.forEach((paragraphs, pi) => {
      const heading =
        pi === 0
          ? chapter.level === 1
            ? `<h1 class="volume-title">${escapeXml(chapter.title)}</h1>`
            : `<h2 class="chapter-title">${escapeXml(chapter.title)}</h2>`
          : '';
      const sectionType = chapter.level === 1 ? 'part' : 'chapter';
      const inner = `${heading}${paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('')}`;
      const body = epub2 ? `<div class="chapter">${inner}</div>` : `<section epub:type="${sectionType}">${inner}</section>`;
      docs.push({
        id: `doc${ci + 1}_${pi + 1}`,
        href: `text/c${String(ci + 1).padStart(4, '0')}-${pi + 1}.xhtml`,
        title: chapter.title,
        level: chapter.level,
        body,
      });
    });
  });
  return docs;
}

function xhtmlDoc(title: string, lang: string, cssHref: string, body: string, epub2: boolean): string {
  const doctype = epub2
    ? `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">`
    : `<!DOCTYPE html>`;
  const htmlAttrs = epub2
    ? `xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"`
    : `xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"`;
  const charset = epub2
    ? `<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>`
    : `<meta charset="utf-8"/>`;
  return `<?xml version="1.0" encoding="utf-8"?>
${doctype}
<html ${htmlAttrs}>
<head>
${charset}
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="${cssHref}"/>
</head>
<body>
${body}
</body>
</html>`;
}

function stylesheet(layout: LayoutOptions): string {
  return `@charset "utf-8";
html, body { margin: 0; padding: 0; }
body {
  font-family: ${FONT_STACK[layout.font]};
  line-height: ${layout.lineHeight};
  text-align: ${layout.justify ? 'justify' : 'left'};
  word-wrap: break-word;
}
p {
  margin: 0 0 ${layout.paragraphSpacing}em 0;
  text-indent: ${layout.indent ? '2em' : '0'};
}
h1.volume-title {
  font-size: 1.7em;
  font-weight: 700;
  text-align: center;
  margin: 3em 0 2em 0;
  page-break-before: always;
  break-before: page;
}
h2.chapter-title {
  font-size: 1.35em;
  font-weight: 700;
  text-align: center;
  margin: 2em 0 1.2em 0;
  page-break-before: always;
  break-before: page;
}
.cover-page { margin: 0; padding: 0; text-align: center; }
.cover-page img { max-width: 100%; max-height: 100%; }
`;
}

interface NavItem {
  title: string;
  href: string;
  children: NavItem[];
}

function navTree(chapters: Chapter[], docs: Doc[]): NavItem[] {
  const firstHref = new Map<string, string>();
  for (const doc of docs) {
    const key = doc.href.replace(/-(\d+)\.xhtml$/, '');
    if (!firstHref.has(key)) firstHref.set(key, doc.href);
  }

  const roots: NavItem[] = [];
  let volume: NavItem | null = null;
  chapters.forEach((chapter, ci) => {
    const key = `text/c${String(ci + 1).padStart(4, '0')}`;
    const href = firstHref.get(key);
    if (!href) return;
    const item: NavItem = { title: chapter.title, href, children: [] };
    if (chapter.level === 1) {
      roots.push(item);
      volume = item;
    } else if (volume && !chapter.frontMatter) {
      volume.children.push(item);
    } else {
      roots.push(item);
    }
  });
  return roots;
}

function navList(items: NavItem[]): string {
  if (!items.length) return '';
  const lis = items
    .map(
      (item) =>
        `<li><a href="${item.href}">${escapeXml(item.title)}</a>${
          item.children.length ? navList(item.children) : ''
        }</li>`,
    )
    .join('');
  return `<ol>${lis}</ol>`;
}

function ncxNavPoints(items: NavItem[], state: { order: number }): string {
  return items
    .map((item) => {
      const order = ++state.order;
      return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${escapeXml(
        item.title,
      )}</text></navLabel><content src="${item.href}"/>${ncxNavPoints(item.children, state)}</navPoint>`;
    })
    .join('');
}

export function buildEpub(input: EpubInput): Uint8Array {
  const { chapters, layout, cover } = input;
  const epub2 = input.version === 2;
  const title = input.meta.title.trim() || '未命名';
  const author = input.meta.author.trim() || '佚名';
  const lang = input.meta.language || 'zh-CN';
  const identifier = `urn:uuid:${uuid()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const docs = splitParagraphs(chapters, epub2);
  const nav = navTree(chapters, docs);

  const manifest: string[] = [
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="styles/style.css" media-type="text/css"/>`,
  ];
  if (!epub2) {
    manifest.unshift(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  }
  const coverExt = cover && cover.mime === 'image/png' ? 'png' : 'jpg';
  if (cover) {
    manifest.push(
      `<item id="cover-image" href="images/cover.${coverExt}" media-type="${cover.mime}"${
        epub2 ? '' : ' properties="cover-image"'
      }/>`,
      `<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`,
    );
  }
  for (const doc of docs) {
    manifest.push(`<item id="${doc.id}" href="${doc.href}" media-type="application/xhtml+xml"/>`);
  }

  const spine: string[] = [];
  if (cover) spine.push(`<itemref idref="cover"/>`);
  for (const doc of docs) spine.push(`<itemref idref="${doc.id}"/>`);

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${epub2 ? '2.0' : '3.0'}" unique-identifier="bookid"${
    epub2 ? '' : ` xml:lang="${lang}"`
  }>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${identifier}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<dc:language>${lang}</dc:language>
<dc:date>${modified}</dc:date>
${epub2 ? '' : `<meta property="dcterms:modified">${modified}</meta>`}
${cover ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
<guide>
${cover ? '<reference type="cover" title="封面" href="text/cover.xhtml"/>' : ''}
<reference type="text" title="正文" href="${docs[0]?.href ?? 'nav.xhtml'}"/>
</guide>
</package>`;

  const navDoc = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>目录</title>
<link rel="stylesheet" type="text/css" href="styles/style.css"/>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
${navList(nav)}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<ol>
${cover ? '<li><a epub:type="cover" href="text/cover.xhtml">封面</a></li>' : ''}
<li><a epub:type="bodymatter" href="${docs[0]?.href ?? 'nav.xhtml'}">正文</a></li>
</ol>
</nav>
</body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
<head>
<meta name="dtb:uid" content="${identifier}"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<docAuthor><text>${escapeXml(author)}</text></docAuthor>
<navMap>
${ncxNavPoints(nav, { order: 0 })}
</navMap>
</ncx>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

  const files: Record<string, [Uint8Array, { level: number }]> = {};
  const put = (path: string, data: string | Uint8Array, level = 6) => {
    files[path] = [typeof data === 'string' ? strToU8(data) : data, { level }];
  };

  // mimetype 必须是第一个条目且不压缩
  put('mimetype', 'application/epub+zip', 0);
  put('META-INF/container.xml', container, 0);
  put('OEBPS/content.opf', opf);
  if (!epub2) put('OEBPS/nav.xhtml', navDoc);
  put('OEBPS/toc.ncx', ncx);
  put('OEBPS/styles/style.css', stylesheet(layout));

  if (cover) {
    put(`OEBPS/images/cover.${coverExt}`, cover.data, 0);
    put(
      'OEBPS/text/cover.xhtml',
      xhtmlDoc(
        '封面',
        lang,
        '../styles/style.css',
        `<div class="cover-page"><img src="../images/cover.${coverExt}" alt="封面"/></div>`,
        epub2,
      ),
    );
  }

  for (const doc of docs) {
    put(`OEBPS/${doc.href}`, xhtmlDoc(doc.title, lang, '../styles/style.css', doc.body, epub2));
  }

  return zipSync(files as unknown as Zippable, { level: 6 });
}
