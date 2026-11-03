import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chaptersFromText, findHeadingCandidates } from '../src/core/chapters';
import {
  mergeChapterUp,
  removeChapterAt,
  splitChapterAt,
  suggestChapterTitle,
  toggleChapterLevel,
} from '../src/core/edit';
import type { Chapter } from '../src/types';

function makeChapters(): Chapter[] {
  return [
    { id: 'a', title: '第一章', level: 2, paragraphs: ['第一段。', '第二段。', '第三段。'] },
    { id: 'b', title: '第二章', level: 2, paragraphs: ['第四章的内容。', '第五段。'] },
  ];
}

describe('章节结构编辑', () => {
  it('从指定段落分章，新章继承正文', () => {
    const next = splitChapterAt(makeChapters(), 0, 1, 'split', 'new');
    expect(next).toHaveLength(3);
    expect(next[0].paragraphs).toEqual(['第一段。']);
    expect(next[1].title).toBe('新章节');
    expect(next[1].level).toBe(2);
    expect(next[1].paragraphs).toEqual(['第二段。', '第三段。']);
  });

  it('把段落设为标题', () => {
    const chapters: Chapter[] = [
      { id: 'a', title: '前言', level: 2, paragraphs: ['卷首语。', '第九章 决战', '正文。'] },
    ];
    const next = splitChapterAt(chapters, 0, 1, 'title', 'new');
    expect(next).toHaveLength(2);
    expect(next[1].title).toBe('第九章 决战');
    expect(next[1].paragraphs).toEqual(['正文。']);
  });

  it('第一段不可分章', () => {
    const chapters = makeChapters();
    expect(splitChapterAt(chapters, 0, 0, 'split', 'new')).toBe(chapters);
    expect(splitChapterAt(chapters, 0, 5, 'split', 'new')).toBe(chapters);
  });

  it('合并、删除、升降级', () => {
    const merged = mergeChapterUp(makeChapters(), 1);
    expect(merged).toHaveLength(1);
    expect(merged[0].paragraphs).toHaveLength(5);

    const removed = removeChapterAt(makeChapters(), 0);
    expect(removed.map((c) => c.title)).toEqual(['第二章']);

    const promoted = toggleChapterLevel(makeChapters(), 0);
    expect(promoted[0].level).toBe(1);
    expect(toggleChapterLevel(promoted, 0)[0].level).toBe(2);
  });

  it('长标题会截断，句末标点会去掉', () => {
    expect(suggestChapterTitle('短标题')).toBe('短标题');
    expect(suggestChapterTitle('第9章 决战。')).toBe('第9章 决战');
    expect(suggestChapterTitle('一'.repeat(60))).toHaveLength(41);
  });

  it('诊断能找出没被识别的标题行', () => {
    const text = fs.readFileSync('tests/fixtures/missed.txt', 'utf8');
    const { chapters } = chaptersFromText(text, { filterAds: true });
    expect(chapters).toHaveLength(2);

    const candidates = findHeadingCandidates(chapters);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].paragraphIndex).toBe(1);
    expect(candidates[0].text).toBe('第9章 决战。');

    const fixed = splitChapterAt(chapters, candidates[0].chapterIndex, candidates[0].paragraphIndex, 'title', 'new');
    expect(fixed.map((c) => c.title)).toEqual(['第1章 开始', '第2章 继续', '第9章 决战']);
    expect(findHeadingCandidates(fixed)).toHaveLength(0);
  });
});
