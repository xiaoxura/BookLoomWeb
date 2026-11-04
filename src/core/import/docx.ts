import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import type { Chapter, ParseResult } from '../../types';
import { countChars, guessTitle, tidyTitleSpacing } from '../chapters';

/** preserveOrder 模式下，属性统一放在 `:@` 里 */
type XmlAttrs = Record<string, string>;
type XmlNode = { [key: string]: XmlNode[] | XmlAttrs | string | undefined };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  removeNSPrefix: true,
});

const coreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  removeNSPrefix: true,
});

const HEADING_STYLE_RE = /^(?:heading|标题|標題)([1-9])$/;
const NUMBER_STYLE_RE = /^([1-9])$/;

function parseXml(text: string): XmlNode[] {
  try {
    const parsed: unknown = parser.parse(text);
    return Array.isArray(parsed) ? (parsed as XmlNode[]) : [];
  } catch {
    return [];
  }
}

function entriesOf(node: XmlNode): Array<[string, XmlNode[] | XmlAttrs | string | undefined]> {
  return Object.entries(node).filter(([key]) => key !== ':@' && key !== '#text');
}

function childrenOf(node: XmlNode | null, tag: string): XmlNode[] {
  if (!node) return [];
  const value = node[tag];
  return Array.isArray(value) ? value : [];
}

function childNode(nodes: XmlNode[], tag: string): XmlNode | null {
  return nodes.find((node) => tag in node) ?? null;
}

function attrOf(node: XmlNode | null, name: string): string | null {
  if (!node) return null;
  const attrs = node[':@'];
  if (!attrs || Array.isArray(attrs) || typeof attrs !== 'object') return null;
  const value = (attrs as XmlAttrs)[`@_${name}`];
  return typeof value === 'string' ? value : null;
}

function findFirstNode(nodes: XmlNode[], tag: string): XmlNode | null {
  for (const node of nodes) {
    if (tag in node) return node;
    for (const [, value] of entriesOf(node)) {
      if (!Array.isArray(value)) continue;
      const found = findFirstNode(value, tag);
      if (found) return found;
    }
  }
  return null;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textValue).join('');
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim();
  }
  return '';
}

function normalizeStyle(style: string | null): string {
  return style ? style.replace(/\s+/g, '').toLowerCase() : '';
}

/** 按 Heading 1-9 / 中文「标题 1」/ 大纲级别推断标题层级；不是标题返回 null */
export function headingLevelOf(style: string | null, outlineLevel: number | null): number | null {
  const normalized = normalizeStyle(style);
  const matched = HEADING_STYLE_RE.exec(normalized) ?? NUMBER_STYLE_RE.exec(normalized);
  if (matched) return Number(matched[1]);
  if (outlineLevel !== null) return Math.min(6, Math.max(1, outlineLevel + 1));
  return null;
}

interface ParagraphInfo {
  text: string;
  level: number | null;
  hasImage: boolean;
}

function collectRunText(nodes: XmlNode[], parts: string[], state: { hasImage: boolean }): void {
  for (const node of nodes) {
    for (const [tag, value] of entriesOf(node)) {
      if (!Array.isArray(value)) continue;
      if (tag === 't') {
        for (const child of value) {
          const text = child['#text'];
          if (typeof text === 'string') parts.push(text);
        }
        continue;
      }
      if (tag === 'tab') {
        parts.push(' ');
        continue;
      }
      if (tag === 'br' || tag === 'cr') {
        parts.push('\n');
        continue;
      }
      if (tag === 'drawing' || tag === 'pict' || tag === 'object') {
        state.hasImage = true;
        continue;
      }
      if (tag === 'pPr' || tag === 'rPr' || tag === 'instrText' || tag === 'delText') continue;
      collectRunText(value, parts, state);
    }
  }
}

function paragraphInfo(paragraph: XmlNode[]): ParagraphInfo {
  let style: string | null = null;
  let outlineLevel: number | null = null;
  const pPr = childNode(paragraph, 'pPr');
  if (pPr) {
    const pPrChildren = childrenOf(pPr, 'pPr');
    const styleNode = childNode(pPrChildren, 'pStyle');
    style = attrOf(styleNode, 'val');
    const outlineNode = childNode(pPrChildren, 'outlineLvl');
    const rawOutline = attrOf(outlineNode, 'val');
    if (rawOutline !== null && /^\d$/.test(rawOutline)) outlineLevel = Number(rawOutline);
  }

  const parts: string[] = [];
  const state = { hasImage: false };
  collectRunText(paragraph, parts, state);
  const text = parts
    .join('')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return { text, level: headingLevelOf(style, outlineLevel), hasImage: state.hasImage };
}

interface RawContent {
  paragraphs: Array<{ text: string; level: number | null }>;
  hasImage: boolean;
  hasTable: boolean;
}

function collectParagraphs(nodes: XmlNode[], content: RawContent): void {
  for (const node of nodes) {
    for (const [tag, value] of entriesOf(node)) {
      if (!Array.isArray(value)) continue;
      if (tag === 'tbl') {
        content.hasTable = true;
        continue;
      }
      if (tag === 'p') {
        const info = paragraphInfo(value);
        if (info.hasImage) content.hasImage = true;
        if (info.text) {
          for (const line of info.text.split('\n')) {
            content.paragraphs.push({ text: line, level: info.level });
          }
        }
        continue;
      }
      collectParagraphs(value, content);
    }
  }
}

function findZipEntry(files: Record<string, Uint8Array>, target: string): Uint8Array | null {
  if (files[target]) return files[target];
  const lower = target.toLowerCase();
  for (const [name, data] of Object.entries(files)) {
    if (name.toLowerCase() === lower) return data;
  }
  return null;
}

function readCoreProperties(files: Record<string, Uint8Array>): {
  title: string;
  author: string;
  language: string;
} {
  const raw = findZipEntry(files, 'docProps/core.xml');
  if (!raw) return { title: '', author: '', language: '' };
  try {
    const parsed = coreParser.parse(strFromU8(raw)) as Record<string, unknown>;
    const properties = parsed.coreProperties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      return { title: '', author: '', language: '' };
    }
    const values = properties as Record<string, unknown>;
    return {
      title: textValue(values.title),
      author: textValue(values.creator),
      language: textValue(values.language),
    };
  } catch {
    return { title: '', author: '', language: '' };
  }
}

function frontTitle(paragraphs: string[]): string {
  const head = paragraphs.slice(0, 6).join('');
  return /内容简介|作品简介|图书简介|文案/.test(head) ? '内容简介' : '前言';
}

export function importDocx(bytes: Uint8Array, filename: string): ParseResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('DOCX 解析失败：文件可能已加密或损坏');
  }

  const documentBytes = findZipEntry(files, 'word/document.xml');
  if (!documentBytes) {
    throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  }

  const parsed = parseXml(strFromU8(documentBytes));
  const body = findFirstNode(parsed, 'body');
  if (!body) {
    throw new Error('DOCX 解析失败：找不到正文内容');
  }

  const content: RawContent = { paragraphs: [], hasImage: false, hasTable: false };
  collectParagraphs(childrenOf(body, 'body'), content);

  const warnings: string[] = [];
  if (!content.paragraphs.length) {
    warnings.push('DOCX 里没有提取到正文。');
  }

  const headings = content.paragraphs
    .map((paragraph, index) => ({ ...paragraph, index }))
    .filter((paragraph) => paragraph.level !== null);
  const headingLevels = new Set(headings.map((heading) => heading.level as number));
  const hasVolumeLevel = headingLevels.has(1) && [...headingLevels].some((level) => level >= 2);
  const targetLevel = (level: number): 1 | 2 => (hasVolumeLevel && level === 1 ? 1 : 2);

  const chapters: Chapter[] = [];
  let index = 0;
  const pushChapter = (title: string, level: 1 | 2, paragraphs: string[], frontMatter = false) => {
    chapters.push({
      id: `ch-${++index}`,
      title,
      level,
      paragraphs,
      ...(frontMatter ? { frontMatter: true } : {}),
    });
  };

  if (!headings.length) {
    pushChapter('正文', 2, content.paragraphs.map((paragraph) => paragraph.text));
    warnings.push('没有找到标题样式，整本作为单章导入；可以在校对区手动分章。');
  } else {
    const firstHeadingIndex = headings[0].index;
    const front = content.paragraphs
      .slice(0, firstHeadingIndex)
      .map((paragraph) => paragraph.text);
    if (front.length) pushChapter(frontTitle(front), 2, front, true);

    headings.forEach((heading, position) => {
      const next = headings[position + 1];
      const end = next ? next.index : content.paragraphs.length;
      const paragraphs = content.paragraphs
        .slice(heading.index + 1, end)
        .map((paragraph) => paragraph.text);
      pushChapter(tidyTitleSpacing(heading.text), targetLevel(heading.level as number), paragraphs);
    });
  }

  if (!chapters.length) pushChapter('正文', 2, []);

  const core = readCoreProperties(files);
  if (content.hasImage) warnings.push('DOCX 里的图片暂不导入，正文只保留文字。');
  if (content.hasTable) warnings.push('DOCX 里的表格内容未导入。');

  const chars = chapters.reduce(
    (sum, chapter) => sum + chapter.paragraphs.reduce((n, paragraph) => n + countChars(paragraph), 0),
    0,
  );

  return {
    sourceType: 'docx',
    encoding: 'utf-8',
    confidence: 1,
    chars,
    chapters,
    warnings,
    titleGuess: core.title || guessTitle(filename),
    authorGuess: core.author,
    cover: null,
    language: core.language || 'zh-CN',
  };
}
