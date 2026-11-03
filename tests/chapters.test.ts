import { describe, expect, it } from 'vitest';
import {
  chaptersFromText,
  detectHeadings,
  findHeadingCandidates,
  guessAuthor,
  guessTitleFromText,
} from '../src/core/chapters';

const NOVEL = `内容简介
这是一个关于灯塔的故事。

第一卷 潮声
第一章 守塔人
雾从凌晨四点开始漫上礁石。
他数着楼梯，一级一级。

第二章 无名信
门外站着一个女孩。
她说她来找哥哥。

第二卷 雾中航线
第三章 潮汐表
她起得比他还早。

第四章 灯还亮着
他们在一个雨天出发。
`;

describe('章节识别', () => {
  it('识别卷、章与特殊章节', () => {
    const headings = detectHeadings(NOVEL.split('\n'));
    expect(headings.map((h) => h.title)).toEqual([
      '内容简介',
      '第一卷 潮声',
      '第一章 守塔人',
      '第二章 无名信',
      '第二卷 雾中航线',
      '第三章 潮汐表',
      '第四章 灯还亮着',
    ]);
    expect(headings.filter((h) => h.level === 1)).toHaveLength(2);
  });

  it('切分后正文不包含标题行', () => {
    const { chapters, warnings } = chaptersFromText(NOVEL, { filterAds: true });
    expect(warnings).toHaveLength(0);
    expect(chapters).toHaveLength(7);
    expect(chapters[2].title).toBe('第一章 守塔人');
    expect(chapters[2].paragraphs).toEqual(['雾从凌晨四点开始漫上礁石。', '他数着楼梯，一级一级。']);
    expect(chapters[1].level).toBe(1);
    expect(chapters[1].paragraphs).toEqual([]);
  });

  it('真实示例文件能切出 7 章并过滤广告', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync('public/sample.txt', 'utf8');
    const { chapters } = chaptersFromText(text, { filterAds: true });
    expect(chapters.map((c) => c.title)).toEqual([
      '内容简介',
      '第一卷 潮声',
      '第一章 守塔人',
      '第二章 无名信',
      '第二卷 雾中航线',
      '第三章 潮汐表',
      '第四章 灯还亮着',
    ]);
    const body = chapters.flatMap((c) => c.paragraphs).join('\n');
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('点击下一页');
  });

  it('标题内部带问号感叹号也能识别', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync('tests/fixtures/punctuation.txt', 'utf8');
    const { chapters } = chaptersFromText(text, { filterAds: true });
    expect(chapters.map((c) => c.title)).toEqual([
      '第1章 开始',
      '第654章谁家的？你家的',
      '第767章可怕！细思极恐',
    ]);
    expect(findHeadingCandidates(chapters)).toHaveLength(0);
  });

  it('丢弃开头的目录页', () => {
    const toc = Array.from({ length: 8 }, (_, i) => `第${i + 1}章 标题${i + 1}`).join('\n');
    const body = Array.from({ length: 8 }, (_, i) => {
      const paragraphs = Array.from({ length: 5 }, (_, j) => `第${i + 1}章第${j + 1}段内容。`).join('\n');
      return `第${i + 1}章 标题${i + 1}\n${paragraphs}`;
    }).join('\n\n');
    const { chapters } = chaptersFromText(`${toc}\n\n${body}`, { filterAds: true });
    expect(chapters).toHaveLength(8);
    expect(chapters[0].paragraphs).toHaveLength(5);
    expect(chapters[0].paragraphs[0]).toBe('第1章第1段内容。');
  });

  it('没有标题时按空行分章', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `第${i + 1}节\n第一段内容。\n第二段内容。`).join('\n\n');
    const { chapters } = chaptersFromText(blocks, { filterAds: true });
    expect(chapters).toHaveLength(6);
    expect(chapters[0].title).toBe('第1节');
  });

  it('完全无结构时退化为单章', () => {
    const { chapters, warnings } = chaptersFromText('只有一段话。\n还有一段话。', { filterAds: true });
    expect(chapters).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('站点水印和标题粘在同一行时仍能救回第一章', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync('tests/fixtures/messy.txt', 'utf8');
    const { chapters } = chaptersFromText(text, { filterAds: true });

    expect(chapters.map((c) => c.title)).toEqual([
      '内容简介',
      '第1章穿越重生',
      '第2章小时候的男主大人',
      '第3章咱们握手言和吧',
    ]);
    expect(chapters[0].paragraphs.join('')).toContain('穿进修仙小说');
    expect(chapters[0].paragraphs.join('')).not.toContain('尘屑飞扬');
    expect(chapters[1].paragraphs[0]).toBe('尘屑飞扬，遮天蔽日。');

    const front = chapters[0].paragraphs.join('\n');
    expect(front).not.toContain('ixdzs');
    expect(front).not.toContain('内容还在处理中');
    expect(front).not.toContain('章节内容开始');
    expect(front).not.toContain('正文');

    expect(guessAuthor(text)).toBe('风与天幕');
    expect(guessTitleFromText(text)).toBe('萌师在上：逆徒别乱来');
    expect(guessTitleFromText('没有书名信息')).toBe('');
  });

  it('标题密度过高时不误判', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `第${i + 1}章 标题`).join('\n');
    const { chapters } = chaptersFromText(lines, { filterAds: true });
    expect(chapters.length).toBeLessThan(40);
  });
});
