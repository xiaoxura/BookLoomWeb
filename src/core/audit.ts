import type { Chapter } from '../types';
import { isAdLine } from './text';

export type AuditIssueKind =
  | 'missing-number'
  | 'duplicate-number'
  | 'empty-chapter'
  | 'duplicate-title'
  | 'too-long'
  | 'too-short'
  | 'empty-volume'
  | 'ad-leftover';

export interface AuditIssue {
  kind: AuditIssueKind;
  chapterIndex: number;
  chapterId: string;
  chapterTitle: string;
  /** 广告残留等按段落定位时存在 */
  paragraphIndex?: number;
  message: string;
}

export interface AuditReport {
  issues: AuditIssue[];
  counts: Record<AuditIssueKind, number>;
  total: number;
}

export interface AuditIssueMeta {
  label: string;
  hint: string;
}

export const AUDIT_ISSUE_META: Record<AuditIssueKind, AuditIssueMeta> = {
  'missing-number': { label: '章号缺号', hint: '章号跳跃，可能是漏识别或原书缺章' },
  'duplicate-number': { label: '章号重复', hint: '同一卷里出现相同章号' },
  'empty-chapter': { label: '空章节', hint: '章节没有任何正文' },
  'duplicate-title': { label: '标题重复', hint: '多个章节标题完全相同' },
  'too-long': { label: '异常长章', hint: '单章字数远超常见章节' },
  'too-short': { label: '异常短章', hint: '单章字数明显偏少，可能漏并了正文' },
  'empty-volume': { label: '卷内无章', hint: '卷标题下没有任何章节' },
  'ad-leftover': { label: '广告残留', hint: '正文里仍有站点水印或广告行' },
};

export const AUDIT_ISSUE_ORDER: AuditIssueKind[] = [
  'missing-number',
  'duplicate-number',
  'empty-chapter',
  'duplicate-title',
  'too-long',
  'too-short',
  'empty-volume',
  'ad-leftover',
];

/** 单章超过这个字数算异常长 */
export const AUDIT_LONG_CHARS = 30000;
/** 单章少于这个字数算异常短（空章节单独报告） */
export const AUDIT_SHORT_CHARS = 120;
const AUDIT_MAX_ISSUES_PER_KIND = 20;
const AUDIT_MAX_PARAGRAPH_INDEX = 20;

const CN_NUM_CHARS = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟';
const NUM = `[${CN_NUM_CHARS}\\d]{1,8}`;
/** 合并章节的区间写法：第1045~1046章（分隔符含 ~ ～ - — － 至 到） */
const NUM_RANGE = `(?:\\s*[~～\\-—－至到]\\s*${NUM})?`;
const NUMBERED_TITLE_RE = new RegExp(`^(\\s*第\\s*)(${NUM})(${NUM_RANGE}\\s*[章节回话])`);
const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
};
const CN_UNITS: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
  万: 10000,
  亿: 100000000,
};

export interface ParsedChapterNumber {
  value: number;
  style: 'cn' | 'arabic';
  raw: string;
  /** 区间章号（第1045~1046章）时为区间末端；普通章号与 value 相同解析不出时不存在 */
  end?: number;
}

/** 解析「第 X 章」里的中文或阿拉伯数字；不是章号标题时返回 null */
export function parseChapterNumber(title: string): ParsedChapterNumber | null {
  const match = NUMBERED_TITLE_RE.exec(title);
  if (!match) return null;
  const raw = match[2];
  const value = /^\d+$/.test(raw) ? Number(raw) : parseChineseNumber(raw);
  if (value === null || !Number.isFinite(value)) return null;
  const result: ParsedChapterNumber = {
    value,
    style: /^\d+$/.test(raw) ? 'arabic' : 'cn',
    raw,
  };
  const range = /([~～\-—－至到])\s*([^\s]{1,8})\s*[章节回话]/.exec(match[3]);
  if (range) {
    const similar = /^\d+$/.test(range[2]) ? 'arabic' : result.style === 'arabic' ? 'arabic' : 'cn';
    const end = /^\d+$/.test(range[2]) ? Number(range[2]) : parseChineseNumber(range[2]);
    if (end !== null && Number.isFinite(end) && end >= value && similar === result.style) {
      result.end = end;
    }
  }
  return result;
}

/** 「一百零五」→ 105，「十二」→ 12 */
export function parseChineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!raw) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  let saw = false;
  for (const char of raw) {
    if (char in CN_DIGITS) {
      number = CN_DIGITS[char];
      saw = true;
      continue;
    }
    const unit = CN_UNITS[char];
    if (unit === undefined) return null;
    saw = true;
    if (unit < 10000) {
      if (number === 0) number = 1;
      section += number * unit;
    } else {
      section = (section + number) * unit;
      total += section;
      section = 0;
    }
    number = 0;
  }
  return saw ? total + section + number : null;
}

const OUTPUT_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const OUTPUT_UNITS = ['', '十', '百', '千'];

/** 105 → 「一百零五」；超过 9999 的章号直接退回阿拉伯数字 */
export function numberToChinese(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return String(value);
  if (value === 0) return '零';
  if (value > 9999) return String(value);
  let out = '';
  let pendingZero = false;
  for (let unit = 3; unit >= 0; unit -= 1) {
    const digit = Math.floor(value / 10 ** unit) % 10;
    if (digit === 0) {
      if (out) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += '零';
      pendingZero = false;
    }
    out += OUTPUT_DIGITS[digit] + OUTPUT_UNITS[unit];
  }
  if (out.startsWith('一十')) out = out.slice(1);
  return out || '零';
}

function replaceChapterNumber(title: string, numeral: string): string {
  return title.replace(
    NUMBERED_TITLE_RE,
    (_full, prefix: string, _old: string, suffix: string) => `${prefix}${numeral}${suffix}`,
  );
}

interface NumberedEntry {
  chapterIndex: number;
  chapter: Chapter;
  parsed: ParsedChapterNumber;
}

interface NumberingSegment {
  volume: Chapter | null;
  entries: NumberedEntry[];
}

function numberedSegments(chapters: Chapter[]): NumberingSegment[] {
  const segments: NumberingSegment[] = [];
  let volume: Chapter | null = null;
  let entries: NumberedEntry[] = [];

  const flush = () => {
    if (entries.length) segments.push({ volume, entries });
    entries = [];
  };

  chapters.forEach((chapter, chapterIndex) => {
    if (chapter.level === 1) {
      flush();
      volume = chapter;
      return;
    }
    const parsed = parseChapterNumber(chapter.title);
    if (parsed) entries.push({ chapterIndex, chapter, parsed });
  });
  flush();
  return segments;
}

function segmentHint(segment: NumberingSegment): string {
  return segment.volume ? `「${segment.volume.title}」内` : '';
}

export function auditChapters(chapters: Chapter[]): AuditReport {
  const issues: AuditIssue[] = [];
  const counts = Object.fromEntries(AUDIT_ISSUE_ORDER.map((kind) => [kind, 0])) as Record<
    AuditIssueKind,
    number
  >;
  const emitted = Object.fromEntries(AUDIT_ISSUE_ORDER.map((kind) => [kind, 0])) as Record<
    AuditIssueKind,
    number
  >;

  const add = (
    kind: AuditIssueKind,
    chapter: Chapter,
    chapterIndex: number,
    message: string,
    paragraphIndex?: number,
  ) => {
    counts[kind] += 1;
    if (emitted[kind] >= AUDIT_MAX_ISSUES_PER_KIND) return;
    emitted[kind] += 1;
    issues.push({
      kind,
      chapterIndex,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      paragraphIndex,
      message,
    });
  };

  // 章号缺号 / 重复：按卷分段，避免「每卷从第 1 章重新编号」被误报
  for (const segment of numberedSegments(chapters)) {
    const hint = segmentHint(segment);
    const firstByValue = new Map<number, NumberedEntry>();
    const occurrences = new Map<number, number>();
    for (const entry of segment.entries) {
      const value = entry.parsed.value;
      occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
      if (!firstByValue.has(value)) firstByValue.set(value, entry);
    }

    for (const entry of segment.entries) {
      const count = occurrences.get(entry.parsed.value) ?? 0;
      if (count <= 1) continue;
      if (firstByValue.get(entry.parsed.value) === entry) continue;
      add(
        'duplicate-number',
        entry.chapter,
        entry.chapterIndex,
        `${hint}章号重复：第 ${entry.parsed.value} 章`,
      );
    }

    const values = [...firstByValue.keys()].sort((a, b) => a - b);
    // 记录上一个章号（含区间）覆盖到哪里，区间标题（第1045~1046章）不算缺号；
    // 首章之前的「缺号」不报（很多书以第 2 章起步，前面是序章）
    let previousEnd: number | null = null;
    for (const start of values) {
      const entry = firstByValue.get(start);
      if (!entry) continue;
      const spanEnd = entry.parsed.end ?? entry.parsed.value;
      if (previousEnd === null) {
        previousEnd = spanEnd;
        continue;
      }
      if (start > previousEnd + 1) {
        const gap = start - previousEnd - 1;
        const shown: number[] = [];
        for (let n = previousEnd + 1; n < start && shown.length < 6; n += 1) shown.push(n);
        const missing = shown.join('、');
        add(
          'missing-number',
          entry.chapter,
          entry.chapterIndex,
          `${hint}章号不连续：缺少第 ${missing} 章${gap > shown.length ? ` 等 ${gap} 个章号` : ''}`,
        );
      }
      previousEnd = Math.max(previousEnd, spanEnd);
    }
  }

  chapters.forEach((chapter, chapterIndex) => {
    const bodyLength = chapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
    const numbered = chapter.level === 2 ? parseChapterNumber(chapter.title) : null;
    if (chapter.level === 2 && !chapter.paragraphs.some((paragraph) => paragraph.trim())) {
      add('empty-chapter', chapter, chapterIndex, `空章节：「${chapter.title}」没有正文`);
    }
    // 长短异常只看参与编号的正文章节，避免把前言、番外、单章兜底误报
    if (numbered && chapter.paragraphs.length) {
      if (bodyLength > AUDIT_LONG_CHARS) {
        add(
          'too-long',
          chapter,
          chapterIndex,
          `异常长章：「${chapter.title}」有 ${bodyLength.toLocaleString('zh-CN')} 字，建议检查是否漏分章`,
        );
      } else if (bodyLength < AUDIT_SHORT_CHARS) {
        add(
          'too-short',
          chapter,
          chapterIndex,
          `异常短章：「${chapter.title}」只有 ${bodyLength} 字`,
        );
      }
    }

    const adParagraph = chapter.paragraphs.findIndex((paragraph) => isAdLine(paragraph));
    if (adParagraph >= 0 && adParagraph < AUDIT_MAX_PARAGRAPH_INDEX) {
      const text = chapter.paragraphs[adParagraph].trim();
      add(
        'ad-leftover',
        chapter,
        chapterIndex,
        `疑似广告残留：${text.length > 32 ? `${text.slice(0, 32)}…` : text}`,
        adParagraph,
      );
    }

    if (chapter.level === 1) {
      // 只有两级：下一项是章才算有内容，下一项是卷或结尾都算空卷
      const next = chapters[chapterIndex + 1];
      const hasChild = Boolean(next && next.level === 2);
      if (!hasChild) {
        add('empty-volume', chapter, chapterIndex, `卷内无章：「${chapter.title}」下面没有章节`);
      }
    }
  });

  // 标题重复：每个重复标题只报一次，挂在第二次出现的位置
  const titleFirst = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  chapters.forEach((chapter, chapterIndex) => {
    const key = chapter.title.trim().replace(/\s+/g, ' ');
    if (!key) return;
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    if (!titleFirst.has(key)) titleFirst.set(key, chapterIndex);
  });
  const reportedTitles = new Set<string>();
  chapters.forEach((chapter, chapterIndex) => {
    const key = chapter.title.trim().replace(/\s+/g, ' ');
    if (!key) return;
    const count = titleCounts.get(key) ?? 0;
    const firstIndex = titleFirst.get(key) ?? 0;
    if (count <= 1 || reportedTitles.has(key) || firstIndex === chapterIndex) return;
    reportedTitles.add(key);
    add(
      'duplicate-title',
      chapter,
      chapterIndex,
      `标题重复：「${chapter.title}」出现 ${count} 次（首次在第 ${firstIndex + 1} 章）`,
    );
  });

  const total = AUDIT_ISSUE_ORDER.reduce((sum, kind) => sum + counts[kind], 0);
  return { issues, counts, total };
}

export interface RenumberChange {
  chapterIndex: number;
  chapterId: string;
  from: number;
  to: number;
}

export interface RenumberResult {
  chapters: Chapter[];
  changes: RenumberChange[];
}

/**
 * 按顺序重编号：保留每章原来的数字风格（中文 / 阿拉伯），只改「第 X 章」里的数字。
 * 卷与卷之间原本重新从第 1 章开始的书，保持每卷重新开始；连续编号的书保持连续。
 */
export function renumberChapters(chapters: Chapter[]): RenumberResult {
  const segments = numberedSegments(chapters);
  let restartPerVolume = false;
  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1].entries;
    const current = segments[i].entries;
    const previousLast = previous[previous.length - 1]?.parsed.value;
    const first = current[0]?.parsed.value;
    if (previousLast !== undefined && first !== undefined && first <= previousLast) {
      restartPerVolume = true;
      break;
    }
  }

  const changes: RenumberChange[] = [];
  const next = chapters.slice();
  let global = 0;

  for (const segment of segments) {
    let local = 0;
    for (const entry of segment.entries) {
      // 区间标题（第1045~1046章）代表一段合并章，重编号数字有歧义，跳过不参与
      if (entry.parsed.end !== undefined && entry.parsed.end > entry.parsed.value) continue;
      global += 1;
      local += 1;
      const to = restartPerVolume ? local : global;
      if (to === entry.parsed.value) continue;
      const numeral = entry.parsed.style === 'cn' ? numberToChinese(to) : String(to);
      const title = replaceChapterNumber(entry.chapter.title, numeral);
      if (title === entry.chapter.title) continue;
      next[entry.chapterIndex] = { ...entry.chapter, title };
      changes.push({
        chapterIndex: entry.chapterIndex,
        chapterId: entry.chapter.id,
        from: entry.parsed.value,
        to,
      });
    }
  }

  return { chapters: changes.length ? next : chapters, changes };
}
