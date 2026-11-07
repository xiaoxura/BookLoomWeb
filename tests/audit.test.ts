import { describe, expect, it } from 'vitest';
import {
  AUDIT_ISSUE_META,
  AUDIT_LONG_CHARS,
  AUDIT_SHORT_CHARS,
  auditChapters,
  numberToChinese,
  parseChapterNumber,
  parseChineseNumber,
  renumberChapters,
} from '../src/core/audit';
import type { Chapter } from '../src/types';

function chapter(id: string, title: string, level: 1 | 2, paragraphs: string[] = ['正文。']): Chapter {
  return { id, title, level, paragraphs };
}

function longText(length: number): string {
  return '字'.repeat(length);
}

describe('章号解析', () => {
  it('解析中文与阿拉伯数字', () => {
    expect(parseChapterNumber('第1章 开始')?.value).toBe(1);
    expect(parseChapterNumber('第1章 开始')?.style).toBe('arabic');
    expect(parseChapterNumber('第一章 守塔人')?.value).toBe(1);
    expect(parseChapterNumber('第一章 守塔人')?.style).toBe('cn');
    expect(parseChapterNumber('第 十二 回 风起')?.value).toBe(12);
    expect(parseChapterNumber('第一百零五节 归途')?.value).toBe(105);
    expect(parseChapterNumber('序章')?.value).toBeUndefined();
    expect(parseChapterNumber('第9章讲的是……')).not.toBeNull();
  });

  it('解析区间章号并给出区间末端', () => {
    const parsed = parseChapterNumber('第1045~1046章 现代番');
    expect(parsed?.value).toBe(1045);
    expect(parsed?.end).toBe(1046);
    expect(parseChapterNumber('第1045～1046章 现代番')?.end).toBe(1046);
    expect(parseChapterNumber('第3至5节 摘录')?.end).toBe(5);
    expect(parseChapterNumber('第3章 风起')?.end).toBeUndefined();
    expect(parseChapterNumber('第一章（下）')?.end).toBeUndefined();
  });

  it('中文数字与阿拉伯数字归一化', () => {
    expect(parseChineseNumber('十')).toBe(10);
    expect(parseChineseNumber('十二')).toBe(12);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('一百零五')).toBe(105);
    expect(parseChineseNumber('两千零一')).toBe(2001);
    expect(parseChineseNumber('一万二千三百四十五')).toBe(12345);
    expect(parseChineseNumber('abc')).toBeNull();
  });

  it('数字转中文，可往返', () => {
    expect(numberToChinese(0)).toBe('零');
    expect(numberToChinese(10)).toBe('十');
    expect(numberToChinese(12)).toBe('十二');
    expect(numberToChinese(20)).toBe('二十');
    expect(numberToChinese(105)).toBe('一百零五');
    expect(numberToChinese(1001)).toBe('一千零一');
    for (let n = 1; n <= 200; n += 1) {
      expect(parseChineseNumber(numberToChinese(n))).toBe(n);
    }
  });
});

describe('全书体检', () => {
  it('发现章号缺号', () => {
    const report = auditChapters([
      chapter('a', '第1章 开始', 2),
      chapter('b', '第2章 继续', 2),
      chapter('c', '第4章 转折', 2),
    ]);
    const missing = report.issues.filter((issue) => issue.kind === 'missing-number');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('缺少第 3 章');
    expect(missing[0].chapterId).toBe('c');
    expect(report.counts['missing-number']).toBe(1);
  });

  it('中文数字与阿拉伯数字混用也能比较', () => {
    const report = auditChapters([
      chapter('a', '第一章 开始', 2),
      chapter('b', '第2章 继续', 2),
      chapter('c', '第三章 转折', 2),
    ]);
    expect(report.counts['missing-number']).toBe(0);
    expect(report.counts['duplicate-number']).toBe(0);
  });

  it('区间章号覆盖其区间，不报缺号', () => {
    const report = auditChapters([
      chapter('a', '第1044章 现代番', 2),
      chapter('b', '第1045~1046章 现代番，一百三十', 2),
      chapter('c', '第1047章 现代番', 2),
    ]);
    expect(report.counts['missing-number']).toBe(0);
  });

  it('发现章号重复与标题重复', () => {
    const report = auditChapters([
      chapter('a', '第1章 开始', 2),
      chapter('b', '第1章 开始', 2),
      chapter('c', '第2章 继续', 2),
    ]);
    expect(report.counts['duplicate-number']).toBe(1);
    expect(report.issues.find((issue) => issue.kind === 'duplicate-number')?.message).toContain(
      '第 1 章',
    );
    expect(report.counts['duplicate-title']).toBe(1);
    expect(report.issues.find((issue) => issue.kind === 'duplicate-title')?.chapterId).toBe('b');
  });

  it('每卷从第 1 章重新编号时不算重复或缺号', () => {
    const report = auditChapters([
      chapter('v1', '第一卷 潮声', 1, []),
      chapter('a', '第1章 开始', 2),
      chapter('b', '第2章 继续', 2),
      chapter('v2', '第二卷 灯塔', 1, []),
      chapter('c', '第1章 重逢', 2),
      chapter('d', '第2章 归途', 2),
    ]);
    expect(report.counts['duplicate-number']).toBe(0);
    expect(report.counts['missing-number']).toBe(0);
    expect(report.counts['empty-volume']).toBe(0);
  });

  it('发现空章节、异常长短、卷内无章', () => {
    const report = auditChapters([
      chapter('v1', '第一卷 空卷', 1, []),
      chapter('v2', '第二卷 正常', 1, []),
      chapter('a', '第1章 空章', 2, []),
      chapter('b', '第2章 超长', 2, [longText(AUDIT_LONG_CHARS + 1)]),
      chapter('c', '第3章 超短', 2, [longText(AUDIT_SHORT_CHARS - 1)]),
    ]);
    expect(report.counts['empty-volume']).toBe(1);
    expect(report.counts['empty-chapter']).toBe(1);
    expect(report.counts['too-long']).toBe(1);
    expect(report.counts['too-short']).toBe(1);

    const meta = AUDIT_ISSUE_META['empty-volume'];
    expect(meta.label).toBe('卷内无章');
  });

  it('发现疑似广告残留并定位到段落', () => {
    const report = auditChapters([
      chapter('a', '第1章 开始', 2, ['正常正文。', '请记住本站域名 www.example.com', '继续正文。']),
    ]);
    const ad = report.issues.find((issue) => issue.kind === 'ad-leftover');
    expect(ad?.paragraphIndex).toBe(1);
    expect(ad?.message).toContain('疑似广告残留');
  });

  it('没有标题时可以给出体检结果，且不误报空章节里的卷', () => {
    const report = auditChapters([chapter('a', '正文', 2, ['一段。'])]);
    expect(report.total).toBe(0);
    expect(report.issues).toHaveLength(0);
  });
});

describe('按顺序重编号', () => {
  it('保留阿拉伯数字风格，只改章号', () => {
    const result = renumberChapters([
      chapter('a', '第1章 开始', 2),
      chapter('b', '第2章 继续', 2),
      chapter('c', '第4章 转折', 2),
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual(['第1章 开始', '第2章 继续', '第3章 转折']);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ from: 4, to: 3 });
  });

  it('保留中文数字风格，标题文字不动', () => {
    const result = renumberChapters([
      chapter('a', '第一章 守塔人', 2),
      chapter('b', '第二章 无名信', 2),
      chapter('c', '第四章 灯还亮着', 2),
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual([
      '第一章 守塔人',
      '第二章 无名信',
      '第三章 灯还亮着',
    ]);
  });

  it('特殊章节不参与编号', () => {
    const result = renumberChapters([
      chapter('a', '序章', 2),
      chapter('b', '第1章 开始', 2),
      chapter('c', '番外一 后来', 2),
      chapter('d', '第3章 继续', 2),
      chapter('e', '完本感言', 2),
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual([
      '序章',
      '第1章 开始',
      '番外一 后来',
      '第2章 继续',
      '完本感言',
    ]);
  });

  it('每卷重新编号的书保持每卷从 1 开始', () => {
    const result = renumberChapters([
      chapter('v1', '第一卷', 1, []),
      chapter('a', '第1章 开始', 2),
      chapter('b', '第3章 继续', 2),
      chapter('v2', '第二卷', 1, []),
      chapter('c', '第1章 重逢', 2),
      chapter('d', '第4章 归途', 2),
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual([
      '第一卷',
      '第1章 开始',
      '第2章 继续',
      '第二卷',
      '第1章 重逢',
      '第2章 归途',
    ]);
  });

  it('连续编号的书跨卷保持连续', () => {
    const result = renumberChapters([
      chapter('v1', '第一卷', 1, []),
      chapter('a', '第1章 开始', 2),
      chapter('b', '第2章 继续', 2),
      chapter('v2', '第二卷', 1, []),
      chapter('c', '第3章 重逢', 2),
      chapter('d', '第5章 归途', 2),
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual([
      '第一卷',
      '第1章 开始',
      '第2章 继续',
      '第二卷',
      '第3章 重逢',
      '第4章 归途',
    ]);
  });

  it('已经连续时返回原数组', () => {
    const chapters = [chapter('a', '第1章 开始', 2), chapter('b', '第2章 继续', 2)];
    const result = renumberChapters(chapters);
    expect(result.chapters).toBe(chapters);
    expect(result.changes).toHaveLength(0);
  });
});
