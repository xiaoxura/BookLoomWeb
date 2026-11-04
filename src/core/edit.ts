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

export function toggleChapterLevel(chapters: Chapter[], index: number): Chapter[] {
  const chapter = chapters[index];
  if (!chapter) return chapters;
  const next = chapters.slice();
  next[index] = { ...chapter, level: chapter.level === 1 ? 2 : 1 };
  return next;
}
