import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  deleteBook,
  estimateStorage,
  listBooks,
  loadBook,
  loadBookFont,
  renameBook,
  saveBookDraft,
  saveBookFont,
  saveBookSource,
  sourceMatchesDraft,
  type DraftData,
  type SourceRecord,
} from '../src/core/draft';

function makeDraft(bookId: string, sourceId: string | undefined, title = '测试', savedAt = 1): DraftData {
  return {
    version: 3,
    bookId,
    savedAt,
    filename: `${title}.txt`,
    meta: { title, author: '', language: 'zh-CN' },
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
      titleGuess: title,
      authorGuess: '',
    },
    sourceId,
  };
}

function makeSource(id: string): SourceRecord {
  return { id, name: 'a.txt', data: new Uint8Array([1, 2, 3]).buffer };
}

function rawGet(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bookloom', 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('drafts', 'readonly');
      const request = transaction.objectStore('drafts').get(key);
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

describe('草稿与书架存储', () => {
  beforeEach(async () => {
    await clearLibrary();
  });

  it('草稿、原文和书架条目在同一个事务里写入后都能读到', async () => {
    const draft = makeDraft('book-1', 'src-1', '旧书');
    await saveBookDraft(draft, makeSource('src-1'), { coverThumb: 'data:image/jpeg;base64,x' });

    const books = await listBooks();
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      id: 'book-1',
      title: '旧书',
      chapterCount: 1,
      words: 2,
      coverThumb: 'data:image/jpeg;base64,x',
      hasSource: true,
    });

    const loaded = await loadBook('book-1');
    expect(loaded?.draft.meta.title).toBe('旧书');
    expect(loaded?.source?.id).toBe('src-1');
    expect(sourceMatchesDraft(loaded?.draft ?? null, loaded?.source ?? null)).toBe(true);
  });

  it('多本书各自保存与恢复，互不覆盖', async () => {
    await saveBookDraft(makeDraft('book-a', 'src-a', '甲', 100), makeSource('src-a'));
    await saveBookDraft(makeDraft('book-b', 'src-b', '乙', 200), makeSource('src-b'));

    let books = await listBooks();
    expect(books.map((book) => book.title)).toEqual(['乙', '甲']);

    const a = await loadBook('book-a');
    const b = await loadBook('book-b');
    expect(a?.draft.meta.title).toBe('甲');
    expect(b?.draft.meta.title).toBe('乙');
    expect(a?.source?.id).toBe('src-a');
    expect(b?.source?.id).toBe('src-b');

    // 修改甲并更新保存时间后，书架排序跟着变化
    await saveBookDraft(makeDraft('book-a', 'src-a', '甲改', 300), makeSource('src-a'));
    books = await listBooks();
    expect(books.map((book) => book.title)).toEqual(['甲改', '乙']);
    expect((await loadBook('book-a'))?.draft.meta.title).toBe('甲改');
    expect((await loadBook('book-b'))?.draft.meta.title).toBe('乙');
  });

  it('重命名只改书架和草稿元数据，不动章节', async () => {
    await saveBookDraft(makeDraft('book-a', 'src-a', '原名'), makeSource('src-a'));
    await renameBook('book-a', '新名');
    const loaded = await loadBook('book-a');
    expect(loaded?.book.title).toBe('新名');
    expect(loaded?.draft.meta.title).toBe('新名');
    expect(loaded?.draft.chapters[0].title).toBe('第一章');
  });

  it('删除一本书不影响其他书，原文和字体一并清理', async () => {
    await saveBookDraft(makeDraft('book-a', 'src-a', '甲'), makeSource('src-a'));
    await saveBookDraft(makeDraft('book-b', 'src-b', '乙'), makeSource('src-b'));
    await saveBookFont('book-a', { name: 'a.ttf', mime: 'font/ttf', data: new Uint8Array([1]) });

    await deleteBook('book-a');
    const books = await listBooks();
    expect(books.map((book) => book.id)).toEqual(['book-b']);
    expect(await loadBook('book-a')).toBeNull();
    expect(await loadBookFont('book-a')).toBeNull();
    expect((await loadBook('book-b'))?.draft.meta.title).toBe('乙');
    expect(await rawGet('source:book-a')).toBeUndefined();
    expect((await rawGet('source:book-b') as SourceRecord | undefined)?.id).toBe('src-b');
  });

  it('只补原文不会覆盖或创建草稿', async () => {
    await saveBookDraft(makeDraft('book-a', undefined, '甲'), undefined, { coverThumb: 'thumb' });
    await saveBookSource({ ...makeSource('book-a'), name: 'a.txt' });
    const loaded = await loadBook('book-a');
    expect(loaded?.source?.id).toBe('book-a');
    expect(loaded?.book.hasSource).toBe(true);
    expect(loaded?.book.coverThumb).toBe('thumb');

    await saveBookSource({ ...makeSource('missing-book'), name: 'x.txt' });
    expect(await rawGet('source:missing-book')).toBeUndefined();
    expect((await listBooks()).map((book) => book.id)).toEqual(['book-a']);
  });

  it('字体按书分开存取，删书时一并清理', async () => {
    await saveBookDraft(makeDraft('book-a', 'src-a', '甲'), makeSource('src-a'));
    await saveBookDraft(makeDraft('book-b', 'src-b', '乙'), makeSource('src-b'));
    await saveBookFont('book-a', { name: 'f.ttf', mime: 'font/ttf', data: new Uint8Array([1, 2, 3]) });

    const fontA = await loadBookFont('book-a');
    expect(fontA?.name).toBe('f.ttf');
    expect(Array.from(fontA?.data ?? [])).toEqual([1, 2, 3]);
    expect(await loadBookFont('book-b')).toBeNull();

    await deleteBook('book-a');
    expect(await loadBookFont('book-a')).toBeNull();
  });

  it('原文写入失败时整个事务回滚，书架和旧草稿都不变', async () => {
    await saveBookDraft(makeDraft('book-old', 'src-old', '旧书'), makeSource('src-old'));

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (typeof key === 'string' && key.startsWith('source:')) {
        throw new DOMException('模拟写入失败', 'QuotaExceededError');
      }
      return originalPut.call(this, value, key);
    } as typeof IDBObjectStore.prototype.put;

    try {
      await expect(
        saveBookDraft(makeDraft('book-new', 'src-new', '新书'), makeSource('src-new')),
      ).rejects.toThrow('模拟写入失败');
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    const books = await listBooks();
    expect(books.map((book) => book.id)).toEqual(['book-old']);
    const old = await loadBook('book-old');
    expect(old?.draft.meta.title).toBe('旧书');
    expect(old?.source?.id).toBe('src-old');
    expect(await loadBook('book-new')).toBeNull();
  });

  it('关联不一致时拒绝写入，避免覆盖旧数据', async () => {
    await saveBookDraft(makeDraft('book-a', 'src-1', '旧书'), makeSource('src-1'));
    await expect(
      saveBookDraft(makeDraft('book-b', 'src-2', '新书'), makeSource('src-other')),
    ).rejects.toThrow('关联不一致');
    expect((await loadBook('book-a'))?.draft.meta.title).toBe('旧书');
    expect(await loadBook('book-b')).toBeNull();
  });

  it('没有书架 id 时拒绝保存', async () => {
    const draft = makeDraft('book-a', undefined);
    delete draft.bookId;
    await expect(saveBookDraft(draft)).rejects.toThrow('书架 id');
  });

  it('容量信息在缺少 Storage API 时返回 null', async () => {
    // Node 测试环境没有 navigator.storage
    expect(await estimateStorage()).toBeNull();
  });
});
