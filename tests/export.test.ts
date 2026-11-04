import { XMLValidator } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chaptersFromText } from '../src/core/chapters';
import { buildMarkdown } from '../src/core/export/markdown';
import { buildTxt } from '../src/core/export/txt';
import { buildDocx } from '../src/core/export/docx';
import { buildFormattedBook } from '../src/app/export';
import { buildHtml } from '../src/core/export/html';
import type { Chapter, LayoutOptions } from '../src/types';

const LAYOUT: LayoutOptions = {
  lineHeight: 1.75,
  indent: true,
  paragraphSpacing: 0,
  font: 'serif',
  justify: true,
};

const META = { title: '雾港灯塔 & 灯', author: '林间', language: 'zh-CN' };

const chapters: Chapter[] = [
  { id: 'a', title: '第一卷 潮声', level: 1, paragraphs: [] },
  { id: 'b', title: '第一章 守塔人', level: 2, paragraphs: ['夜色像一块湿透的布。', '他站在桥头。'] },
  { id: 'c', title: '第二章 无名信', level: 2, paragraphs: ['信上没有署名。'] },
];

describe('TXT 导出', () => {
  it('标题单独成行，段与段之间空一行', () => {
    expect(buildTxt(chapters)).toBe(
      [
        '第一卷 潮声',
        '',
        '',
        '第一章 守塔人',
        '',
        '夜色像一块湿透的布。',
        '',
        '他站在桥头。',
        '',
        '',
        '第二章 无名信',
        '',
        '信上没有署名。',
        '',
      ].join('\n'),
    );
  });

  it('空章节只留标题，前言不写标题', () => {
    const input: Chapter[] = [
      { id: 'f', title: '前言', level: 2, paragraphs: ['卷首语。'], frontMatter: true },
      { id: 'a', title: '第一章', level: 2, paragraphs: [] },
    ];
    expect(buildTxt(input)).toBe('卷首语。\n\n\n第一章\n');
  });

  it('导出的 TXT 再拖回来能识别成同样的章节', () => {
    const text = buildTxt(chapters);
    const { chapters: again } = chaptersFromText(text, { filterAds: true });
    expect(again.map((c) => c.title)).toEqual(['第一卷 潮声', '第一章 守塔人', '第二章 无名信']);
    expect(again[1].paragraphs).toEqual(['夜色像一块湿透的布。', '他站在桥头。']);
    expect(again[2].paragraphs).toEqual(['信上没有署名。']);
  });
});

describe('Markdown 导出', () => {
  it('有卷时卷用 ##、章用 ###', () => {
    const md = buildMarkdown(chapters, { title: '雾港灯塔', author: '风与天幕', language: 'zh-CN' });
    expect(md).toBe(
      [
        '# 雾港灯塔',
        '',
        '> 作者：风与天幕',
        '',
        '## 第一卷 潮声',
        '',
        '### 第一章 守塔人',
        '',
        '夜色像一块湿透的布。',
        '',
        '他站在桥头。',
        '',
        '### 第二章 无名信',
        '',
        '信上没有署名。',
        '',
      ].join('\n'),
    );
  });

  it('没有卷时章直接用 ##', () => {
    const md = buildMarkdown(chapters.slice(1), { title: '', author: '', language: 'zh-CN' });
    expect(md).toContain('# 未命名');
    expect(md).toContain('## 第一章 守塔人');
    expect(md).not.toContain('###');
  });
});


describe('DOCX 导出', () => {
  const bytes = buildDocx({ chapters, meta: META, layout: LAYOUT });
  const files = unzipSync(bytes);

  it('包含 WordprocessingML 必需部件且 XML 合法', () => {
    for (const name of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
    ]) {
      expect(files[name], `缺少 ${name}`).toBeTruthy();
      const xml = strFromU8(files[name]);
      expect(XMLValidator.validate(xml)).toBe(true);
    }
    expect(strFromU8(files['[Content_Types].xml'])).toContain('wordprocessingml.document.main+xml');
  });

  it('标题使用 Heading 1 / 2 样式，正文段落进文档', () => {
    const document = strFromU8(files['word/document.xml']);
    expect(document).toContain('w:val="Heading1"');
    expect(document).toContain('w:val="Heading2"');
    expect(document).toContain('第一卷 潮声');
    expect(document).toContain('第一章 守塔人');
    expect(document).toContain('夜色像一块湿透的布。');
    expect(document).toContain('雾港灯塔 &amp; 灯');
    expect(document).toContain('作者：林间');
    expect(document).toContain('<w:sectPr>');
  });

  it('样式里带行距、缩进、对齐和字体', () => {
    const styles = strFromU8(files['word/styles.xml']);
    expect(styles).toContain('w:styleId="Normal"');
    expect(styles).toContain('w:line="420"');
    expect(styles).toContain('w:firstLine="480"');
    expect(styles).toContain('w:jc w:val="both"');
    expect(styles).toContain('宋体');
  });

  it('开启「章号单独一行」时章号与标题分成两行', () => {
    const output = buildDocx({
      chapters: [{ id: 'a', title: '第一章 守塔人', level: 2, paragraphs: ['正文。'] }],
      meta: META,
      layout: { ...LAYOUT, separateChapterNumber: true },
    });
    const doc = strFromU8(unzipSync(output)['word/document.xml']);
    expect(doc).toContain('<w:br/>');
    expect(doc).toContain('第一章');
    expect(doc).toContain('守塔人');
  });

  it('正文里的特殊字符被转义', () => {
    const output = buildDocx({
      chapters: [{ id: 'a', title: 'A & B <测>', level: 2, paragraphs: ['x < y && y > z'] }],
      meta: { title: '标题 & <符号>', author: 'a"b', language: 'zh-CN' },
      layout: LAYOUT,
    });
    const doc = strFromU8(unzipSync(output)['word/document.xml']);
    expect(doc).toContain('A &amp; B &lt;测&gt;');
    expect(doc).toContain('x &lt; y &amp;&amp; y &gt; z');
  });
});

describe('单文件 HTML 导出', () => {
  const html = buildHtml({ chapters, meta: META, layout: LAYOUT });

  it('是完整的单文件文档，不依赖外部资源', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src=');
    expect(html).toContain('<html lang="zh-CN">');
  });

  it('目录锚点能跳到对应章节，卷章层级都有', () => {
    expect(html).toContain('href="#c-1"');
    expect(html).toContain('href="#c-2"');
    expect(html).toContain('id="c-1"');
    expect(html).toContain('class="toc-volume"');
    expect(html).toContain('class="toc-chapter"');
    expect(html).toContain('第一卷 潮声');
    expect(html).toContain('第一章 守塔人');
  });

  it('书名、作者、正文和排版参数写进 HTML', () => {
    expect(html).toContain('雾港灯塔 &amp; 灯');
    expect(html).toContain('<p>林间</p>');
    expect(html).toContain('夜色像一块湿透的布。');
    expect(html).toContain('line-height: 1.75');
    expect(html).toContain('text-indent: 2em');
    expect(html).toContain('text-align: justify');
  });

  it('没有书名时回退为未命名，特殊字符已转义', () => {
    const output = buildHtml({
      chapters: [{ id: 'a', title: 'A & B', level: 2, paragraphs: ['x < y'] }],
      meta: { title: '', author: '', language: 'zh-CN' },
      layout: LAYOUT,
    });
    expect(output).toContain('<title>未命名</title>');
    expect(output).toContain('A &amp; B');
    expect(output).toContain('x &lt; y');
    expect(output).not.toContain('作者');
  });
});


describe('批量 / 单本共用的格式化入口', () => {
  it('DOCX 和 HTML 返回正确的扩展名与 MIME', () => {
    const docx = buildFormattedBook('docx', chapters, META, LAYOUT);
    expect(docx).not.toBeNull();
    expect(docx?.ext).toBe('docx');
    expect(docx?.mime).toContain('wordprocessingml.document');
    expect(Object.keys(unzipSync(docx!.data))).toContain('word/document.xml');

    const html = buildFormattedBook('html', chapters, META, LAYOUT);
    expect(html?.ext).toBe('html');
    expect(html?.mime).toBe('text/html;charset=utf-8');
    expect(strFromU8(html!.data).startsWith('<!doctype html>')).toBe(true);

    expect(buildFormattedBook('epub', chapters, META, LAYOUT)).toBeNull();
    expect(buildFormattedBook('txt', [], META, LAYOUT)).toBeNull();
  });
});
