import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chaptersFromText, findHeadingCandidates } from '../src/core/chapters';
import {
  UNNAMED_CHAPTER_TITLE,
  UNNAMED_VOLUME_TITLE,
  dissolveVolume,
  insertChapter,
  insertVolumeAfter,
  mergeChapterUp,
  moveChaptersToVolume,
  removeChapterAt,
  setVolumeFromParagraph,
  splitChapterAt,
  suggestChapterTitle,
} from '../src/core/edit';
import type { Chapter } from '../src/types';

function makeChapters(): Chapter[] {
  return [
    { id: 'a', title: '第一章', level: 2, paragraphs: ['第一段。', '第二段。', '第三段。'] },
    { id: 'b', title: '第二章', level: 2, paragraphs: ['第四章的内容。', '第五段。'] },
  ];
}

function makeBook(): Chapter[] {
  return [
    { id: 'v1', title: '第一卷 潮声', level: 1, paragraphs: [] },
    { id: 'a', title: '第一章', level: 2, paragraphs: ['甲甲甲。'] },
    { id: 'b', title: '第二章', level: 2, paragraphs: ['乙乙乙。'] },
    { id: 'v2', title: '第二卷 雾中', level: 1, paragraphs: [] },
    { id: 'c', title: '第三章', level: 2, paragraphs: ['丙丙丙。'] },
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

  it('合并、删除', () => {
    const merged = mergeChapterUp(makeChapters(), 1);
    expect(merged).toHaveLength(1);
    expect(merged[0].paragraphs).toHaveLength(5);

    const removed = removeChapterAt(makeChapters(), 0);
    expect(removed.map((c) => c.title)).toEqual(['第二章']);
  });

  it('新建章节可插在任意前后', () => {
    const before = insertChapter(makeBook(), 2, 'before', 'n1');
    expect(before[2].title).toBe(UNNAMED_CHAPTER_TITLE);
    expect(before[2].level).toBe(2);
    expect(before[2].paragraphs).toEqual([]);
    const after = insertChapter(makeBook(), 2, 'after', 'n2');
    expect(after[3].title).toBe(UNNAMED_CHAPTER_TITLE);
  });

  it('在某章后新建空卷文件夹', () => {
    const next = insertVolumeAfter(makeBook(), 2, 'v9');
    expect(next[3]).toMatchObject({ id: 'v9', level: 1, paragraphs: [] });
    expect(next[3].title).toBe(UNNAMED_VOLUME_TITLE);
    expect(next).toHaveLength(6);
  });

  it('取消分卷后，其下章节归属上一个卷（顺序连续）', () => {
    const dissolved = dissolveVolume(makeBook(), 3);
    expect(dissolved.map((c) => c.title)).not.toContain('第二卷 雾中');
    // 第三章现在仍排在第二章后面，结构上归属第一卷
    expect(dissolved[dissolved.length - 1].title).toBe('第三章');
  });

  it('段落设为卷名：前面的文字留在上一卷，之后的正文拼成新卷下第一个章节', () => {
    const mixed: Chapter[] = [
      { id: 'v1', title: '第一卷 潮声', level: 1, paragraphs: [] },
      {
        id: 'a',
        title: '第一章 背叛',
        level: 2,
        paragraphs: ['她盯着他不说话。', '第五卷 背水一战', '元初一出现，立马就被围住了。', '他们围住了元初。'],
      },
    ];
    const next = setVolumeFromParagraph(mixed, 1, 1, 'v5', 'r1');
    expect(next).not.toBeNull();
    expect(next![0].level).toBe(1);
    expect(next![1]).toMatchObject({ id: 'a', title: '第一章 背叛', paragraphs: ['她盯着他不说话。'] });
    expect(next![2]).toMatchObject({ id: 'v5', level: 1, title: '第五卷 背水一战', paragraphs: [] });
    expect(next![3]).toMatchObject({ id: 'r1', title: UNNAMED_CHAPTER_TITLE, level: 2 });
    expect(next![3].paragraphs).toEqual(['元初一出现，立马就被围住了。', '他们围住了元初。']);

    // 第一段是章标题本身，不允许设卷；卷内选段也不行
    expect(setVolumeFromParagraph(mixed, 1, 0, 'v5', 'r1')).toBeNull();
    expect(setVolumeFromParagraph(makeBook(), 0, -1, 'v5', 'r1')).toBeNull();
  });

  it('批量移动章节到指定卷，保持目标卷内相对顺序', () => {
    const moved = moveChaptersToVolume(makeBook(), ['a', 'c'], 'v2');
    expect(moved.map((c) => c.title)).toEqual([
      '第一卷 潮声',
      '第二章',
      '第二卷 雾中',
      '第一章',
      '第三章',
    ]);
    // 再移动一次到相同位置：无需更新（原数组返回）
    expect(moveChaptersToVolume(moved, ['a', 'c'], 'v2')).toBe(moved);
    // 卷本身不参与移动
    const base = makeBook();
    expect(moveChaptersToVolume(base, ['v1'], 'v2')).toBe(base);
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
