import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importDocx } from '../src/core/import/docx';
import { detectFormat } from '../src/core/import';

function p(text: string, style?: string, extra = ''): string {
  const pPr = style
    ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r>${extra}</w:p>`;
}

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function coreXml(title: string, author: string, language = 'zh-CN'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>${language}</dc:language>
</cp:coreProperties>`;
}

function makeDocx(body: string, core?: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(documentXml(body)),
  };
  if (core) files['docProps/core.xml'] = strToU8(core);
  return zipSync(files);
}

describe('DOCX 导入', () => {
  it('Heading 1 作为卷、Heading 2 作为章，普通段落进正文', () => {
    const bytes = makeDocx(
      [
        p('第一卷 潮声', 'Heading1'),
        p('第一章 守塔人', 'Heading2'),
        p('雾从凌晨四点开始漫上礁石。'),
        p('陆行舟照例在四点一刻醒来。'),
        p('第二章 无名信', 'Heading2'),
        p('门外站着个女孩。'),
      ].join(''),
    );
    const result = importDocx(bytes, '雾港灯塔.docx');
    expect(result.sourceType).toBe('docx');
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[0]).toMatchObject({ title: '第一卷 潮声', level: 1, paragraphs: [] });
    expect(result.chapters[1]).toMatchObject({
      title: '第一章 守塔人',
      level: 2,
      paragraphs: ['雾从凌晨四点开始漫上礁石。', '陆行舟照例在四点一刻醒来。'],
    });
    expect(result.chapters[2].title).toBe('第二章 无名信');
    expect(result.chapters[2].paragraphs).toEqual(['门外站着个女孩。']);
    expect(result.warnings).toHaveLength(0);
  });

  it('识别中文「标题 1 / 标题 2」样式', () => {
    const result = importDocx(
      makeDocx(
        [p('第一卷 潮声', '标题 1'), p('第一章 守塔人', '标题 2'), p('正文。')].join(''),
      ),
      'a.docx',
    );
    expect(result.chapters[0].level).toBe(1);
    expect(result.chapters[1].level).toBe(2);
  });

  it('只有 Heading 1 时按章节导入，不生成空卷', () => {
    const result = importDocx(
      makeDocx([p('第一章 开始', 'Heading1'), p('正文一。'), p('第二章 继续', 'Heading1'), p('正文二。')].join('')),
      'a.docx',
    );
    expect(result.chapters.map((chapter) => chapter.level)).toEqual([2, 2]);
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['第一章 开始', '第二章 继续']);
  });

  it('没有标题样式时退化为单章并提示', () => {
    const result = importDocx(
      makeDocx([p('第一段。'), p('第二段。')].join('')),
      '无样式.docx',
    );
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({ title: '正文', level: 2, paragraphs: ['第一段。', '第二段。'] });
    expect(result.warnings.join('')).toContain('没有找到标题样式');
  });

  it('第一个标题前的内容作为前言', () => {
    const result = importDocx(
      makeDocx([p('内容简介'), p('这是简介正文。'), p('第一章 开始', 'Heading2'), p('正文。')].join('')),
      'a.docx',
    );
    expect(result.chapters[0]).toMatchObject({
      title: '内容简介',
      level: 2,
      frontMatter: true,
      paragraphs: ['内容简介', '这是简介正文。'],
    });
    expect(result.chapters[1].title).toBe('第一章 开始');
  });

  it('合并多个 run、处理 tab 和 br，并跳过空段落', () => {
    const body = [
      '<w:p><w:r><w:t>第一</w:t></w:r><w:r><w:t>段</w:t></w:r><w:r><w:tab/><w:t>后续</w:t></w:r></w:p>',
      '<w:p><w:r><w:br/><w:t>换行后的内容</w:t></w:r></w:p>',
      '<w:p></w:p>',
    ].join('');
    const result = importDocx(makeDocx(body), 'a.docx');
    expect(result.chapters[0].paragraphs).toEqual(['第一段 后续', '换行后的内容']);
  });

  it('读取 docProps/core.xml 的书名、作者和语言', () => {
    const result = importDocx(
      makeDocx(p('第一章 开始', 'Heading2') + p('正文。'), coreXml('雾港灯塔', '林间')),
      'fallback.docx',
    );
    expect(result.titleGuess).toBe('雾港灯塔');
    expect(result.authorGuess).toBe('林间');
    expect(result.language).toBe('zh-CN');
    expect(result.chars).toBeGreaterThan(0);
  });

  it('图片和表格内容被忽略并给出提示', () => {
    const body = [
      p('第一章 开始', 'Heading2'),
      '<w:p><w:r><w:drawing/></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      p('正文。'),
    ].join('');
    const result = importDocx(makeDocx(body), 'a.docx');
    expect(result.warnings.join('')).toContain('图片');
    expect(result.warnings.join('')).toContain('表格');
    expect(result.chapters[0].paragraphs).toEqual(['正文。']);
  });

  it('大纲级别也能识别标题', () => {
    const body =
      '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>第一章 大纲标题</w:t></w:r></w:p>' +
      p('正文。');
    const result = importDocx(makeDocx(body), 'a.docx');
    expect(result.chapters[0].title).toBe('第一章 大纲标题');
    expect(result.chapters[0].level).toBe(2);
  });

  it('损坏或缺少 document.xml 时给出明确错误', () => {
    expect(() => importDocx(new Uint8Array([1, 2, 3]), 'bad.docx')).toThrow('DOCX 解析失败');
    const noDocument = zipSync({ 'word/styles.xml': strToU8('<x/>') });
    expect(() => importDocx(noDocument, 'bad.docx')).toThrow('缺少 word/document.xml');
  });
});

describe('DOCX 格式探测', () => {
  it('按扩展名识别 docx', () => {
    expect(detectFormat('书.docx', new Uint8Array())).toBe('docx');
    expect(detectFormat('书.DOCX', new Uint8Array())).toBe('docx');
    expect(detectFormat('书.txt', new Uint8Array())).toBe('txt');
  });

  it('没有扩展名时用 zip 里的文件名区分 DOCX / EPUB', () => {
    const docx = makeDocx(p('正文。'));
    expect(detectFormat('download', docx)).toBe('docx');
    const epub = zipSync({ mimetype: strToU8('application/epub+zip') });
    expect(detectFormat('download', epub)).toBe('epub');
    expect(detectFormat('download', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('epub');
  });
});
