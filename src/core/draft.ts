import type { BookMeta, Chapter, CoverData, LayoutOptions, ParseResult } from '../types';
import type { RuleSpec } from './rules';

const DB_NAME = 'txt2book';
const DB_VERSION = 1;
const STORE = 'drafts';
const KEY = 'current';
const SOURCE_KEY = 'source';

export interface DraftData {
  version: 1 | 2;
  savedAt: number;
  filename: string;
  meta: BookMeta;
  chapters: Chapter[];
  layout: LayoutOptions;
  cover: CoverData | null;
  coverAuto: boolean;
  activeId: string | null;
  options: { encoding: string; filterAds: boolean };
  /** 不重复保存 chapters，避免草稿体积翻倍 */
  parse: Omit<ParseResult, 'chapters'> & { chapters?: Chapter[] };
  rules?: RuleSpec | null;
  rulePreset?: string;
  /** 与原始 TXT 记录关联的 id；老草稿没有这个字段，恢复时视为原文不可用 */
  sourceId?: string;
}

export interface SourceRecord {
  id: string;
  name: string;
  data: ArrayBuffer;
}

/** 草稿和原文是否属于同一次导入，防止恢复后「重新识别」读到上一本书 */
export function sourceMatchesDraft(draft: DraftData | null, source: SourceRecord | null): boolean {
  if (!draft?.sourceId || !source?.id) return false;
  return draft.sourceId === source.id;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('当前浏览器不支持本地草稿'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
  });
}

/**
 * 在单个事务里执行操作，并在 transaction.oncomplete 后才算成功。
 * 不能只等 request.onsuccess：后续写入失败时事务仍可能回滚。
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
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
      transaction = db.transaction(STORE, mode);
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : new Error('无法开始本地数据库事务'));
      return;
    }

    transaction.oncomplete = complete;
    transaction.onerror = () => fail(transaction.error ?? new Error('本地数据库事务失败'));
    transaction.onabort = () => fail(transaction.error ?? new Error('本地数据库事务已中断'));

    try {
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        // 让事务统一走 abort/error，避免 request 和 transaction 双重 reject
      };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* 事务可能已经结束 */
      }
      fail(error);
    }
  });
}

/**
 * 保存草稿；传入 source 时，草稿和原文在同一个事务里写入。
 * 任一写入失败都会整体回滚，避免「新草稿 + 旧原文」的错配。
 */
export async function saveDraft(draft: DraftData, source?: SourceRecord | null): Promise<void> {
  if (source && (!draft.sourceId || source.id !== draft.sourceId)) {
    throw new Error('草稿与原始文件关联不一致，已取消保存');
  }
  await withStore('readwrite', (store) => {
    const request = store.put(draft, KEY);
    if (source) store.put(source, SOURCE_KEY);
    return request;
  });
}

export async function loadDraft(): Promise<DraftData | null> {
  const draft = await withStore<DraftData | undefined>('readonly', (store) => store.get(KEY));
  if (!draft || (draft.version !== 1 && draft.version !== 2)) return null;
  if (!Array.isArray(draft.chapters) || !draft.chapters.length) return null;
  return draft;
}

export async function loadSource(): Promise<SourceRecord | null> {
  const source = await withStore<SourceRecord | undefined>('readonly', (store) => store.get(SOURCE_KEY));
  if (!source || !source.data || typeof source.id !== 'string') return null;
  return source;
}

export async function clearSource(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(SOURCE_KEY));
}

/** 清空草稿和原文，两个 key 在同一个事务里删除 */
export async function clearDraft(): Promise<void> {
  await withStore('readwrite', (store) => {
    store.delete(KEY);
    return store.delete(SOURCE_KEY);
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
