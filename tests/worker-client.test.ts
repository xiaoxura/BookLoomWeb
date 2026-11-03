import { describe, expect, it, vi } from 'vitest';
import { WorkerClient, type WorkerPort } from '../src/worker/client';

interface SentMessage {
  id: number;
  type: string;
  [key: string]: unknown;
}

class FakeWorker implements WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<{ message: SentMessage; transfer?: Transferable[] }> = [];
  terminated = false;
  throwOnPost = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.throwOnPost) throw new Error('post failed');
    this.sent.push({ message: message as SentMessage, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const onProgress = vi.fn();
  const onError = vi.fn();
  const client = new WorkerClient(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    { onProgress, onError },
  );
  return { client, workers, onProgress, onError };
}

describe('WorkerClient', () => {
  it('转发任务、progress 与响应', async () => {
    const { client, workers, onProgress } = setup();
    const pending = client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'a.txt' });
    expect(workers).toHaveLength(1);
    const sent = workers[0].sent[0].message;
    expect(sent).toMatchObject({ type: 'source', filename: 'a.txt' });

    workers[0].emit({ id: sent.id, type: 'progress', phase: '正在识别章节…' });
    expect(onProgress).toHaveBeenCalledWith('正在识别章节…');

    workers[0].emit({ id: sent.id, type: 'ready' });
    await expect(pending).resolves.toEqual({ id: sent.id, type: 'ready' });
  });

  it('Worker 报错时拒绝所有待处理请求，并在下次调用时重建 Worker', async () => {
    const { client, workers, onError } = setup();
    const first = client.call({ type: 'reparse', options: { encoding: 'auto', filterAds: true } });
    const second = client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'b.txt' });
    expect(workers).toHaveLength(1);

    workers[0].fail('boom');
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(workers[0].terminated).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);

    const third = client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'c.txt' });
    expect(workers).toHaveLength(2);
    const sent = workers[1].sent[0].message;
    workers[1].emit({ id: sent.id, type: 'ready' });
    await expect(third).resolves.toEqual({ id: sent.id, type: 'ready' });
  });

  it('提交失败时拒绝请求且不影响已有任务', async () => {
    const { client, workers } = setup();
    const pending = client.call({ type: 'reparse', options: { encoding: 'auto', filterAds: true } });
    const firstId = workers[0].sent[0].message.id;
    workers[0].throwOnPost = true;
    await expect(
      client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'b.txt' }),
    ).rejects.toThrow('post failed');
    workers[0].emit({ id: firstId, type: 'ready' });
    await expect(pending).resolves.toEqual({ id: firstId, type: 'ready' });
  });

  it('dispose 会拒绝未完成任务并终止 Worker', async () => {
    const { client, workers } = setup();
    const pending = client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'a.txt' });
    client.dispose();
    await expect(pending).rejects.toThrow('后台线程已关闭');
    expect(workers[0].terminated).toBe(true);
    await expect(
      client.call({ type: 'source', buffer: new ArrayBuffer(0), filename: 'b.txt' }),
    ).rejects.toThrow('后台线程已关闭');
  });
});
