import { describe, expect, it } from 'vitest';
import { sourceMatchesDraft, type DraftData, type SourceRecord } from '../src/core/draft';

function draft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    version: 2,
    savedAt: 0,
    filename: 'a.txt',
    meta: { title: '测试', author: '', language: 'zh-CN' },
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
      titleGuess: '测试',
      authorGuess: '',
    },
    ...overrides,
  };
}

function source(id: string): SourceRecord {
  return { id, name: 'a.txt', data: new ArrayBuffer(0) };
}

describe('草稿与原文关联', () => {
  it('只有 sourceId 完全一致才算匹配', () => {
    expect(sourceMatchesDraft(draft({ sourceId: 'src-1' }), source('src-1'))).toBe(true);
  });

  it('换书或原文保存失败时不能误用旧原文', () => {
    expect(sourceMatchesDraft(draft({ sourceId: 'src-2' }), source('src-1'))).toBe(false);
  });

  it('老草稿没有 sourceId、原文没有 id 时不信任原文', () => {
    expect(sourceMatchesDraft(draft(), source('src-1'))).toBe(false);
    expect(sourceMatchesDraft(draft({ sourceId: 'src-1' }), null)).toBe(false);
    expect(sourceMatchesDraft(null, source('src-1'))).toBe(false);
  });
});
