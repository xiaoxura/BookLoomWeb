import type { ParseResult, Chapter, BookMeta, ConvertMode, CoverData, FontData, LayoutOptions } from '../types';
import type { HeadingCandidate } from '../core/chapters';
import type { RuleSpec } from '../core/rules';
import { auditChapters, type AuditReport } from '../core/audit';
import { DEFAULT_COVER_OPTIONS, normalizeCoverOptions } from '../core/cover';

export const DEFAULT_LAYOUT: LayoutOptions = {
  lineHeight: 1.75,
  indent: true,
  paragraphSpacing: 0,
  font: 'serif',
  justify: true,
  separateChapterNumber: false,
  customCss: '',
  coverStyle: 'vertical',
  coverOptions: DEFAULT_COVER_OPTIONS,
};

const LAYOUT_KEY = 'bookloom.layout.v1';
const EPUB_VERSION_KEY = 'bookloom.epubVersion';
const EXPORT_FORMAT_KEY = 'bookloom.exportFormat';
const LIST_PAGE_SIZE_KEY = 'bookloom.listPageSize';
const THEME_KEY = 'bookloom.theme';
const LAST_BOOK_KEY = 'bookloom.lastBook.v1';

export type ThemeMode = 'light' | 'dark';
export type MobileView = 'chapters' | 'preview';
export type ExportFormat = 'epub' | 'txt' | 'md' | 'docx' | 'html';

export const EXPORT_FORMATS: ExportFormat[] = ['epub', 'docx', 'html', 'txt', 'md'];
export const EXPORT_LABEL: Record<ExportFormat, string> = {
  epub: '导出 EPUB',
  txt: '导出 TXT',
  md: '导出 Markdown',
  docx: '导出 DOCX',
  html: '导出 HTML',
};

export function loadExportFormat(): ExportFormat {
  try {
    const raw = localStorage.getItem(EXPORT_FORMAT_KEY);
    return raw === 'txt' || raw === 'md' || raw === 'docx' || raw === 'html' ? raw : 'epub';
  } catch {
    return 'epub';
  }
}

export function saveExportFormat(format: ExportFormat): void {
  try {
    localStorage.setItem(EXPORT_FORMAT_KEY, format);
  } catch {
    /* 隐私模式下可能写入失败 */
  }
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 隐私模式下可能读取失败 */
  }
  return document.documentElement.dataset.theme === 'dark' || darkQuery.matches ? 'dark' : 'light';
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 忽略存储失败 */
  }
}

export interface BatchItem {
  file: File;
  title: string;
  status: 'waiting' | 'parsing' | 'packing' | 'done' | 'error';
  chapters?: number;
  message?: string;
  data?: Uint8Array;
  /** 批量导出的文件后缀，缺省是 epub */
  ext?: string;
}

export interface State {
  parsed: ParseResult | null;
  chapters: Chapter[];
  activeId: string | null;
  meta: BookMeta;
  layout: LayoutOptions;
  cover: CoverData | null;
  coverAuto: boolean;
  font: FontData | null;
  coverUrl: string | null;
  busy: boolean;
  /** 导入 / 重新识别时应用的繁简转换 */
  convert: ConvertMode;
  filter: string;
  selectedParagraph: number | null;
  diagnostics: HeadingCandidate[];
  audit: AuditReport;
  idSeed: number;
  filename: string;
  rules: RuleSpec | null;
  rulePreset: string;
  epubVersion: 2 | 3;
  exportFormat: ExportFormat;
  batchItems: BatchItem[];
  batchRunning: boolean;
  batchCancelled: boolean;
  sourceReady: boolean;
  /** 当前草稿关联的原始 TXT id，旧草稿为 null */
  sourceId: string | null;
  /** 当前书在书架里的 id；未导入 / 已删除时为 null */
  bookId: string | null;
  /** 书架卡片的封面缩略图（data URL） */
  coverThumb: string | null;
  /** 目录渲染窗口的起始下标：长书只渲染可见区，切章超出时整体挪动窗口 */
  listWindowStart: number;
  /** 批量移动模式：开启后点击列表选中的章节 id 集 */
  multiSelect: string[];
  /** 是否处于批量移动模式（未选中任何项时也显示操作条） */
  multiMode: boolean;
  /** 目录每页章数（分页条可调 100 / 200 / 400 / 800） */
  listPageSize: number;
  /** 正文编辑态：当前正在编辑段落（新增段落也是空文本编辑） */
  editingParagraph: { chapterId: string; paragraphIndex: number } | null;
}

export function loadLayout(): LayoutOptions {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutOptions>;
      return {
        ...DEFAULT_LAYOUT,
        ...parsed,
        coverOptions: normalizeCoverOptions(parsed.coverOptions),
      };
    }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return { ...DEFAULT_LAYOUT };
}

export function saveLayout(layout: LayoutOptions): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* 隐私模式下可能写入失败 */
  }
}

export function loadEpubVersion(): 2 | 3 {
  try {
    return localStorage.getItem(EPUB_VERSION_KEY) === '2' ? 2 : 3;
  } catch {
    return 3;
  }
}

export function saveEpubVersion(version: 2 | 3): void {
  try {
    localStorage.setItem(EPUB_VERSION_KEY, String(version));
  } catch {
    /* 忽略存储失败 */
  }
}

export function loadListPageSize(): number {
  try {
    const raw = Number(localStorage.getItem(LIST_PAGE_SIZE_KEY));
    return [100, 200, 400, 800].includes(raw) ? raw : 400;
  } catch {
    return 400;
  }
}

export function saveListPageSize(size: number): void {
  try {
    localStorage.setItem(LIST_PAGE_SIZE_KEY, String(size));
  } catch {
    /* 隐私模式下可能写入失败 */
  }
}

export function loadLastBookId(): string | null {
  try {
    return localStorage.getItem(LAST_BOOK_KEY);
  } catch {
    return null;
  }
}

export function saveLastBookId(bookId: string | null): void {
  try {
    if (bookId) localStorage.setItem(LAST_BOOK_KEY, bookId);
    else localStorage.removeItem(LAST_BOOK_KEY);
  } catch {
    /* 隐私模式下可能写入失败 */
  }
}

export function createInitialState(): State {
  return {
    parsed: null,
    chapters: [],
    activeId: null,
    meta: { title: '', author: '', language: 'zh-CN' },
    layout: loadLayout(),
    cover: null,
    coverAuto: true,
    font: null,
    coverUrl: null,
    busy: false,
    convert: 'none',
    filter: '',
    selectedParagraph: null,
    diagnostics: [],
    audit: auditChapters([]),
    idSeed: 0,
    filename: '',
    rules: null,
    rulePreset: 'auto',
    epubVersion: loadEpubVersion(),
    exportFormat: loadExportFormat(),
    batchItems: [],
    batchRunning: false,
    batchCancelled: false,
    sourceReady: false,
    sourceId: null,
    bookId: null,
    coverThumb: null,
    listWindowStart: 0,
    multiSelect: [],
    multiMode: false,
    listPageSize: loadListPageSize(),
    editingParagraph: null,
  };
}
