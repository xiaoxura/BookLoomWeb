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
  /** 书籍简介，写入 EPUB 的 dc:description */
  description?: string;
  /** 连载状态（连载中 / 已完结）；从卷首信息自动识别 */
  status?: string;
  /** 系列名，EPUB 3 用 belongs-to-collection 输出 */
  series?: string;
  publisher?: string;
  /** 标签，每个写一条 dc:subject */
  tags?: string[];
  /** 出版日期，YYYY-MM-DD */
  publishedAt?: string;
}

export type CoverPalette = 'auto' | 'sand' | 'ink' | 'sea' | 'wine' | 'forest';
export type CoverAuthorPosition = 'bottom' | 'top' | 'hidden';

export interface CoverOptions {
  /** auto 跟随模板默认：竖排用米色纸，色块用书名哈希色 */
  palette: CoverPalette;
  /** 标题字号倍率，0.8 - 1.3 */
  titleScale: number;
  authorPosition: CoverAuthorPosition;
}

export interface LayoutOptions {
  /** 1.3 - 2.4 */
  lineHeight: number;
  indent: boolean;
  /** 段间距，单位 em */
  paragraphSpacing: number;
  font: 'serif' | 'sans' | 'kai';
  justify: boolean;
  /** 章号单独一行显示（「第1章」一行，标题另一行） */
  separateChapterNumber?: boolean;
  /** 追加到 EPUB 样式表末尾的自定义 CSS */
  customCss?: string;
  /** 自动封面的风格 */
  coverStyle?: 'vertical' | 'block';
  /** 自动封面的配色 / 字号 / 作者位置 */
  coverOptions?: CoverOptions;
}

/** 用户上传、要嵌进 EPUB 的字体 */
export interface FontData {
  name: string;
  data: Uint8Array;
  mime: string;
}

export interface ParseOptions {
  /** 'auto' 或 TextDecoder 支持的编码名 */
  encoding: string;
  filterAds: boolean;
  /** 站点/自定义识别规则 */
  rules?: import('./core/rules').RuleSpec | null;
  /** 导入时对书名 / 章节标题 / 正文做繁简转换 */
  convert?: ConvertMode;
}

export type SourceType = 'txt' | 'epub' | 'docx';

/** 导入时的繁简转换方向 */
export type ConvertMode = 'none' | 'simplified' | 'traditional';

export interface BookMetaGuess {
  description?: string;
  series?: string;
  publisher?: string;
  tags?: string[];
  publishedAt?: string;
}

export interface ParseResult {
  /** 源文件是 TXT 还是 EPUB；老草稿没有这个字段，按 TXT 处理 */
  sourceType?: SourceType;
  encoding: string;
  confidence: number;
  /** 非空白字符数 */
  chars: number;
  chapters: Chapter[];
  warnings: string[];
  titleGuess: string;
  authorGuess: string;
  /** 从 EPUB 里带出来的封面 */
  cover?: CoverData | null;
  language?: string;
  /** EPUB 里的扩展元数据，导入后可继续编辑 */
  metaGuess?: BookMetaGuess;
}

export interface CoverData {
  data: Uint8Array;
  mime: string;
}
