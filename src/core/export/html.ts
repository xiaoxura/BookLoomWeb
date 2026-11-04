import type { BookMeta, Chapter, LayoutOptions } from '../../types';
import { escapeXml } from './epub';

export interface HtmlInput {
  chapters: Chapter[];
  meta: BookMeta;
  layout: LayoutOptions;
}

const FONT_STACK: Record<LayoutOptions['font'], string> = {
  serif: `"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`,
  sans: `"PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
  kai: `"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif`,
};

function splitChapterNumber(title: string): [string, string] | null {
  const matched = title.match(/^(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回话])\s*(\S.*)$/);
  if (!matched) return null;
  return [matched[1], matched[2]];
}

function chapterHeading(chapter: Chapter, separate?: boolean): string {
  const title = escapeXml(chapter.title.trim() || '未命名');
  const tag = chapter.level === 1 ? 'h1' : 'h2';
  if (separate && chapter.level === 2) {
    const split = splitChapterNumber(chapter.title.trim());
    if (split) {
      return `<${tag} class="chapter-title"><span class="chapter-number">${escapeXml(split[0])}</span>${escapeXml(split[1])}</${tag}>`;
    }
  }
  return `<${tag} class="${chapter.level === 1 ? 'volume-title' : 'chapter-title'}">${title}</${tag}>`;
}

function styles(layout: LayoutOptions): string {
  return `
:root { color-scheme: light; }
html { background: #f2ede3; }
body {
  margin: 0 auto;
  padding: 40px 24px 80px;
  max-width: 46em;
  background: #fbf8f1;
  color: #2c2923;
  font-family: ${FONT_STACK[layout.font] ?? FONT_STACK.serif};
  font-size: 17px;
  line-height: ${layout.lineHeight};
  text-align: ${layout.justify ? 'justify' : 'left'};
}
header.book { text-align: center; margin: 0 0 36px; }
header.book h1 { font-size: 2em; margin: 0 0 8px; letter-spacing: 0.06em; }
header.book p { margin: 0; color: #6f675b; font-size: 0.92em; }
nav.toc { margin: 0 0 42px; padding: 16px 20px; border: 1px solid #d9cfbd; border-radius: 8px; background: #f6f0e4; }
nav.toc h2 { font-size: 1em; letter-spacing: 0.18em; margin: 0 0 10px; color: #6f675b; }
nav.toc ol { margin: 0; padding-left: 1.4em; }
nav.toc li { margin: 4px 0; }
nav.toc li.toc-volume { font-weight: 700; margin-top: 12px; }
nav.toc li.toc-volume > ol { margin: 4px 0 6px; }
nav.toc a { color: #5a4a2f; text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
section.chapter { margin: 0 0 2.2em; }
h1.volume-title { font-size: 1.65em; text-align: center; margin: 2em 0 1em; letter-spacing: 0.08em; }
h2.chapter-title { font-size: 1.3em; text-align: center; margin: 1.8em 0 1.1em; letter-spacing: 0.04em; }
h2.chapter-title .chapter-number { display: block; margin-bottom: 0.25em; }
p { margin: 0 0 ${layout.paragraphSpacing}em; text-indent: ${layout.indent ? '2em' : '0'}; }
footer.book { margin-top: 56px; padding-top: 16px; border-top: 1px solid #d9cfbd; color: #8a8173; font-size: 0.82em; text-align: center; }
@media print {
  html, body { background: #fff; }
  body { max-width: none; padding: 0; }
  nav.toc { break-after: page; }
}
`.trim();
}

/** 生成单文件 HTML：样式内联、目录可跳转、不依赖任何外部资源 */
export function buildHtml(input: HtmlInput): string {
  const { chapters, meta, layout } = input;
  const title = meta.title.trim() || '未命名';
  const author = meta.author.trim();
  const language = meta.language || 'zh-CN';

  let toc = '';
  let volumeOpen = false;
  chapters.forEach((chapter, index) => {
    const link = `<a href="#c-${index + 1}">${escapeXml(chapter.title.trim() || '未命名')}</a>`;
    if (chapter.level === 1) {
      if (volumeOpen) toc += '</ol></li>';
      toc += `<li class="toc-volume">${link}<ol>`;
      volumeOpen = true;
      return;
    }
    toc += `<li class="toc-chapter">${link}</li>`;
  });
  if (volumeOpen) toc += '</ol></li>';

  const body = chapters
    .map((chapter, index) => {
      const heading = chapterHeading(chapter, layout.separateChapterNumber);
      const paragraphs = chapter.paragraphs
        .filter((paragraph) => paragraph.trim())
        .map((paragraph) => `<p>${escapeXml(paragraph)}</p>`)
        .join('');
      return `<section class="chapter" id="c-${index + 1}">${heading}${paragraphs}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${escapeXml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="txt2book">
<title>${escapeXml(title)}</title>
<style>
${styles(layout)}
</style>
</head>
<body>
<header class="book"><h1>${escapeXml(title)}</h1>${author ? `<p>${escapeXml(author)}</p>` : ''}</header>
<nav class="toc" aria-label="目录"><h2>目录</h2><ol>${toc}</ol></nav>
<main>
${body}
</main>
<footer class="book">由 txt2book 生成</footer>
</body>
</html>
`;
}
