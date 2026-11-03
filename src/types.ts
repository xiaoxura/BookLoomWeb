export interface Chapter {
  id: string;
  title: string;
  /** 1 = 卷/部, 2 = 章/节 */
  level: 1 | 2;
  paragraphs: string[];
  frontMatter?: boolean;
}

export interface BookMeta {
  title: string;
  author: string;
  language: string;
}

export interface LayoutOptions {
  /** 1.3 - 2.4 */
  lineHeight: number;
  indent: boolean;
  /** 段间距，单位 em */
  paragraphSpacing: number;
  font: 'serif' | 'sans' | 'kai';
  justify: boolean;
}

export interface ParseOptions {
  /** 'auto' 或 TextDecoder 支持的编码名 */
  encoding: string;
  filterAds: boolean;
  /** 站点/自定义识别规则 */
  rules?: import('./core/rules').RuleSpec | null;
}

export interface ParseResult {
  encoding: string;
  confidence: number;
  /** 非空白字符数 */
  chars: number;
  chapters: Chapter[];
  warnings: string[];
  titleGuess: string;
  authorGuess: string;
}

export interface CoverData {
  data: Uint8Array;
  mime: string;
}
