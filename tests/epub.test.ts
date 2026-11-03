import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chaptersFromText } from '../src/core/chapters';
import { buildEpub } from '../src/core/epub';
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
    expect(spineRefs.length).toBe(docs.length);
  });

  it('可以输出 EPUB 2 兼容格式', () => {
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

  it('生成 samples/demo.epub 便于人工检查', () => {
    const dir = path.resolve('samples');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.epub'), bytes);
    expect(fs.statSync(path.join(dir, 'demo.epub')).size).toBeGreaterThan(1000);
  });
});
