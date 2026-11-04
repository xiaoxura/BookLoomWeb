import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chaptersFromText } from '../src/core/chapters';
import { buildEpub } from '../src/core/export/epub';
import type { Chapter, LayoutOptions } from '../src/types';

const LAYOUT: LayoutOptions = {
  lineHeight: 1.75,
  indent: true,
  paragraphSpacing: 0,
  font: 'serif',
  justify: true,
};

// 1x1 白色 JPEG，仅用于验证封面链路
const PIXEL_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function sampleChapters(): Chapter[] {
  const text = fs.readFileSync('public/sample.txt', 'utf8');
  return chaptersFromText(text, { filterAds: true }).chapters;
}

function buildSample() {
  return buildEpub({
    chapters: sampleChapters(),
    meta: { title: '雾港灯塔', author: '林间', language: 'zh-CN' },
    layout: LAYOUT,
    cover: { data: new Uint8Array(Buffer.from(PIXEL_JPEG, 'base64')), mime: 'image/jpeg' },
  });
}

function read(files: Record<string, Uint8Array>, name: string): string {
  const data = files[name];
  if (!data) throw new Error(`缺少文件 ${name}`);
  return strFromU8(data);
}

describe('buildEpub', () => {
  const bytes = buildSample();
  const files = unzipSync(bytes);

  it('mimetype 是第一个条目且不压缩', () => {
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(read(files, 'mimetype')).toBe('application/epub+zip');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
  });

  it('包含容器、OPF、导航与 NCX', () => {
    const container = read(files, 'META-INF/container.xml');
    expect(container).toContain('OEBPS/content.opf');

    const opf = read(files, 'OEBPS/content.opf');
    expect(opf).toContain('<dc:title>雾港灯塔</dc:title>');
    expect(opf).toContain('<dc:creator>林间</dc:creator>');
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('media-type="application/x-dtbncx+xml"');

    const nav = read(files, 'OEBPS/nav.xhtml');
    const tocNav = nav.split('id="landmarks"')[0];
    expect((tocNav.match(/<li>/g) ?? []).length).toBe(7);

    const ncx = read(files, 'OEBPS/toc.ncx');
    expect((ncx.match(/<navPoint /g) ?? []).length).toBe(7);
  });

  it('每个 XHTML 都是带声明和命名空间的完整文档', () => {
    const xhtmlFiles = Object.keys(files).filter((name) => name.startsWith('OEBPS/text/'));
    expect(xhtmlFiles.length).toBeGreaterThan(0);
    for (const name of xhtmlFiles) {
      const doc = read(files, name);
      expect(doc.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
      expect(doc).toContain('xmlns="http://www.w3.org/1999/xhtml"');
      expect(doc.trimEnd().endsWith('</html>')).toBe(true);
    }
  });

  it('正文里的 & < > 已转义', () => {
    const chapters: Chapter[] = [
      { id: 'a', title: 'A & B <测试>', level: 2, paragraphs: ['x < y && y > z 是成立的。'] },
    ];
    const output = buildEpub({
      chapters,
      meta: { title: '标题 & <符号>', author: 'a"b', language: 'zh-CN' },
      layout: LAYOUT,
      cover: null,
    });
    const extracted = unzipSync(output);
    const opf = strFromU8(extracted['OEBPS/content.opf']);
    expect(opf).toContain('标题 &amp; &lt;符号&gt;');
    expect(opf).toContain('a&quot;b');
    const chapterDoc = strFromU8(extracted['OEBPS/text/c0001-1.xhtml']);
    expect(chapterDoc).toContain('x &lt; y &amp;&amp; y &gt; z');
  });

  it('超长章节会拆成多个文档但只占一个目录项', () => {
    const paragraphs = Array.from({ length: 80 }, () => '一'.repeat(1000));
    const chapters: Chapter[] = [{ id: 'a', title: '很长的第一章', level: 2, paragraphs }];
    const output = buildEpub({
      chapters,
      meta: { title: '长章', author: '', language: 'zh-CN' },
      layout: LAYOUT,
      cover: null,
    });
    const extracted = unzipSync(output);
    const docs = Object.keys(extracted).filter((name) => name.startsWith('OEBPS/text/c0001-'));
    expect(docs.length).toBeGreaterThan(1);
    const nav = strFromU8(extracted['OEBPS/nav.xhtml']).split('id="landmarks"')[0];
    expect((nav.match(/<li>/g) ?? []).length).toBe(1);
    const opf = strFromU8(extracted['OEBPS/content.opf']);
    const spineRefs = opf.match(/<itemref /g) ?? [];
    expect(spineRefs.length).toBe(docs.length + 1); // 额外一个内嵌目录页
  });

  it('扩展元数据写进 OPF，系列字段只出现在 EPUB 3', () => {
    const meta = {
      title: '雾港灯塔',
      author: '林间',
      language: 'zh-CN',
      description: '一座灯塔 & 一封<没有>寄出的信。',
      series: '雾港三部曲',
      publisher: '潮声出版社',
      tags: ['悬疑', '海洋', '海洋'],
      publishedAt: '2026-01-02',
    };
    const chapters: Chapter[] = [
      { id: 'a', title: '第一章 守塔人', level: 2, paragraphs: ['正文。'] },
    ];
    const epub3 = unzipSync(buildEpub({ chapters, meta, layout: LAYOUT, cover: null }));
    const opf3 = strFromU8(epub3['OEBPS/content.opf']);
    expect(opf3).toContain('<dc:description>一座灯塔 &amp; 一封&lt;没有&gt;寄出的信。</dc:description>');
    expect(opf3).toContain('<dc:publisher>潮声出版社</dc:publisher>');
    expect(opf3).toContain('<dc:date>2026-01-02</dc:date>');
    expect((opf3.match(/<dc:subject>/g) ?? []).length).toBe(2);
    expect(opf3).toContain('<dc:subject>悬疑</dc:subject>');
    expect(opf3).toContain('<dc:subject>海洋</dc:subject>');
    expect(opf3).toContain('property="belongs-to-collection" id="series">雾港三部曲</meta>');
    expect(opf3).toContain('property="collection-type">series</meta>');

    const epub2 = unzipSync(
      buildEpub({ chapters, meta, layout: LAYOUT, cover: null, version: 2 }),
    );
    const opf2 = strFromU8(epub2['OEBPS/content.opf']);
    expect(opf2).toContain('<dc:description>');
    expect(opf2).toContain('<dc:publisher>潮声出版社</dc:publisher>');
    expect(opf2).toContain('<dc:date>2026-01-02</dc:date>');
    expect(opf2).not.toContain('belongs-to-collection');
  });

  it('内嵌目录页在封面之后、正文之前，EPUB 3 / 2 都有', () => {
    const chapters = sampleChapters();
    const cover = { data: new Uint8Array(Buffer.from(PIXEL_JPEG, 'base64')), mime: 'image/jpeg' };
    for (const version of [3, 2] as const) {
      const entries = unzipSync(buildEpub({ chapters, meta: { title: '雾港灯塔', author: '林间', language: 'zh-CN' }, layout: LAYOUT, cover, version }));
      const opf = strFromU8(entries['OEBPS/content.opf']);
      expect(opf).toContain('id="toc-page" href="text/toc.xhtml"');
      expect(opf).toContain('<reference type="toc" title="目录" href="text/toc.xhtml"/>');
      const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] ?? '';
      const order = [...spine.matchAll(/idref="([^"]+)"/g)].map((match) => match[1]);
      expect(order[0]).toBe('cover');
      expect(order[1]).toBe('toc-page');

      const toc = strFromU8(entries['OEBPS/text/toc.xhtml']);
      expect(toc).toContain('<h1>目录</h1>');
      expect(toc).toContain('href="c0002-1.xhtml"');
      expect(toc).toContain('第一卷 潮声');
      expect(toc).toContain('第一章 守塔人');
      expect(toc).not.toContain('epub:type');
    }
  });

  it('可以输出 EPUB 2 兼容格式', () => {
    fs.mkdirSync('samples', { recursive: true });
    const output = buildEpub({
      chapters: sampleChapters(),
      meta: { title: '雾港灯塔', author: '林间', language: 'zh-CN' },
      layout: LAYOUT,
      cover: { data: new Uint8Array(Buffer.from(PIXEL_JPEG, 'base64')), mime: 'image/jpeg' },
      version: 2,
    });
    const extracted = unzipSync(output);
    const opf = strFromU8(extracted['OEBPS/content.opf']);
    expect(opf).toContain('version="2.0"');
    expect(opf).not.toContain('properties="nav"');
    expect(opf).not.toContain('dcterms:modified');
    expect(extracted['OEBPS/nav.xhtml']).toBeUndefined();
    expect(extracted['OEBPS/toc.ncx']).toBeDefined();

    const doc = strFromU8(extracted['OEBPS/text/c0001-1.xhtml']);
    expect(doc).toContain('XHTML 1.1');
    expect(doc).not.toContain('epub:type');
    expect(doc).not.toContain('xmlns:epub');

    fs.writeFileSync(path.join('samples', 'demo-epub2.epub'), output);
  });

  it('章号单独一行、自定义 CSS、字体嵌入都写进包里', () => {
    const out = buildEpub({
      chapters: [{ id: 'a', title: '第一章 守塔人', level: 2, paragraphs: ['正文。'] }],
      meta: { title: '雾港灯塔', author: '林间', language: 'zh-CN' },
      layout: {
        ...LAYOUT,
        separateChapterNumber: true,
        customCss: '.my-rule { color: red; }',
      },
      cover: null,
      font: { name: 'SourceHanSerif.ttf', data: new Uint8Array([0, 1, 2, 3]), mime: 'font/ttf' },
    });
    const entries = unzipSync(out);
    const xhtml = read(entries, 'OEBPS/text/c0001-1.xhtml');
    expect(xhtml).toContain('<span class="chapter-number">第一章</span>守塔人');

    const css = read(entries, 'OEBPS/styles/style.css');
    expect(css).toContain('@font-face');
    expect(css).toContain('url("../fonts/embedded.ttf")');
    expect(css).toContain('.my-rule { color: red; }');

    const opf = read(entries, 'OEBPS/content.opf');
    expect(opf).toContain('href="fonts/embedded.ttf" media-type="font/ttf"');
    expect(entries['OEBPS/fonts/embedded.ttf']).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it('不开启章号分离时标题保持一行', () => {
    const out = buildEpub({
      chapters: [{ id: 'a', title: '第一章 守塔人', level: 2, paragraphs: ['正文。'] }],
      meta: { title: '雾港灯塔', author: '林间', language: 'zh-CN' },
      layout: LAYOUT,
      cover: null,
    });
    const xhtml = read(unzipSync(out), 'OEBPS/text/c0001-1.xhtml');
    expect(xhtml).not.toContain('chapter-number');
    expect(xhtml).toContain('第一章 守塔人');
  });

  it('生成 samples/demo.epub 便于人工检查', () => {
    const dir = path.resolve('samples');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.epub'), bytes);
    expect(fs.statSync(path.join(dir, 'demo.epub')).size).toBeGreaterThan(1000);
  });
});
