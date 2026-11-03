import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  loadDraft,
  loadSource,
  saveDraft,
  sourceMatchesDraft,
  type DraftData,
  type SourceRecord,
} from '../src/core/draft';

function makeDraft(sourceId: string | undefined, title = '测试'): DraftData {
  return {
    version: 2,
    savedAt: 1,
    filename: 'a.txt',
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

describe('草稿存储事务', () => {
  beforeEach(async () => {
    await clearDraft();
  });

  it('草稿和原文在同一个事务里写入后都能读到', async () => {
    const draft = makeDraft('src-1', '旧书');
    await saveDraft(draft, makeSource('src-1'));

    const loadedDraft = await loadDraft();
    const loadedSource = await loadSource();
    expect(loadedDraft?.sourceId).toBe('src-1');
    expect(loadedSource?.id).toBe('src-1');
    expect(sourceMatchesDraft(loadedDraft, loadedSource)).toBe(true);
  });

  it('原文写入失败时整个事务回滚，旧草稿和旧原文仍然成对', async () => {
    await saveDraft(makeDraft('src-old', '旧书'), makeSource('src-old'));

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (key === 'source') throw new DOMException('模拟写入失败', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    } as typeof IDBObjectStore.prototype.put;

    try {
      await expect(saveDraft(makeDraft('src-new', '新书'), makeSource('src-new'))).rejects.toThrow(
        '模拟写入失败',
      );
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    const draft = await loadDraft();
    const source = await loadSource();
    expect(draft?.meta.title).toBe('旧书');
    expect(draft?.sourceId).toBe('src-old');
    expect(source?.id).toBe('src-old');
    expect(sourceMatchesDraft(draft, source)).toBe(true);
  });

  it('清除草稿会同时删除原文', async () => {
    await saveDraft(makeDraft('src-1'), makeSource('src-1'));
    await clearDraft();
    expect(await loadDraft()).toBeNull();
    expect(await loadSource()).toBeNull();
  });

  it('关联不一致时拒绝写入，避免覆盖旧数据', async () => {
    await saveDraft(makeDraft('src-1', '旧书'), makeSource('src-1'));
    await expect(saveDraft(makeDraft('src-2', '新书'), makeSource('src-other'))).rejects.toThrow(
      '关联不一致',
    );
    expect((await loadDraft())?.meta.title).toBe('旧书');
  });
});
