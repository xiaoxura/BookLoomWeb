import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { DraftData } from '../src/core/draft';

function legacyDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    version: 2,
    savedAt: 100,
    filename: '旧书.txt',
    meta: { title: '旧书', author: '作者', language: 'zh-CN' },
    chapters: [{ id: 'ch-1', title: '第一章', level: 2, paragraphs: ['正文'] }],
    layout: { lineHeight: 1.75, indent: true, paragraphSpacing: 0, font: 'serif', justify: true },
    cover: null,
    coverAuto: true,
    activeId: 'ch-1',
    options: { encoding: 'auto', filterAds: true },
    parse: {
      encoding: 'utf-8',
      confidence: 1,
      chars: 2,
      warnings: [],
      titleGuess: '旧书',
      authorGuess: '',
    },
    sourceId: 'legacy-src',
    ...overrides,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('txt2book');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function seedLegacy(draft: unknown, source: unknown | null, font: unknown | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('txt2book', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('drafts');
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      store.put(draft, 'current');
      if (source) store.put(source, 'source');
      if (font) store.put(font, 'font');
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

function readLegacyKeys(): Promise<{ current: unknown; source: unknown; font: unknown }> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('txt2book', 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('drafts', 'readonly');
      const store = transaction.objectStore('drafts');
      const current = store.get('current');
      const source = store.get('source');
      const font = store.get('font');
      transaction.oncomplete = () => {
        db.close();
        resolve({ current: current.result, source: source.result, font: font.result });
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

describe('旧草稿迁移', () => {
  it('把 current / source / font 原子迁移成一本带原文和字体的书', async () => {
    await deleteDatabase();
    await seedLegacy(legacyDraft(), { id: 'legacy-src', name: '旧书.txt', data: new ArrayBuffer(4) }, {
      name: 'f.ttf',
      mime: 'font/ttf',
      data: new Uint8Array([9, 9]),
    });

    vi.resetModules();
    const api = await import('../src/core/draft');
    const books = await api.listBooks();
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      id: 'legacy-src',
      title: '旧书',
      author: '作者',
      chapterCount: 1,
      hasSource: true,
    });

    const loaded = await api.loadBook('legacy-src');
    expect(loaded?.draft.version).toBe(3);
    expect(loaded?.draft.bookId).toBe('legacy-src');
    expect(loaded?.source?.id).toBe('legacy-src');
    expect(loaded?.font?.name).toBe('f.ttf');
    expect(api.sourceMatchesDraft(loaded?.draft ?? null, loaded?.source ?? null)).toBe(true);

    const legacy = await readLegacyKeys();
    expect(legacy.current).toBeUndefined();
    expect(legacy.source).toBeUndefined();
    expect(legacy.font).toBeUndefined();
  });

  it('没有原文的老草稿也能迁移，并生成新的书 id', async () => {
    await deleteDatabase();
    const draft = legacyDraft({ sourceId: undefined });
    await seedLegacy(draft, null, null);

    vi.resetModules();
    const api = await import('../src/core/draft');
    const books = await api.listBooks();
    expect(books).toHaveLength(1);
    expect(books[0].id).toMatch(/^(book-|[0-9a-f-]{36})/);
    expect(books[0].hasSource).toBe(false);
    const loaded = await api.loadBook(books[0].id);
    expect(loaded?.source).toBeNull();
    expect(loaded?.draft.meta.title).toBe('旧书');
  });

  it('原文与草稿关联不一致时不迁移原文，但草稿仍可用', async () => {
    await deleteDatabase();
    await seedLegacy(legacyDraft(), { id: 'other-src', name: 'x.txt', data: new ArrayBuffer(2) }, null);

    vi.resetModules();
    const api = await import('../src/core/draft');
    const books = await api.listBooks();
    expect(books).toHaveLength(1);
    expect(books[0].hasSource).toBe(false);
    const loaded = await api.loadBook(books[0].id);
    expect(loaded?.source).toBeNull();
    expect(loaded?.draft.meta.title).toBe('旧书');
  });

  it('旧数据损坏时保留原记录并报错，不删除用户数据', async () => {
    await deleteDatabase();
    await seedLegacy({ version: 2, chapters: [] }, null, null);

    vi.resetModules();
    const api = await import('../src/core/draft');
    await expect(api.listBooks()).rejects.toThrow('无法识别');
    const legacy = await readLegacyKeys();
    expect(legacy.current).toBeTruthy();
  });
});
