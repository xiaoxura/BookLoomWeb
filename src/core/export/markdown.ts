import type { BookMeta, Chapter } from '../../types';

/**
 * 把章节写成 Markdown。
 * 书名用 `#`；有卷时卷用 `##`、章用 `###`；没有卷时章直接用 `##`。
 */
export function buildMarkdown(chapters: Chapter[], meta: BookMeta): string {
  const hasVolume = chapters.some((chapter) => chapter.level === 1 && !chapter.frontMatter);
  const lines: string[] = [];

  const title = meta.title.trim() || '未命名';
  lines.push(`# ${title}`, '');
  if (meta.author.trim()) lines.push(`> 作者：${meta.author.trim()}`, '');

  for (const chapter of chapters) {
    const paragraphs = chapter.paragraphs.map((p) => p.trim()).filter(Boolean);
    if (!chapter.frontMatter) {
      const hashes = chapter.level === 1 || !hasVolume ? '##' : '###';
      lines.push(`${hashes} ${chapter.title.trim()}`, '');
    }
    if (paragraphs.length) lines.push(paragraphs.join('\n\n'), '');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
