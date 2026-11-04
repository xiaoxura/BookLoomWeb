import type { Chapter, ConvertMode, ParseResult } from '../types';

export type TextConverter = (text: string) => string;

const identity: TextConverter = (text) => text;

let cache: Partial<Record<ConvertMode, Promise<TextConverter>>> = {};

/**
 * 按需加载 opencc-js 的对应方向词典：
 * - 转繁体：cn2t（约 1.1MB 的词典 chunk）
 * - 转简体：t2cn（约 100KB 的词典 chunk）
 * 只有用户选择转换且确实需要时才会拉取，首屏不受影响。
 */
export async function loadConverter(mode: ConvertMode): Promise<TextConverter> {
  if (mode === 'none') return identity;
  if (!cache[mode]) {
    const pending = (async () => {
      if (mode === 'traditional') {
        const OpenCC = await import('opencc-js/cn2t');
        return OpenCC.Converter({ from: 'cn', to: 'tw' }) as TextConverter;
      }
      const OpenCC = await import('opencc-js/t2cn');
      return OpenCC.Converter({ from: 't', to: 'cn' }) as TextConverter;
    })();
    cache[mode] = pending.catch((error: unknown) => {
      delete cache[mode];
      throw error;
    });
  }
  return cache[mode];
}

/** 标题和正文都转换；章节结构、层级和 frontMatter 原样保留 */
export function convertChapters(chapters: Chapter[], convert: TextConverter): Chapter[] {
  return chapters.map((chapter) => ({
    ...chapter,
    title: convert(chapter.title),
    paragraphs: chapter.paragraphs.map(convert),
  }));
}

/** 章节 + 从原文猜出的书名 / 作者一起转换，警告和封面等元数据不变 */
export function convertParseResult(result: ParseResult, convert: TextConverter): ParseResult {
  return {
    ...result,
    chapters: convertChapters(result.chapters, convert),
    titleGuess: convert(result.titleGuess),
    authorGuess: convert(result.authorGuess),
  };
}

/** 测试或切换方向时清掉缓存（下一次重新加载词典） */
export function resetConverterCache(): void {
  cache = {};
}
