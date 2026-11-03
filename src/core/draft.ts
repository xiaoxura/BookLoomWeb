import type { BookMeta, Chapter, CoverData, LayoutOptions, ParseResult } from '../types';
import type { RuleSpec } from './rules';

const DB_NAME = 'txt2book';
const DB_VERSION = 1;
const STORE = 'drafts';
const KEY = 'current';

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
}

export interface SourceRecord {
  name: string;
  data: ArrayBuffer;
}

const SOURCE_KEY = 'source';

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

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveDraft(draft: DraftData): Promise<void> {
  await withStore('readwrite', (store) => store.put(draft, KEY));
}

export async function loadDraft(): Promise<DraftData | null> {
  const draft = await withStore<DraftData | undefined>('readonly', (store) => store.get(KEY));
  if (!draft || (draft.version !== 1 && draft.version !== 2)) return null;
  if (!Array.isArray(draft.chapters) || !draft.chapters.length) return null;
  return draft;
}

export async function saveSource(source: SourceRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(source, SOURCE_KEY));
}

export async function loadSource(): Promise<SourceRecord | null> {
  const source = await withStore<SourceRecord | undefined>('readonly', (store) => store.get(SOURCE_KEY));
  return source && source.data ? source : null;
}

export async function clearSource(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(SOURCE_KEY));
}

export async function clearDraft(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY));
  await withStore('readwrite', (store) => store.delete(SOURCE_KEY));
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
