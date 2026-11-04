import type { Chapter } from '../types';

export type ReplaceScope = 'title' | 'body' | 'all';

export interface ReplaceOptions {
  find: string;
  replace: string;
  scope: ReplaceScope;
  /** 查找按正则解释；替换里可以用 $1 引用分组 */
  regex: boolean;
  caseSensitive: boolean;
}

export interface ReplaceMatch {
  chapterIndex: number;
  chapterId: string;
  chapterTitle: string;
  field: 'title' | 'body';
  /** 正文命中时为段落下标，标题命中为 null */
  paragraphIndex: number | null;
  before: string;
  match: string;
  after: string;
}

export interface ReplacePreview {
  ok: boolean;
  error?: string;
  total: number;
  matches: ReplaceMatch[];
  truncated: boolean;
}

export interface ReplaceOutcome {
  ok: boolean;
  error?: string;
  total: number;
  chapters: Chapter[];
}

/** 输入长度上限，避免把整本书粘进查找框 */
export const REPLACE_LIMITS = { pattern: 200, replacement: 500 } as const;
/** 预览里每条命中前后各保留多少字符 */
export const PREVIEW_CONTEXT = 16;
const PREVIEW_LIMIT = 20;
const MAX_MATCHES = 200_000;
const SCAN_BUDGET_MS = 3000;
const APPLY_BUDGET_MS = 8000;

/**
 * 识别常见「灾难性回溯」写法：嵌套量词、交替分支 + 无界量词。
 * 不是完备的正则分析，只挡掉最常把页面卡死的模式。
 */
export function looksCatastrophic(pattern: string): boolean {
  const nestedQuantifier = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*]/;
  const nestedUnbounded = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\{\d+,\}/;
  const alternationQuantifier = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*]/;
  return (
    nestedQuantifier.test(pattern) ||
    nestedUnbounded.test(pattern) ||
    alternationQuantifier.test(pattern)
  );
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateReplaceOptions(options: ReplaceOptions): string | null {
  if (!options.find) return '查找内容不能为空';
  if (options.find.length > REPLACE_LIMITS.pattern) {
    return `查找内容不能超过 ${REPLACE_LIMITS.pattern} 个字符`;
  }
  if (options.replace.length > REPLACE_LIMITS.replacement) {
    return `替换内容不能超过 ${REPLACE_LIMITS.replacement} 个字符`;
  }
  if (options.regex) {
    if (looksCatastrophic(options.find)) {
      return '这个正则包含嵌套量词，长文本上可能卡死，请换一种写法';
    }
    try {
      new RegExp(options.find);
    } catch (error) {
      return `正则表达式无效：${error instanceof Error ? error.message : '格式不正确'}`;
    }
  }
  return null;
}

function compilePattern(options: ReplaceOptions): { regex?: RegExp; error?: string } {
  const invalid = validateReplaceOptions(options);
  if (invalid) return { error: invalid };
  const source = options.regex ? options.find : escapeRegExp(options.find);
  try {
    return { regex: new RegExp(source, options.caseSensitive ? 'g' : 'gi') };
  } catch (error) {
    return { error: `正则表达式无效：${error instanceof Error ? error.message : '格式不正确'}` };
  }
}

interface FieldRef {
  chapter: Chapter;
  chapterIndex: number;
  field: 'title' | 'body';
  paragraphIndex: number | null;
  text: string;
}

function eachField(chapters: Chapter[], scope: ReplaceScope, visit: (ref: FieldRef) => boolean | void): boolean {
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    if (scope !== 'body') {
      if (visit({ chapter, chapterIndex, field: 'title', paragraphIndex: null, text: chapter.title }) === false) {
        return false;
      }
    }
    if (scope !== 'title') {
      for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
        const ref: FieldRef = {
          chapter,
          chapterIndex,
          field: 'body',
          paragraphIndex,
          text: chapter.paragraphs[paragraphIndex],
        };
        if (visit(ref) === false) return false;
      }
    }
  }
  return true;
}

function contextAround(text: string, index: number, length: number): { before: string; after: string } {
  const start = Math.max(0, index - PREVIEW_CONTEXT);
  const end = Math.min(text.length, index + length + PREVIEW_CONTEXT);
  return {
    before: text.slice(start, index),
    after: text.slice(index + length, end),
  };
}

/** 扫描命中；不修改章节。用于预览命中数与前后文 */
export function previewReplace(
  chapters: Chapter[],
  options: ReplaceOptions,
  limit = PREVIEW_LIMIT,
): ReplacePreview {
  const compiled = compilePattern(options);
  if (!compiled.regex) return { ok: false, error: compiled.error, total: 0, matches: [], truncated: false };
  const regex = compiled.regex;
  const startedAt = Date.now();
  let total = 0;
  let timedOut = false;
  const matches: ReplaceMatch[] = [];

  const completed = eachField(chapters, options.scope, (ref) => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(ref.text))) {
      total += 1;
      if (total > MAX_MATCHES) {
        timedOut = false;
        return false;
      }
      if (matches.length < limit) {
        const { before, after } = contextAround(ref.text, match.index, match[0].length);
        matches.push({
          chapterIndex: ref.chapterIndex,
          chapterId: ref.chapter.id,
          chapterTitle: ref.chapter.title,
          field: ref.field,
          paragraphIndex: ref.paragraphIndex,
          before,
          match: match[0],
          after,
        });
      }
      if (match[0].length === 0) regex.lastIndex += 1;
      if (Date.now() - startedAt > SCAN_BUDGET_MS) {
        timedOut = true;
        return false;
      }
    }
    return true;
  });

  if (total > MAX_MATCHES) {
    return {
      ok: false,
      error: `命中超过 ${MAX_MATCHES.toLocaleString('zh-CN')} 处，请缩小查找范围`,
      total,
      matches,
      truncated: false,
    };
  }
  if (timedOut && !completed) {
    return {
      ok: false,
      error: '预览超时：这个查找条件在长文本上太慢，请缩小范围或简化写法',
      total,
      matches,
      truncated: false,
    };
  }
  return { ok: true, total, matches, truncated: total > matches.length };
}

/** 命中替换并返回新章节；原数组不被修改 */
export function applyReplace(chapters: Chapter[], options: ReplaceOptions): ReplaceOutcome {
  const compiled = compilePattern(options);
  if (!compiled.regex) {
    return { ok: false, error: compiled.error, total: 0, chapters };
  }
  const regex = compiled.regex;
  const startedAt = Date.now();
  let total = 0;
  let timedOut = false;
  let tooMany = false;

  const replaceText = (text: string): string => {
    if (tooMany) return text;
    regex.lastIndex = 0;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      count += 1;
      if (count > MAX_MATCHES) {
        tooMany = true;
        break;
      }
      if (match[0].length === 0) regex.lastIndex += 1;
      if (Date.now() - startedAt > APPLY_BUDGET_MS) {
        timedOut = true;
        break;
      }
    }
    if (!count || timedOut || tooMany) return text;
    regex.lastIndex = 0;
    total += count;
    if (options.regex) return text.replace(regex, options.replace);
    // 普通文本查找时，替换内容里的 $1 / $& 都按字面量处理
    return text.replace(regex, () => options.replace);
  };

  const next = chapters.map((chapter) => {
    if (timedOut) return chapter;
    let changed = false;
    let title = chapter.title;
    if (options.scope !== 'body') {
      title = replaceText(title);
      if (title !== chapter.title) changed = true;
    }
    let paragraphs = chapter.paragraphs;
    if (options.scope !== 'title') {
      const updated = chapter.paragraphs.map((paragraph) => {
        if (timedOut) return paragraph;
        const replaced = replaceText(paragraph);
        if (replaced !== paragraph) changed = true;
        return replaced;
      });
      if (changed) paragraphs = updated;
    }
    return changed ? { ...chapter, title, paragraphs } : chapter;
  });

  if (tooMany) {
    return {
      ok: false,
      error: `命中超过 ${MAX_MATCHES.toLocaleString('zh-CN')} 处，请缩小查找范围`,
      total: 0,
      chapters,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      error: '替换超时，已取消本次操作；请缩小范围或改用更简单的查找条件',
      total: 0,
      chapters,
    };
  }
  return { ok: true, total, chapters: total ? next : chapters };
}
