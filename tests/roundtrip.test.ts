import { describe, expect, it } from 'vitest';
import { chaptersFromText } from '../src/core/chapters';
import { buildEpub } from '../src/core/export/epub';
import { buildMarkdown } from '../src/core/export/markdown';
import { buildTxt } from '../src/core/export/txt';
import { importEpub } from '../src/core/import/epub';
import type { Chapter, LayoutOptions } from '../src/types';

const layout: LayoutOptions = {
  lineHeight: 1.75,
  indent: true,
  paragraphSpacing: 0,
  font: 'serif',
  justify: true,
};

const chapters: Chapter[] = [
  { id: 'a', title: '第一卷 潮声', level: 1, paragraphs: [] },
  {
    id: 'b',
    title: '第一章 守塔人',
    level: 2,
    paragraphs: ['夜色像一块湿透的布，慢慢盖住了整座城。', '他站在桥头，听见远处传来汽笛声。'],
  },
  { id: 'c', title: '第二章 无名信', level: 2, paragraphs: ['信上没有署名，只有一枚褪色的邮戳。'] },
];

function toEpub(): Uint8Array {
  return buildEpub({
    chapters,
    meta: { title: '雾港灯塔', author: '风与天幕', language: 'zh-CN' },
    layout,
    cover: null,
    version: 3,
  });
}

describe('TXT → EPUB → TXT 往返', () => {
  it('EPUB 里读回来的章节、层级、段落与原文一致', () => {
    const book = importEpub(toEpub());
    expect(book.title).toBe('雾港灯塔');
    expect(book.author).toBe('风与天幕');
    expect(book.chapters.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
    expect(book.chapters.map((c) => c.level)).toEqual(chapters.map((c) => c.level));

    const text = buildTxt(book.chapters);
    const { chapters: again } = chaptersFromText(text, { filterAds: true });
    expect(again.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
    expect(again[1].paragraphs).toEqual(chapters[1].paragraphs);
    expect(again[2].paragraphs).toEqual(chapters[2].paragraphs);
  });

  it('导入后可以直接导出 Markdown', () => {
    const book = importEpub(toEpub());
    const md = buildMarkdown(book.chapters, {
      title: book.title,
      author: book.author,
      language: book.language,
    });
    expect(md).toContain('# 雾港灯塔');
    expect(md).toContain('## 第一卷 潮声');
    expect(md).toContain('### 第一章 守塔人');
    expect(md).toContain('夜色像一块湿透的布');
  });

  it('EPUB 2 也能读回来', () => {
    const data = buildEpub({
      chapters,
      meta: { title: '雾港灯塔', author: '风与天幕', language: 'zh-CN' },
      layout,
      cover: null,
      version: 2,
    });
    const book = importEpub(data);
    expect(book.chapters.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
  });
});
