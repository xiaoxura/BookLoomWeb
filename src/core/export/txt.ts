import type { Chapter } from '../../types';

/**
 * 把章节写回 TXT。
 * 章节标题单独一行，段落之间空一行，章与章之间空两行，
 * 这样再拖回本工具时能被同一套规则识别成相同的章节。
 */
export function buildTxt(chapters: Chapter[]): string {
  const blocks: string[] = [];

  for (const chapter of chapters) {
    const paragraphs = chapter.paragraphs.map((p) => p.trim()).filter(Boolean);
    const body = paragraphs.join('\n\n');

    if (chapter.frontMatter) {
      if (body) blocks.push(body);
      continue;
    }

    blocks.push(body ? `${chapter.title.trim()}\n\n${body}` : chapter.title.trim());
  }

  return blocks.length ? `${blocks.join('\n\n\n')}\n` : '';
}
