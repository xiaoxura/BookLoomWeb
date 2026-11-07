import type { Chapter } from '../types';
import { tidyTitleSpacing } from './chapters';

export type SplitMode = 'split' | 'title';

export function suggestChapterTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '新章节';
  const cleaned = trimmed.replace(/[。．.！!？?；;]+$/, '').trim() || trimmed;
  const tidy = tidyTitleSpacing(cleaned);
  return tidy.length <= 40 ? tidy : `${tidy.slice(0, 40)}…`;
}

/**
 * 在某一章的指定段落处分章。
 * - split：这一段成为新章的第一段，新章标题待用户改
 * - title：这一段变成新章标题，正文从下一段开始
 */
export function splitChapterAt(
  chapters: Chapter[],
  index: number,
  paragraphIndex: number,
  mode: SplitMode,
  newId: string,
  splitTitle = '新章节',
): Chapter[] {
  const source = chapters[index];
  if (!source) return chapters;
  if (paragraphIndex <= 0 || paragraphIndex >= source.paragraphs.length) return chapters;

  const head = source.paragraphs.slice(0, paragraphIndex);
  const rest = source.paragraphs.slice(paragraphIndex);
  const created: Chapter =
    mode === 'title'
      ? {
          id: newId,
          title: suggestChapterTitle(rest[0] ?? ''),
          level: 2,
          paragraphs: rest.slice(1),
        }
      : {
          id: newId,
          title: splitTitle,
          level: 2,
          paragraphs: rest,
        };

  const next = chapters.slice();
  next[index] = { ...source, paragraphs: head };
  next.splice(index + 1, 0, created);
  return next;
}

export function mergeChapterUp(chapters: Chapter[], index: number): Chapter[] {
  if (index <= 0 || index >= chapters.length) return chapters;
  const previous = chapters[index - 1];
  const current = chapters[index];
  const next = chapters.slice();
  next[index - 1] = { ...previous, paragraphs: [...previous.paragraphs, ...current.paragraphs] };
  next.splice(index, 1);
  return next;
}

export function removeChapterAt(chapters: Chapter[], index: number): Chapter[] {
  if (chapters.length <= 1 || index < 0 || index >= chapters.length) return chapters;
  const next = chapters.slice();
  next.splice(index, 1);
  return next;
}

/** 新章节的默认标题；用户插入后可以直接改 */
export const UNNAMED_CHAPTER_TITLE = '（未命名）';
/** 新卷的默认标题；卷只是文件夹，永远没有正文 */
export const UNNAMED_VOLUME_TITLE = '（未命名卷）';

/** 在某章前 / 后插入一个空白章节，用于手动补全缺失章节 */
export function insertChapter(
  chapters: Chapter[],
  index: number,
  position: 'before' | 'after',
  newId: string,
): Chapter[] {
  if (index < 0 || index >= chapters.length) return chapters;
  const created: Chapter = { id: newId, title: UNNAMED_CHAPTER_TITLE, level: 2, paragraphs: [] };
  const next = chapters.slice();
  next.splice(position === 'before' ? index : index + 1, 0, created);
  return next;
}

/**
 * 把某个正文段落设置为新卷名（卷 = 文件夹，永远没有正文）：
 * - 段落之前的位置留在原章节里（归属上一个卷的最后章节）；
 * - 选中段落成为新卷（空正文），仅插入结构，位于上一卷之后；
 * - 新卷与下一个卷之间的章节，自然从上一个卷提升到新卷（数组连续性天然成立）；
 * - 新卷开始后到下一个已有章节标题之间的正文，拼成新卷下第一个章节「（未命名）」。
 */
export function setVolumeFromParagraph(
  chapters: Chapter[],
  chapterIndex: number,
  paragraphIndex: number,
  volumeId: string,
  remainderId: string,
): Chapter[] | null {
  const source = chapters[chapterIndex];
  if (!source) return null;
  const sourceType = source.level;
  if (sourceType !== 2) return null; // 卷不允许从卷里设
  const paragraph = source.paragraphs[paragraphIndex];
  if (!paragraph?.trim()) return null;
  if (paragraphIndex === 0) return null; // 第一段本身是章标题行，不适合做卷名

  const head = source.paragraphs.slice(0, paragraphIndex);
  const rest = source.paragraphs.slice(paragraphIndex + 1);

  const volume: Chapter = {
    id: volumeId,
    title: tidyTitleSpacing(paragraph.trim()),
    level: 1,
    paragraphs: [],
  };
  const created: Chapter[] = [volume];
  if (rest.length) {
    created.push({
      id: remainderId,
      title: UNNAMED_CHAPTER_TITLE,
      level: 2,
      paragraphs: rest,
    });
  }

  const next = chapters.slice();
  next[chapterIndex] = { ...source, paragraphs: head };
  next.splice(chapterIndex + 1, 0, ...created);
  return next;
}

/** 在某章后插入一个新卷（空文件夹），供后续批量移动章节进去 */
export function insertVolumeAfter(chapters: Chapter[], index: number, newId: string): Chapter[] {
  if (index < 0 || index >= chapters.length) return chapters;
  const created: Chapter = {
    id: newId,
    title: UNNAMED_VOLUME_TITLE,
    level: 1,
    paragraphs: [],
  };
  const next = chapters.slice();
  next.splice(index + 1, 0, created);
  return next;
}

/** 取消分卷：只移除卷标题行；其下章节因数组连续性自动归属上一个卷（或成为顶层） */
export function dissolveVolume(chapters: Chapter[], index: number): Chapter[] {
  const chapter = chapters[index];
  if (!chapter || chapter.level !== 1) return chapters;
  const next = chapters.slice();
  next.splice(index, 1);
  return next;
}

/**
 * 批量移动章节到指定卷：
 * - targetVolumeId 为目标卷 id，章节按原相对顺序插到该卷标题之后；
 * - 为 null 时移动到全部卷之后（顶层），没有任何卷时保持不动；
 * - 卷本身不参与移动；目标位置与原位置一致时返回原数组（无需入历史）。
 */
export function moveChaptersToVolume(
  chapters: Chapter[],
  ids: string[],
  targetVolumeId: string | null,
): Chapter[] {
  if (!ids.length) return chapters;
  const movingSet = new Set(ids);
  const moving = chapters.filter(
    (chapter) => movingSet.has(chapter.id) && chapter.level === 2,
  );
  if (!moving.length) return chapters;

  const rest = chapters.filter((chapter) => !movingSet.has(chapter.id));
  // 章节依赖连续顺序成立树状关系：移动后必须保持volume章节相邻顺序
  const targetIndex = (() => {
    if (targetVolumeId) {
      const volumeIdx = rest.findIndex((c) => c.id === targetVolumeId && c.level === 1);
      if (volumeIdx < 0) return -1;
      return volumeIdx + 1;
    }
    // 顶层：全部卷之后；还没有任何卷时保持不动
    let last = -1;
    for (let i = 0; i < rest.length; i += 1) if (rest[i].level === 1) last = i;
    if (last < 0) return -1;
    return last + 1;
  })();
  if (targetIndex < 0) return chapters;

  // 目标卷正好在移动块原位置上时，数组顺序可能毫无变化；比较一次避免多余快照
  const candidate = [...rest.slice(0, targetIndex), ...moving, ...rest.slice(targetIndex)];
  return sameOrder(candidate, chapters) ? chapters : candidate;
}

function sameOrder(a: Chapter[], b: Chapter[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 编辑某个正文段落；内容没变化时返回原数组（无需入历史） */
export function editParagraphAt(
  chapters: Chapter[],
  chapterIndex: number,
  paragraphIndex: number,
  text: string,
): Chapter[] {
  const source = chapters[chapterIndex];
  if (!source) return chapters;
  const next = source.paragraphs[paragraphIndex] === text ? chapters : chapters.slice();
  if (next === chapters) return chapters;
  const paragraphs = source.paragraphs.slice();
  paragraphs[paragraphIndex] = text;
  next[chapterIndex] = { ...source, paragraphs };
  return next;
}

export interface DeleteParagraphResult {
  chapters: Chapter[];
  /** 段落删空后连这一章一起移除了 */
  removedChapter: boolean;
}

/** 删除某个正文段落；本章删空时连章一起移除（全书至少保留一章） */
export function deleteParagraphAt(
  chapters: Chapter[],
  chapterIndex: number,
  paragraphIndex: number,
): DeleteParagraphResult {
  const source = chapters[chapterIndex];
  if (!source) return { chapters, removedChapter: false };
  const paragraphs = source.paragraphs.slice();
  paragraphs.splice(paragraphIndex, 1);
  const next = chapters.slice();
  if (paragraphs.length === 0 && chapters.length > 1) {
    next.splice(chapterIndex, 1);
    return { chapters: next, removedChapter: true };
  }
  next[chapterIndex] = { ...source, paragraphs };
  return { chapters: next, removedChapter: false };
}

/** 在某段落之后插入一个新空段落；afterIndex 传 -1 表示插到章首；返回新段的下标 */
export function insertParagraphAfter(
  chapters: Chapter[],
  chapterIndex: number,
  afterIndex: number,
): { chapters: Chapter[]; paragraphIndex: number } {
  const source = chapters[chapterIndex];
  if (!source) return { chapters, paragraphIndex: -1 };
  const at = afterIndex < -1 ? -1 : Math.min(afterIndex, source.paragraphs.length - 1);
  const insertAt = at + 1;
  const paragraphs = source.paragraphs.slice();
  paragraphs.splice(insertAt, 0, '');
  const next = chapters.slice();
  next[chapterIndex] = { ...source, paragraphs };
  return { chapters: next, paragraphIndex: insertAt };
}
