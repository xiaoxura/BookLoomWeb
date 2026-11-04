import { strToU8, zipSync, type Zippable } from 'fflate';
import type { BookMeta, Chapter, LayoutOptions } from '../../types';
import { escapeXml } from './epub';

export interface DocxInput {
  chapters: Chapter[];
  meta: BookMeta;
  layout: LayoutOptions;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const FONT_NAMES: Record<LayoutOptions['font'], { eastAsia: string; latin: string }> = {
  serif: { eastAsia: '宋体', latin: 'Times New Roman' },
  sans: { eastAsia: '黑体', latin: 'Arial' },
  kai: { eastAsia: '楷体', latin: 'Times New Roman' },
};

/** 「第1章 标题」拆成序号和标题，用于「章号单独一行」 */
function splitChapterNumber(title: string): [string, string] | null {
  const matched = title.match(/^(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回话])\s*(\S.*)$/);
  if (!matched) return null;
  return [matched[1], matched[2]];
}

function headingParagraph(title: string, style: string, separate?: boolean): string {
  const split = separate ? splitChapterNumber(title) : null;
  if (!split) return paragraph(title, style);
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(split[0])}</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">${escapeXml(split[1])}</w:t></w:r></w:p>`;
}

function paragraph(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function stylesXml(layout: LayoutOptions, language: string): string {
  const font = FONT_NAMES[layout.font] ?? FONT_NAMES.serif;
  const line = Math.round(layout.lineHeight * 240);
  const after = Math.round(layout.paragraphSpacing * 240);
  const indent = layout.indent ? '<w:ind w:firstLine="480"/>' : '<w:ind w:firstLine="0"/>';
  const justify = layout.justify ? 'both' : 'left';
  const fontXml = `<w:rFonts w:ascii="${font.latin}" w:hAnsi="${font.latin}" w:eastAsia="${font.eastAsia}"/>`;
  const langXml = `<w:lang w:val="${escapeXml(language || 'zh-CN')}" w:eastAsia="${escapeXml(language || 'zh-CN')}"/>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>${fontXml}<w:sz w:val="24"/><w:szCs w:val="24"/>${langXml}</w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="${line}" w:lineRule="auto" w:after="${after}"/><w:jc w:val="${justify}"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr>${indent}<w:spacing w:line="${line}" w:lineRule="auto" w:after="${after}"/><w:jc w:val="${justify}"/></w:pPr>
    <w:rPr>${fontXml}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>
    <w:rPr>${fontXml}<w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Author">
    <w:name w:val="Author"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
    <w:rPr>${fontXml}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:spacing w:before="480" w:after="240"/></w:pPr>
    <w:rPr>${fontXml}<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:spacing w:before="360" w:after="180"/></w:pPr>
    <w:rPr>${fontXml}<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
</w:styles>
`;
}

function documentXml(input: DocxInput): string {
  const { chapters, meta } = input;
  const title = meta.title.trim() || '未命名';
  const body: string[] = [];

  body.push(paragraph(title, 'Title'));
  if (meta.author.trim()) body.push(paragraph(`作者：${meta.author.trim()}`, 'Author'));

  for (const chapter of chapters) {
    const headingStyle = chapter.level === 1 ? 'Heading1' : 'Heading2';
    body.push(
      headingParagraph(
        chapter.title.trim() || '未命名',
        headingStyle,
        input.layout.separateChapterNumber,
      ),
    );
    for (const text of chapter.paragraphs) {
      if (!text.trim()) continue;
      body.push(paragraph(text));
    }
  }

  body.push(
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join('')}</w:body></w:document>
`;
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
`;
}

function packageRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL_NS}">
  <Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
`;
}

function documentRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL_NS}">
  <Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>
</Relationships>
`;
}

function coreXml(meta: BookMeta): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${escapeXml(meta.title.trim() || '未命名')}</dc:title>
  <dc:creator>${escapeXml(meta.author.trim())}</dc:creator>
  <dc:language>${escapeXml(meta.language || 'zh-CN')}</dc:language>
</cp:coreProperties>
`;
}

/** 生成最小可用的 WordprocessingML DOCX；标题使用 Heading 1 / 2 样式，Word 导航可见 */
export function buildDocx(input: DocxInput): Uint8Array {
  const language = input.meta.language || 'zh-CN';
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(packageRelsXml()),
    'docProps/core.xml': strToU8(coreXml(input.meta)),
    'word/document.xml': strToU8(documentXml(input)),
    'word/styles.xml': strToU8(stylesXml(input.layout, language)),
    'word/_rels/document.xml.rels': strToU8(documentRelsXml()),
  };
  return zipSync(files, { level: 6 });
}
