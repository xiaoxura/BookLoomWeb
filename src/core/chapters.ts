import type { Chapter } from '../types';
import type { CompiledRules } from './rules';
import { buildParagraphs, type ParagraphOptions } from './text';

const CN_NUM = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟';
const PREFIX = '(?:正文[\\s·:：\\-—]*)?';

const VOLUME_RE = new RegExp(
  `^${PREFIX}第\\s*[${CN_NUM}\\d]{1,8}\\s*[卷部篇集](?:\\s*[、.．:：·\\-—]\\s*)?[^。]{0,30}$`,
);
const VOLUME_ALT_RE = new RegExp(`^[卷部篇集]\\s*[${CN_NUM}\\d]{1,6}(?:\\s*[、.．:：·\\-—]\\s*)?[^。]{0,24}$`);
const CHAPTER_RE = new RegExp(
  `^${PREFIX}第\\s*[${CN_NUM}\\d]{1,8}\\s*[章节回话](?:\\s*[、.．:：·\\-—]\\s*)?[^。]{0,30}$`,
);
const SPECIAL_RE =
  /^(?:序章|序言|序|楔子|引子|前言|引言|后记|尾声|终章|最终章|完本感言|大结局|番外(?:篇)?(?:[\s:：·、.．\-—]?\s*[0-9一二三四五六七八九十百千]{0,6})?|附录|作者的话|内容简介)(?:[\s:：·、.．\-—].{0,30})?$/;
const ENGLISH_RE = /^(?:chapter|part|volume|section|page|prologue|epilogue)\b[\s.:：\-—]*.{0,40}$/i;

/**
 * 「第X部分 / 部门 / 部队 / 部件 / 部落」是正文常用词，不是卷。
 * 来自 kaf-cli 的排除规则：部后面紧跟这些字时整行不当作标题；
 * 「第一部 分道扬镳」这种带空格的仍然正常识别。
 */
const HEADING_EXCLUDE_RE = new RegExp(
  `^${PREFIX}第\\s*[${CN_NUM}\\d]{1,8}\\s*部(?:门|队|属|分|件|落)|^${PREFIX}第\\s*[${CN_NUM}\\d]{1,8}\\s*部[^。]{0,30}[：:]\\s*$`,
);

/** 章节标题的"核心"部分，允许前面粘着站点水印 */
const HEAD_CORE = new RegExp(`第\\s*[${CN_NUM}\\d]{1,8}\\s*[章节回卷部篇集]`);
const INLINE_JUNK =
  /(内容还在处理中|正在手打中|正在更新中|本章未完|请稍后|请稍候|加载中|手机用户|手机阅读|百度搜索|天才一秒记住|记住本站|求月票|求推荐票|更新最快|无弹窗|笔趣阁|最新章节|电子书|txt)/i;

export interface Heading {
  line: number;
  title: string;
  level: 1 | 2;
  score: number;
  /** 正文从这个下标开始；默认 line + 1 */
  bodyStart?: number;
}

/** 章号后统一补的间隔；想换成两个半角空格改这里即可 */
const MARKER_GAP = ' ';
/** 「第1章我的天呐」→「第1章 我的天呐」；后面已经是空格或分隔标点就不动 */
const MARKER_GAP_RE = new RegExp(
  `(第\\s*[${CN_NUM}\\d]{1,8}\\s*[章节回话卷部篇集])(?=[^\\s、.．:：·\\-—（(【\\[《「『〈])`,
);

/** 章号和标题之间没空格时补一个，导出后的目录更好看 */
export function tidyTitleSpacing(title: string): string {
  return title.replace(MARKER_GAP_RE, `$1${MARKER_GAP}`);
}

function cleanTitle(line: string): string {
  const t = line.replace(/\s+/g, ' ').trim();
  const stripped = t
    .replace(/[（(【\[]\s*(?:求|感谢|首发|更新|本章|第[一二三四五六七八九十\d]+更)[^）)】\]]{0,20}[）)】\]]\s*$/, '')
    .trim();
  return tidyTitleSpacing(stripped || t);
}

function classify(
  line: string,
  rules?: CompiledRules | null,
): { title: string; level: 1 | 2; score: number } | null {
  if (line.length > 120) return null;
  if (rules?.volume?.test(line)) return { title: cleanTitle(line), level: 1, score: 110 };
  if (rules?.chapter?.test(line)) return { title: cleanTitle(line), level: 2, score: 105 };
  // 用户规则优先，内置规则命中前先排掉「第X部分」这类正文词
  if (HEADING_EXCLUDE_RE.test(line)) return null;
  if (line.length > 42) return null;
  if (/[。！？!?]$/.test(line)) return null;
  if (line.length > 26 && /[，,；;]/.test(line)) return null;

  if (VOLUME_RE.test(line) || VOLUME_ALT_RE.test(line)) {
    return { title: cleanTitle(line), level: 1, score: 100 };
  }
  if (CHAPTER_RE.test(line)) {
    return { title: cleanTitle(line), level: 2, score: 95 };
  }
  if (SPECIAL_RE.test(line)) {
    return { title: cleanTitle(line), level: 2, score: 90 };
  }
  if (ENGLISH_RE.test(line)) {
    return { title: cleanTitle(line), level: 2, score: 85 };
  }
  return null;
}

/** 站点水印和标题粘在同一行时，把标题救回来 */
function recoverInlineHeading(
  line: string,
  rules?: CompiledRules | null,
): { title: string; level: 1 | 2; score: number } | null {
  const match = HEAD_CORE.exec(line);
  if (!match || match.index === 0) return null;
  const prefix = line.slice(0, match.index).trim();
  if (!prefix || prefix.length > 24) return null;
  const knownJunk = INLINE_JUNK.test(prefix) || Boolean(rules?.inlineJunk?.test(prefix));
  if (!knownJunk) return null;
  const suffix = line.slice(match.index).trim();
  if (!suffix || suffix.length > 42) return null;
  return classify(suffix, rules);
}

export function detectHeadings(lines: string[], rules?: CompiledRules | null): Heading[] {
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const hit = classify(line, rules) ?? recoverInlineHeading(line, rules);
    if (hit) out.push({ line: i, ...hit });
  }
  return out;
}

/** 标题太密说明误判了（比如正文里出现"第一章"字样），收紧阈值或直接放弃 */
function pruneHeadings(headings: Heading[]): Heading[] {
  if (headings.length <= 1) return headings;
  const averageGap =
    (headings[headings.length - 1].line - headings[0].line) / Math.max(1, headings.length - 1);
  if (averageGap >= 3) return headings;

  const strict = headings.filter((h) => h.score >= 95);
  if (strict.length > 1) {
    const strictGap = (strict[strict.length - 1].line - strict[0].line) / (strict.length - 1);
    if (strictGap >= 2) return strict;
  }
  return [];
}

/** 开头的目录页会变成一串紧挨着的标题，先整体摘掉 */
function stripTocPrefix(headings: Heading[]): { headings: Heading[]; dropUntil: number } {
  let end = 0;
  while (end + 1 < headings.length && headings[end + 1].line - headings[end].line <= 1) end++;
  if (end + 1 >= headings.length) {
    return end >= 4 ? { headings: [], dropUntil: headings[end].line } : { headings, dropUntil: -1 };
  }
  if (end + 1 >= 5) return { headings: headings.slice(end + 1), dropUntil: headings[end].line };
  return { headings, dropUntil: -1 };
}

/**
 * 兜底：很多 TXT 用空行分章、且没有"第X章"标题。
 * 把空行分隔的块首行当作章节标题。
 */
export function fallbackByBlankLines(lines: string[]): Heading[] {
  const blocks: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      blocks.push({ start, end: i });
      start = -1;
    }
  }
  if (start >= 0) blocks.push({ start, end: lines.length });
  if (blocks.length < 5) return [];

  const candidates = blocks.filter((b) => {
    const first = lines[b.start].trim();
    const bodyLines = b.end - b.start - 1;
    return first.length <= 24 && bodyLines >= 2 && !/[。！？，、；;]$/.test(first);
  });
  if (candidates.length < Math.max(4, blocks.length * 0.5)) return [];

  return candidates.map((b) => ({
    line: b.start,
    title: cleanTitle(lines[b.start]),
    level: 2 as const,
    score: 40,
  }));
}

/** 开头的目录页会被识别成一串空章节，去掉这个前缀 */
function dropLeadingToc(chapters: Chapter[]): Chapter[] {
  let end = 0;
  while (end < chapters.length && chapters[end].paragraphs.length === 0) end++;
  if (end >= 5 && end < chapters.length) return chapters.slice(end);
  return chapters;
}

export interface ChapterizeResult {
  chapters: Chapter[];
  warnings: string[];
}

export function chaptersFromLines(lines: string[], opts: ParagraphOptions & { rules?: CompiledRules | null }): ChapterizeResult {
  const warnings: string[] = [];
  const paragraphOptions: ParagraphOptions = { filterAds: opts.filterAds, drop: opts.rules?.drop };
  const detected = stripTocPrefix(detectHeadings(lines, opts.rules));
  let headings = pruneHeadings(detected.headings);
  if (!headings.length) headings = fallbackByBlankLines(lines);

  if (!headings.length) {
    const paragraphs = buildParagraphs(lines, paragraphOptions);
    warnings.push('没有识别到章节标题，整本书会导出为单章。');
    return {
      chapters: [{ id: 'ch-1', title: '正文', level: 2, paragraphs }],
      warnings,
    };
  }

  const chapters: Chapter[] = [];
  let index = 0;

  const frontStart = Math.max(0, detected.dropUntil + 1);
  const frontEnd = (headings[0].bodyStart ?? headings[0].line + 1) - 1;
  const front = buildParagraphs(lines.slice(frontStart, Math.max(frontStart, frontEnd)), paragraphOptions);
  if (front.length) {
    const head = front.slice(0, 6).join('');
    const title = /内容简介|作品简介|图书简介|文案/.test(head) ? '内容简介' : '前言';
    chapters.push({ id: `ch-${++index}`, title, level: 2, paragraphs: front, frontMatter: true });
  }

  headings.forEach((h, i) => {
    const bodyStart = h.bodyStart ?? h.line + 1;
    const bodyEnd = i + 1 < headings.length ? (headings[i + 1].bodyStart ?? headings[i + 1].line + 1) - 1 : lines.length;
    const body = buildParagraphs(lines.slice(bodyStart, Math.max(bodyStart, bodyEnd)), paragraphOptions);
    chapters.push({ id: `ch-${++index}`, title: h.title || '未命名', level: h.level, paragraphs: body });
  });

  const cleaned = dropLeadingToc(chapters);
  if (!cleaned.length) {
    return {
      chapters: [{ id: 'ch-1', title: '正文', level: 2, paragraphs: buildParagraphs(lines, paragraphOptions) }],
      warnings: ['章节内容为空，已整本导出为单章。'],
    };
  }

  if (cleaned.length > 2000) warnings.push('章节数量超过 2000，校对列表会比较长。');
  return { chapters: cleaned, warnings };
}

export function chaptersFromText(
  text: string,
  opts: ParagraphOptions & { rules?: CompiledRules | null },
): ChapterizeResult {
  return chaptersFromLines(text.split('\n'), opts);
}

/** 从卷首信息里猜书名，例如「『书名/作者:xxx』」或「《书名》」 */
export function guessTitleFromText(sample: string): string {
  const withAuthor = sample.match(/[『「《]([^』」》/\n]{1,40})[』」》]?\s*(?:[/|｜]\s*)?作\s*者/);
  if (withAuthor) return withAuthor[1].trim();
  const book = sample.match(/《([^》\n]{1,40})》/);
  return book ? book[1].trim() : '';
}

/** 知轩藏书等格式：`《书名》（校对版全本）作者：远瞳.txt` */
const FILENAME_AUTHOR_RE = /《([^》]{1,60})》[^《》]{0,40}?作\s*者\s*[:：]\s*([^\s/|,，、;；]{1,20})/;

export interface FilenameInfo {
  title: string;
  author: string;
}

/** 从文件名解析书名和作者，解析不出来时把整串当书名 */
export function parseFilenameInfo(filename: string): FilenameInfo {
  const base = filename.replace(/\.[^.]+$/, '').trim();
  const matched = base.match(FILENAME_AUTHOR_RE);
  if (matched) return { title: matched[1].trim() || '未命名', author: matched[2].trim() };

  let title = base;
  const book = base.match(/^《([^》]+)》/);
  if (book) title = book[1];
  title = title
    .replace(/[（(【\[]\s*(?:精校|全本|完结|校对|下载|txt|TXT|无删减|整理)[^）)】\]]*\s*[）)】\]]/g, '')
    .replace(/\s*作\s*者\s*[:：].*$/, '')
    .trim();
  return { title: title || '未命名', author: '' };
}

/** 从文件名猜书名 */
export function guessTitle(filename: string): string {
  return parseFilenameInfo(filename).title;
}

export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}


/** 从卷首信息里猜作者，例如「/作者:风与天幕」 */
export function guessAuthor(sample: string): string {
  const match = sample.match(/(?:作\s*者|著\s*者)\s*[:：]\s*([^\s/|,，、』」》<>]{1,20})/);
  return match ? match[1].trim() : '';
}

export interface HeadingCandidate {
  chapterIndex: number;
  chapterId: string;
  chapterTitle: string;
  paragraphIndex: number;
  text: string;
}

const HEAD_START = new RegExp(`^第\\s*[${CN_NUM}\\d]{1,8}\\s*[章节回卷部篇集]`);
const SPECIAL_START = /^(?:序章|楔子|引子|番外|后记|尾声|终章|大结局)/;

/**
 * 找出正文里「看起来像章节标题、但没被识别成标题」的段落。
 * 用于诊断面板：识别漏了以后，用户可以一键把它设为标题。
 */
export function findHeadingCandidates(
  chapters: Chapter[],
  rules?: CompiledRules | null,
): HeadingCandidate[] {
  const out: HeadingCandidate[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      const text = paragraph.trim();
      if (!text || text.length > 50) return;
      // 长句以句号结尾，多半是正文
      if (text.length > 24 && /[。！？!?…]$/.test(text)) return;
      // 「第9章讲的是……」这种句子不是标题；标题在章号后通常有分隔符
      if (/[。！？!?]$/.test(text) && !/[章节回卷部篇集][\s、.．:：·\-—]/.test(text)) return;
      const looksLikeHeading =
        HEAD_START.test(text) ||
        SPECIAL_START.test(text) ||
        ((INLINE_JUNK.test(text) || Boolean(rules?.inlineJunk?.test(text))) &&
          new RegExp(`第\\s*[${CN_NUM}\\d]{1,8}\\s*[章节]`).test(text));
      if (!looksLikeHeading) return;
      if (text === chapter.title.trim()) return;
      out.push({
        chapterIndex,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        paragraphIndex,
        text,
      });
    });
  });
  return out;
}
