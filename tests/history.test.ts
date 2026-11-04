import { describe, expect, it } from 'vitest';
import { EditHistory, type HistoryFrame } from '../src/core/history';

interface Book {
  chapters: string[];
}

const clone = (book: Book): Book => ({ chapters: [...book.chapters] });

function frame(book: Book, label: string, activeId: string | null = null): HistoryFrame<Book> {
  return { value: book, activeId, label };
}

describe('撤销 / 重做历史栈', () => {
  it('连续 10 次编辑可以逐步回退，再逐步重做', () => {
    const history = new EditHistory<Book>({ clone });
    let book: Book = { chapters: ['初始'] };
    const states: Book[] = [{ chapters: ['初始'] }];

    for (let i = 1; i <= 10; i += 1) {
      history.record(frame(book, `第 ${i} 次编辑`));
      book = { chapters: [...book.chapters, `第 ${i} 章`] };
      states.push(book);
    }
    expect(history.size).toBe(10);
    expect(history.undoLabel).toBe('第 10 次编辑');

    for (let i = 9; i >= 0; i -= 1) {
      const previous = history.undo(frame(book, ''));
      expect(previous).not.toBeNull();
      book = previous!.value;
      expect(book).toEqual(states[i]);
    }
    expect(history.undo(frame(book, ''))).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    for (let i = 1; i <= 10; i += 1) {
      const next = history.redo(frame(book, ''));
      expect(next).not.toBeNull();
      book = next!.value;
      expect(book).toEqual(states[i]);
    }
    expect(book).toEqual(states[10]);
    expect(history.redo(frame(book, ''))).toBeNull();
  });

  it('新的编辑会清空 redo 栈', () => {
    const history = new EditHistory<Book>({ clone });
    const a: Book = { chapters: ['a'] };
    history.record(frame(a, '第一步'));
    const b: Book = { chapters: ['a', 'b'] };
    const undone = history.undo(frame(b, ''));
    expect(undone?.value).toEqual(a);
    expect(history.canRedo).toBe(true);

    history.record(frame(a, '另一条路'));
    expect(history.canRedo).toBe(false);
  });

  it('超过上限时丢弃最旧的一步', () => {
    const history = new EditHistory<number>({ limit: 50 });
    for (let i = 0; i < 60; i += 1) history.record({ value: i, activeId: null, label: `编辑 ${i}` });
    expect(history.size).toBe(50);

    let current = 60;
    for (let i = 0; i < 50; i += 1) {
      const previous = history.undo({ value: current, activeId: null, label: '' });
      expect(previous).not.toBeNull();
      current = previous!.value;
    }
    // 只回退到第 10 步，更早的已经被丢弃
    expect(current).toBe(10);
    expect(history.undo({ value: current, activeId: null, label: '' })).toBeNull();
  });

  it('按权重丢弃最旧的历史，至少保留最近一步', () => {
    const history = new EditHistory<string>({ weight: (value) => value.length, maxWeight: 10 });
    history.record({ value: '12345', activeId: null, label: 'a' });
    history.record({ value: '67890', activeId: null, label: 'b' });
    history.record({ value: 'abcde', activeId: null, label: 'c' });
    expect(history.size).toBe(2);
    expect(history.undoLabel).toBe('c');

    const big = new EditHistory<string>({ weight: () => 100, maxWeight: 10 });
    big.record({ value: 'x', activeId: null, label: 'only' });
    expect(big.size).toBe(1);
  });

  it('记录与恢复都使用副本，后续原地修改不会污染历史', () => {
    const history = new EditHistory<Book>({ clone });
    let book: Book = { chapters: ['一'] };
    history.record(frame(book, '改标题'));
    book.chapters[0] = '被原地改掉';
    const previous = history.undo(frame(book, ''));
    expect(previous?.value.chapters).toEqual(['一']);

    // 恢复出来的状态再被原地修改，也不该影响 redo 栈
    const restored = previous!.value;
    restored.chapters.push('额外');
    const next = history.redo(frame(restored, ''));
    expect(next?.value.chapters).toEqual(['被原地改掉']);
  });

  it('撤销 / 重做标签跟着状态走', () => {
    const history = new EditHistory<Book>({ clone });
    const a: Book = { chapters: ['a'] };
    history.record(frame(a, '删除章节'));
    const b: Book = { chapters: ['b'] };
    expect(history.undoLabel).toBe('删除章节');
    const undone = history.undo(frame(b, ''));
    expect(undone?.label).toBe('删除章节');
    expect(history.redoLabel).toBe('删除章节');
    const redone = history.redo(frame(undone!.value, ''));
    expect(redone?.label).toBe('删除章节');
    expect(history.undoLabel).toBe('删除章节');
  });

  it('clear 清空两个栈', () => {
    const history = new EditHistory<number>();
    history.record({ value: 1, activeId: null, label: 'a' });
    history.undo({ value: 2, activeId: null, label: '' });
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
