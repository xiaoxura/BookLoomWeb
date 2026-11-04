import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importEpub } from '../src/core/import/epub';
import { toParseResult } from '../src/core/import';

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>
${body}
</body>
</html>`;
}

/** 顺手验证 zip 条目带前导 ./ 时的归一化 */
function zipEpub(files: Record<string, string | Uint8Array>, prefix = ''): Uint8Array {
  const zippable: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  };
  for (const [name, content] of Object.entries(files)) {
    zippable[`${prefix}${name}`] =
      typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(zippable);
}

/** 一本文档 + 可选 nav / 封面的最小 EPUB3 */
function sampleEpub(options: {
  body: string;
  headTitle?: string;
  tocTitle?: string;
  cover?: { name: string; data: Uint8Array; mime: string; properties: string };
  encryption?: string;
}): Uint8Array {
  const navItem = options.tocTitle
    ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    : '';
  const coverItem = options.cover
    ? `<item id="cover-img" href="${options.cover.name}" media-type="${options.cover.mime}" properties="${options.cover.properties}"/>`
    : '';

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>测试书</dc:title>
<dc:creator>测试作者</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
${navItem}
${coverItem}
</manifest>
<spine>
<itemref idref="ch1"/>
</spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="text/ch1.xhtml">${options.tocTitle ?? ''}</a></li>
</ol></nav></body>
</html>`;

  const files: Record<string, string | Uint8Array> = {
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/text/ch1.xhtml': xhtml(options.headTitle ?? '文档标题', options.body),
  };
  if (options.tocTitle) files['OEBPS/nav.xhtml'] = nav;
  if (options.cover) files[`OEBPS/${options.cover.name}`] = options.cover.data;
  if (options.encryption) files['META-INF/encryption.xml'] = options.encryption;
  return zipEpub(files);
}

function richMetadataEpub(): Uint8Array {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>带元数据的书</dc:title>
<dc:creator>作者甲</dc:creator>
<dc:language>zh-TW</dc:language>
<dc:description>一段简介。</dc:description>
<dc:publisher>潮声出版社</dc:publisher>
<dc:subject>悬疑</dc:subject>
<dc:subject>海洋</dc:subject>
<dc:date>2026-01-02T00:00:00Z</dc:date>
<meta property="belongs-to-collection" id="series">雾港三部曲</meta>
<meta refines="#series" property="collection-type">series</meta>
</metadata>
<manifest>
<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="ch1"/></spine>
</package>`;
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/text/ch1.xhtml': xhtml('第一章', '<p>正文。</p>'),
  });
}

function encryptionXml(uri: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData>
<enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
<enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData>
</enc:EncryptedData>
</encryption>`;
}

describe('importEpub · EPUB3', () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>潮声</dc:title>
<dc:creator>林间</dc:creator>
<dc:creator>海客</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine>
<itemref idref="ch1"/>
<itemref idref="ch2"/>
</spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><ol>
<li><a href="text/ch1.xhtml">第一部 风起</a>
<ol><li><a href="text/ch2.xhtml">第一章 初潮</a></li></ol>
</li>
</ol></nav></body>
</html>`;

  const epub = zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/text/ch1.xhtml': xhtml('正文里的假标题', '<h1>正文里的假标题</h1><p>潮声从很远的地方传来。</p>'),
    'OEBPS/text/ch2.xhtml': xhtml('初潮', '<p>海面起了雾，灯塔亮了一夜。</p>'),
  });

  it('读取元数据、章节、TOC 标题与层级', () => {
    const book = importEpub(epub);

    expect(book.title).toBe('潮声');
    expect(book.author).toBe('林间 / 海客');
    expect(book.language).toBe('zh-CN');
    expect(book.chapters).toHaveLength(2);

    expect(book.chapters[0].id).toBe('ch-1');
    expect(book.chapters[0].title).toBe('第一部 风起');
    expect(book.chapters[0].level).toBe(1);
    expect(book.chapters[0].paragraphs).toContain('潮声从很远的地方传来。');

    expect(book.chapters[1].id).toBe('ch-2');
    expect(book.chapters[1].title).toBe('第一章 初潮');
    expect(book.chapters[1].level).toBe(2);
  });
});

describe('importEpub · NCX 与兜底标题', () => {
  it('只有 NCX 时按嵌套 navPoint 定标题和层级', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>旧灯塔</dc:title>
<dc:creator>海客</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx">
<itemref idref="c1"/>
<itemref idref="c2"/>
</spine>
</package>`;

    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="x"/></head>
<docTitle><text>旧灯塔</text></docTitle>
<navMap>
<navPoint id="n1" playOrder="1">
<navLabel><text>第一卷 雾</text></navLabel>
<content src="text/c1.xhtml"/>
<navPoint id="n2" playOrder="2">
<navLabel><text>第一章 灯塔</text></navLabel>
<content src="text/c2.xhtml"/>
</navPoint>
</navPoint>
</navMap>
</ncx>`;

    // 所有条目都带前导 ./，顺便验证 zip 路径归一化
    const epub = zipEpub(
      {
        'META-INF/container.xml': CONTAINER,
        'OEBPS/content.opf': opf,
        'OEBPS/toc.ncx': ncx,
        'OEBPS/text/c1.xhtml': xhtml('c1', '<p>雾从海面漫上来。</p>'),
        'OEBPS/text/c2.xhtml': xhtml('c2', '<p>灯塔在雾里亮着。</p>'),
      },
      './',
    );

    const book = importEpub(epub);
    expect(book.title).toBe('旧灯塔');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe('第一卷 雾');
    expect(book.chapters[0].level).toBe(1);
    expect(book.chapters[1].title).toBe('第一章 灯塔');
    expect(book.chapters[1].level).toBe(2);
  });

  it('没有 TOC 时用第一个 h1 兜底标题', () => {
    const epub = sampleEpub({
      headTitle: 'head 里的标题',
      body: '<h1>序章 无名</h1><p>这是没有目录的正文。</p>',
    });

    const book = importEpub(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('序章 无名');
    expect(book.chapters[0].level).toBe(2);
  });
});

describe('importEpub · 正文提取', () => {
  it('<br> 多行按句末标点并段，正常 <p> 不互相粘连', () => {
    const epub = sampleEpub({
      tocTitle: '第一章 潮声',
      body: [
        '<p>夜色像一块湿透的布<br/>慢慢盖住了整座城。</p>',
        '<p>他站在桥头，听见远处传来汽笛声。</p>',
        '<p>风从海面吹来。</p>',
      ].join(''),
    });

    const book = importEpub(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].paragraphs).toEqual([
      '夜色像一块湿透的布慢慢盖住了整座城。',
      '他站在桥头，听见远处传来汽笛声。',
      '风从海面吹来。',
    ]);
  });

  it('空文档被跳过，不产生空章节', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>空页测试</dc:title>
<dc:creator>作者</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
<item id="e1" href="text/e1.xhtml" media-type="application/xhtml+xml"/>
<item id="e2" href="text/e2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine>
<itemref idref="e1"/>
<itemref idref="c1"/>
<itemref idref="e2"/>
</spine>
</package>`;

    const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="text/c1.xhtml">第一章 唯一</a></li>
</ol></nav></body>
</html>`;

    const epub = zipEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf,
      'OEBPS/nav.xhtml': nav,
      'OEBPS/text/c1.xhtml': xhtml('唯一', '<p>唯一的一段正文。</p>'),
      'OEBPS/text/e1.xhtml': xhtml('空一', ''),
      'OEBPS/text/e2.xhtml': xhtml('空二', '<div>   </div><p>  </p>'),
    });

    const book = importEpub(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].id).toBe('ch-1');
    expect(book.chapters[0].paragraphs).toEqual(['唯一的一段正文。']);
    expect(book.chapters.every((chapter) => chapter.paragraphs.length > 0)).toBe(true);
    expect(book.warnings.join('')).toMatch(/2 个空文档/);
  });
});

describe('importEpub · 封面与 DRM', () => {
  it('从 cover-image 属性提取封面并使用 manifest 的 mime', () => {
    const epub = sampleEpub({
      tocTitle: '第一章',
      body: '<p>封面测试正文。</p>',
      cover: {
        name: 'images/cover.png',
        data: PNG,
        mime: 'image/png',
        properties: 'cover-image',
      },
    });

    const book = importEpub(epub);
    expect(book.cover).not.toBeNull();
    if (!book.cover) throw new Error('封面应该存在');
    expect(book.cover.mime).toBe('image/png');
    expect(Array.from(book.cover.data)).toEqual(Array.from(PNG));
  });

  it('加密包含 xhtml 时抛 DRM 错误', () => {
    const epub = sampleEpub({
      body: '<p>被加密的正文。</p>',
      encryption: encryptionXml('OEBPS/text/ch1.xhtml'),
    });
    expect(() => importEpub(epub)).toThrow(/DRM/);
  });

  it('只加密字体时正常导入', () => {
    const epub = sampleEpub({
      body: '<p>字体加密不影响正文。</p>',
      encryption: encryptionXml('OEBPS/fonts/body.ttf'),
    });
    const book = importEpub(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].paragraphs).toContain('字体加密不影响正文。');
  });
});

describe('importEpub · 路径与层级细节', () => {
  it('平铺 TOC 全部 level 2，但卷标题保持 level 1', () => {
    const volume = importEpub(
      sampleEpub({ tocTitle: '第二卷 归航', body: '<p>卷首正文。</p>' }),
    );
    expect(volume.chapters[0].level).toBe(1);

    const chapter = importEpub(
      sampleEpub({ tocTitle: '第二章 归航', body: '<p>普通章节正文。</p>' }),
    );
    expect(chapter.chapters[0].level).toBe(2);
  });

  it('href 支持 ../ 与 percent-encoding，且能按解码后的名字找到 zip 条目', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>路径测试</dc:title>
<dc:creator>作者</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="nav" href="../nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="../text/ch%201.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`;

    const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="../text/ch%201.xhtml">第一章 解码</a></li>
</ol></nav></body>
</html>`;

    const epub = zipEpub({
      'META-INF/container.xml': CONTAINER.replace('OEBPS/content.opf', 'OEBPS/package/content.opf'),
      'OEBPS/package/content.opf': opf,
      'OEBPS/nav/nav.xhtml': nav,
      'OEBPS/text/ch 1.xhtml': xhtml('正文', '<p>路径解析成功的正文。</p>'),
    });

    const book = importEpub(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('第一章 解码');
    expect(book.chapters[0].paragraphs).toEqual(['路径解析成功的正文。']);
  });
});

describe('importEpub · 错误处理', () => {
  it('缺少 container.xml 时给出明确错误', () => {
    const epub = zipEpub({ 'OEBPS/content.opf': '<package/>' });
    expect(() => importEpub(epub)).toThrow(/container\.xml/);
  });
});


describe('EPUB 扩展元数据', () => {
  it('读取简介、出版社、标签、出版日期和系列', () => {
    const book = importEpub(richMetadataEpub());
    expect(book.description).toBe('一段简介。');
    expect(book.publisher).toBe('潮声出版社');
    expect(book.tags).toEqual(['悬疑', '海洋']);
    expect(book.publishedAt).toBe('2026-01-02');
    expect(book.series).toBe('雾港三部曲');
    expect(book.language).toBe('zh-TW');

    const parsed = toParseResult(book, 'x.epub');
    expect(parsed.metaGuess).toEqual({
      description: '一段简介。',
      series: '雾港三部曲',
      publisher: '潮声出版社',
      tags: ['悬疑', '海洋'],
      publishedAt: '2026-01-02',
    });
  });

  it('兼容 calibre:series 自定义列', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>旧书</dc:title><dc:language>zh-CN</dc:language>
<meta name="calibre:series" content="旧系列"/>
</metadata>
<manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="ch1"/></spine>
</package>`;
    const bytes = zipEpub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf,
      'OEBPS/text/ch1.xhtml': xhtml('第一章', '<p>正文。</p>'),
    });
    expect(importEpub(bytes).series).toBe('旧系列');
  });
});
