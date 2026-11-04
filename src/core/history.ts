/**
 * 通用撤销 / 重做历史栈。
 *
 * 栈里存的是「操作之前」的状态快照：每次编辑前 `record()` 一次，
 * 撤销时把当前状态推进 redo 栈并返回上一步快照。
 * 批量操作可以只 record 一次，从而合并成一步。
 */
export interface HistoryFrame<T> {
  value: T;
  activeId: string | null;
  /** 这次操作的名字，用于「撤销：删除章节」这类提示 */
  label: string;
}

export interface HistoryOptions<T> {
  /** 最多保留多少步，默认 50 */
  limit?: number;
  /** 入栈时复制值，避免后续原地修改污染历史 */
  clone?: (value: T) => T;
  /** 估算单帧占用（例如字符数），配合 maxWeight 控制大书内存 */
  weight?: (value: T) => number;
  /** 所有历史帧的总权重上限；超出时从最旧的一步开始丢弃 */
  maxWeight?: number;
}

function identity<T>(value: T): T {
  return value;
}

const zero = (): number => 0;

export class EditHistory<T> {
  readonly limit: number;
  private readonly clone: (value: T) => T;
  private readonly weight: (value: T) => number;
  private readonly maxWeight: number;
  private past: HistoryFrame<T>[] = [];
  private future: HistoryFrame<T>[] = [];

  constructor(options: HistoryOptions<T> = {}) {
    const limit = Math.floor(options.limit ?? 50);
    this.limit = Math.max(1, limit);
    this.clone = options.clone ?? identity;
    this.weight = options.weight ?? zero;
    this.maxWeight = Math.max(0, options.maxWeight ?? Number.POSITIVE_INFINITY);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string {
    return this.past[this.past.length - 1]?.label ?? '';
  }

  get redoLabel(): string {
    return this.future[this.future.length - 1]?.label ?? '';
  }

  /** 可撤销的步数 */
  get size(): number {
    return this.past.length;
  }

  /** 记录一次变更之前的状态，同时清空 redo 栈 */
  record(frame: HistoryFrame<T>): void {
    this.past.push({ ...frame, value: this.clone(frame.value) });
    this.future = [];
    this.trim();
  }

  undo(current: HistoryFrame<T>): HistoryFrame<T> | null {
    const frame = this.past.pop();
    if (!frame) return null;
    this.future.push({ ...current, label: frame.label, value: this.clone(current.value) });
    return frame;
  }

  redo(current: HistoryFrame<T>): HistoryFrame<T> | null {
    const frame = this.future.pop();
    if (!frame) return null;
    this.past.push({ ...current, label: frame.label, value: this.clone(current.value) });
    return frame;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  private trim(): void {
    while (this.past.length > this.limit) this.past.shift();
    if (!Number.isFinite(this.maxWeight)) return;
    let total = this.past.reduce((sum, frame) => sum + this.weight(frame.value), 0);
    // 至少保留最近一步，哪怕单帧就超预算
    while (this.past.length > 1 && total > this.maxWeight) {
      const dropped = this.past.shift();
      if (!dropped) break;
      total -= this.weight(dropped.value);
    }
  }
}
