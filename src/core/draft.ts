import type { BookMeta, Chapter, ConvertMode, CoverData, FontData, LayoutOptions, ParseResult } from '../types';
import type { RuleSpec } from './rules';

const DB_NAME = 'txt2book';
const DB_VERSION = 2;
const DRAFT_STORE = 'drafts';
const BOOKS_STORE = 'books';

/** 旧版只保留一本草稿时使用的固定 key，仅用于迁移 */
const LEGACY_DRAFT_KEY = 'current';
const LEGACY_SOURCE_KEY = 'source';
const LEGACY_FONT_KEY = 'font';

const DRAFT_PREFIX = 'draft:';
const SOURCE_PREFIX = 'source:';
const FONT_PREFIX = 'font:';

export interface DraftData {
  version: 1 | 2 | 3;
  savedAt: number;
  filename: string;
  meta: BookMeta;
  chapters: Chapter[];
  layout: LayoutOptions;
  cover: CoverData | null;
  coverAuto: boolean;
  activeId: string | null;
  options: { encoding: string; filterAds: boolean; convert?: ConvertMode };
  /** 不重复保存 chapters，避免草稿体积翻倍 */
  parse: Omit<ParseResult, 'chapters'> & { chapters?: Chapter[] };
  rules?: RuleSpec | null;
  rulePreset?: string;
  /** 与原始 TXT 记录关联的 id；老草稿没有这个字段，恢复时视为原文不可用 */
  sourceId?: string;
  /** 书架里的书 id；v3 草稿必填 */
  bookId?: string;
}

export interface SourceRecord {
  id: string;
  name: string;
  data: ArrayBuffer;
}

/** 书架卡片需要的元数据；正文仍只在草稿记录里存一份 */
export interface BookRecord {
  id: string;
  title: string;
  author: string;
  updatedAt: number;
  chapterCount: number;
  words: number;
  /** 书架缩略图（data URL），没有封面时为 null */
  coverThumb: string | null;
  hasSource: boolean;
}

export interface LoadedBook {
  book: BookRecord;
  draft: DraftData;
  source: SourceRecord | null;
  font: FontData | null;
}

export interface SaveBookOptions {
  /** 更新书架缩略图；不传则沿用已有值 */
  coverThumb?: string | null;
}

/** 草稿和原文是否属于同一次导入，防止恢复后「重新识别」读到上一本书 */
export function sourceMatchesDraft(draft: DraftData | null, source: SourceRecord | null): boolean {
  if (!draft?.sourceId || !source?.id) return false;
  return draft.sourceId === source.id;
}

export function createBookId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isDraftData(value: unknown): value is DraftData {
  if (!value || typeof value !== 'object') return false;
  const draft = value as DraftData;
  if (draft.version !== 1 && draft.version !== 2 && draft.version !== 3) return false;
  return Array.isArray(draft.chapters) && draft.chapters.length > 0;
}

function countDraftWords(draft: DraftData): number {
  let total = 0;
  for (const chapter of draft.chapters) {
    for (const paragraph of chapter.paragraphs) total += paragraph.length;
  }
  return total;
}

function bookFromDraft(draft: DraftData, previous?: BookRecord, coverThumb?: string | null): BookRecord {
  return {
    id: draft.bookId as string,
    title: draft.meta.title?.trim() || draft.filename?.replace(/\.[^.]+$/, '') || '未命名',
    author: draft.meta.author?.trim() || '',
    updatedAt: draft.savedAt || Date.now(),
    chapterCount: draft.chapters.length,
    words: countDraftWords(draft),
    coverThumb: coverThumb !== undefined ? coverThumb : (previous?.coverThumb ?? null),
    hasSource: previous?.hasSource ?? false,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis) || !globalThis.indexedDB) {
      reject(new Error('当前浏览器不支持本地书架'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      reject(new Error('当前浏览器无法使用本地书架'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
  });
}

function requestOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地数据库读取失败'));
  });
}

/**
 * 在单个事务里执行操作，并在 transaction.oncomplete 后才算成功。
 * 不能只等 request.onsuccess：后续写入失败时事务仍可能回滚。
 */
async function withTransaction<T>(
  mode: IDBTransactionMode,
  stores: string[],
  run: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let result!: T;
    let settled = false;

    const complete = () => {
      if (settled) return;
      settled = true;
      db.close();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      db.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(stores, mode);
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : new Error('无法开始本地数据库事务'));
      return;
    }

    transaction.oncomplete = complete;
    transaction.onerror = () => fail(transaction.error ?? new Error('本地数据库事务失败'));
    transaction.onabort = () => fail(transaction.error ?? new Error('本地数据库事务已中断'));

    Promise.resolve()
      .then(() => run(transaction))
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        try {
          transaction.abort();
        } catch {
          /* 事务可能已经结束 */
        }
        fail(error);
      });
  });
}

/**
 * 旧版只有一本草稿：把 `current` / `source` / `font` 原子迁移成
 * 按 bookId 分键的新记录，并生成书架条目。失败时事务回滚，旧数据保留。
 */
let migrationPromise: Promise<void> | null = null;

export function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyDraft().catch((error: unknown) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

async function migrateLegacyDraft(): Promise<void> {
  const legacy = await withTransaction('readonly', [DRAFT_STORE], async (transaction) => {
    const store = transaction.objectStore(DRAFT_STORE);
    return {
      draft: await requestOf<DraftData | undefined>(store.get(LEGACY_DRAFT_KEY)),
      source: await requestOf<SourceRecord | undefined>(store.get(LEGACY_SOURCE_KEY)),
      font: await requestOf<FontData | undefined>(store.get(LEGACY_FONT_KEY)),
    };
  });
  if (!legacy.draft) return;
  if (!isDraftData(legacy.draft)) {
    // 数据坏了就保持原样，交给上层提示，不删用户数据
    throw new Error('旧草稿格式无法识别，已保留原数据');
  }

  const draft = legacy.draft;
  const bookId = draft.bookId ?? draft.sourceId ?? createBookId();
  const sourceOk =
    legacy.source && draft.sourceId && legacy.source.id === draft.sourceId ? legacy.source : null;
  draft.bookId = bookId;
  draft.version = 3;

  const book = bookFromDraft(draft);
  book.hasSource = Boolean(sourceOk);

  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    drafts.put(draft, `${DRAFT_PREFIX}${bookId}`);
    if (sourceOk) drafts.put(sourceOk, `${SOURCE_PREFIX}${bookId}`);
    if (legacy.font) drafts.put(legacy.font, `${FONT_PREFIX}${bookId}`);
    transaction.objectStore(BOOKS_STORE).put(book);
    drafts.delete(LEGACY_DRAFT_KEY);
    drafts.delete(LEGACY_SOURCE_KEY);
    drafts.delete(LEGACY_FONT_KEY);
  });
}

export async function listBooks(): Promise<BookRecord[]> {
  await ensureMigrated();
  const books = await withTransaction('readonly', [BOOKS_STORE], (transaction) =>
    requestOf<BookRecord[]>(transaction.objectStore(BOOKS_STORE).getAll()),
  );
  return books
    .filter((book) => book && typeof book.id === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadBook(bookId: string): Promise<LoadedBook | null> {
  await ensureMigrated();
  return withTransaction('readonly', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const draft = await requestOf<DraftData | undefined>(drafts.get(`${DRAFT_PREFIX}${bookId}`));
    if (!isDraftData(draft)) return null;
    const book = await requestOf<BookRecord | undefined>(
      transaction.objectStore(BOOKS_STORE).get(bookId),
    );
    if (!book) return null;
    const source = await requestOf<SourceRecord | undefined>(
      drafts.get(`${SOURCE_PREFIX}${bookId}`),
    );
    const font = await requestOf<FontData | undefined>(drafts.get(`${FONT_PREFIX}${bookId}`));
    draft.bookId = bookId;
    return {
      book,
      draft,
      source: source && source.data ? source : null,
      font: font && font.data && typeof font.name === 'string' ? font : null,
    };
  });
}

/**
 * 保存一本书：草稿、原文、书架元数据在同一事务里写入。
 * 任一写入失败都会整体回滚，避免「新草稿 + 旧原文」的错配。
 */
export async function saveBookDraft(
  draft: DraftData,
  source?: SourceRecord | null,
  options: SaveBookOptions = {},
): Promise<void> {
  if (!draft.bookId) throw new Error('草稿缺少书架 id，已取消保存');
  if (source && (!draft.sourceId || source.id !== draft.sourceId)) {
    throw new Error('草稿与原始文件关联不一致，已取消保存');
  }
  await ensureMigrated();
  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const books = transaction.objectStore(BOOKS_STORE);
    const previous = await requestOf<BookRecord | undefined>(books.get(draft.bookId as string));
    const book = bookFromDraft(draft, previous, options.coverThumb);
    if (source) book.hasSource = true;
    transaction.objectStore(DRAFT_STORE).put(draft, `${DRAFT_PREFIX}${draft.bookId}`);
    if (source) transaction.objectStore(DRAFT_STORE).put(source, `${SOURCE_PREFIX}${draft.bookId}`);
    books.put(book);
  });
}

/** 只补原文，不覆盖草稿；书已被删除时直接忽略 */
export async function saveBookSource(source: SourceRecord): Promise<void> {
  await ensureMigrated();
  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const books = transaction.objectStore(BOOKS_STORE);
    const book = await requestOf<BookRecord | undefined>(books.get(source.id));
    if (!book) return;
    transaction.objectStore(DRAFT_STORE).put(source, `${SOURCE_PREFIX}${source.id}`);
    book.hasSource = true;
    books.put(book);
  });
}

export async function renameBook(bookId: string, title: string): Promise<void> {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  await ensureMigrated();
  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const books = transaction.objectStore(BOOKS_STORE);
    const book = await requestOf<BookRecord | undefined>(books.get(bookId));
    if (!book) return;
    book.title = nextTitle;
    book.updatedAt = Date.now();
    books.put(book);

    const drafts = transaction.objectStore(DRAFT_STORE);
    const draft = await requestOf<DraftData | undefined>(drafts.get(`${DRAFT_PREFIX}${bookId}`));
    if (isDraftData(draft)) {
      draft.meta = { ...draft.meta, title: nextTitle };
      draft.bookId = bookId;
      draft.savedAt = Date.now();
      drafts.put(draft, `${DRAFT_PREFIX}${bookId}`);
    }
  });
}

export async function deleteBook(bookId: string): Promise<void> {
  await ensureMigrated();
  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], async (transaction) => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    drafts.delete(`${DRAFT_PREFIX}${bookId}`);
    drafts.delete(`${SOURCE_PREFIX}${bookId}`);
    drafts.delete(`${FONT_PREFIX}${bookId}`);
    transaction.objectStore(BOOKS_STORE).delete(bookId);
  });
}

/** 字体单独存一条，避免每次自动保存都把几 MB 的字体重写一遍 */
export async function saveBookFont(bookId: string, font: FontData | null): Promise<void> {
  await ensureMigrated();
  await withTransaction('readwrite', [DRAFT_STORE], (transaction) => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    if (!font) {
      drafts.delete(`${FONT_PREFIX}${bookId}`);
      return undefined;
    }
    drafts.put(font, `${FONT_PREFIX}${bookId}`);
    return undefined;
  });
}

export async function loadBookFont(bookId: string): Promise<FontData | null> {
  await ensureMigrated();
  const font = await withTransaction('readonly', [DRAFT_STORE], (transaction) =>
    requestOf<FontData | undefined>(
      transaction.objectStore(DRAFT_STORE).get(`${FONT_PREFIX}${bookId}`),
    ),
  );
  if (!font || !font.data || typeof font.name !== 'string') return null;
  return font;
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const estimate = await storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}

/** 测试用：清空书架、草稿、原文和字体 */
export async function clearLibrary(): Promise<void> {
  await withTransaction('readwrite', [DRAFT_STORE, BOOKS_STORE], (transaction) => {
    transaction.objectStore(DRAFT_STORE).clear();
    transaction.objectStore(BOOKS_STORE).clear();
  });
}

/** 从已恢复的章节里推出下一个可用 id，避免分章时撞号 */
export function deriveIdSeed(chapters: Chapter[]): number {
  let seed = 0;
  for (const chapter of chapters) {
    const match = /^ch-new-(\d+)$/.exec(chapter.id);
    if (match) seed = Math.max(seed, Number(match[1]));
  }
  return seed;
}
