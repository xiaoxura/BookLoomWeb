import { countChars, guessTitle } from '../chapters';
import type { ParseResult } from '../../types';
import { importEpub, type EpubBook } from './epub';
import { importDocx } from './docx';

export type SourceFormat = 'txt' | 'epub' | 'docx';

/** EPUB 是 zip，开头固定是 PK\x03\x04 */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * 按扩展名判断格式；没有扩展名时用魔数兜底。
 * 认不出来的一律当 TXT 走原来的解码流程，让用户自己看到乱码再换编码。
 */
function containsAscii(bytes: Uint8Array, needle: string): boolean {
  if (!needle) return false;
  const target = Uint8Array.from(needle, (char) => char.charCodeAt(0));
  outer: for (let start = 0; start <= bytes.length - target.length; start += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (bytes[start + offset] !== target[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/** 没有扩展名的 zip：zip 中央目录里会明文保存文件名，用它区分 DOCX / EPUB */
function looksLikeDocxZip(bytes: Uint8Array): boolean {
  return containsAscii(bytes, 'word/document.xml');
}

export function detectFormat(filename: string, bytes: Uint8Array): SourceFormat {
  if (/\.docx$/i.test(filename)) return 'docx';
  if (/\.epub$/i.test(filename)) return 'epub';
  if (/\.txt$/i.test(filename)) return 'txt';
  if (!looksLikeZip(bytes)) return 'txt';
  return looksLikeDocxZip(bytes) ? 'docx' : 'epub';
}

export function importDocxFile(bytes: Uint8Array, filename: string): ParseResult {
  return importDocx(bytes, filename);
}

export function importEpubFile(bytes: Uint8Array, filename: string): ParseResult {
  const book = importEpub(bytes);
  const result = toParseResult(book, filename);
  return result;
}

export function toParseResult(book: EpubBook, filename: string): ParseResult {
  const chars = book.chapters.reduce(
    (sum, chapter) => sum + chapter.paragraphs.reduce((n, p) => n + countChars(p), 0),
    0,
  );

  return {
    sourceType: 'epub',
    // EPUB 正文按规范是 UTF-8，这个字段只用来让编码选择器显示一个合理的值
    encoding: 'utf-8',
    confidence: 1,
    chars,
    chapters: book.chapters,
    warnings: book.warnings,
    titleGuess: book.title.trim() || guessTitle(filename),
    authorGuess: book.author.trim(),
    cover: book.cover,
    language: book.language || 'zh-CN',
    metaGuess: {
      ...(book.description ? { description: book.description } : {}),
      ...(book.series ? { series: book.series } : {}),
      ...(book.publisher ? { publisher: book.publisher } : {}),
      ...(book.tags.length ? { tags: book.tags } : {}),
      ...(book.publishedAt ? { publishedAt: book.publishedAt } : {}),
    },
  };
}
