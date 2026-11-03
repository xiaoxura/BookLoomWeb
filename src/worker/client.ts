import type { FromWorker, ToWorker } from './protocol';

export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type RequestPayload = DistributiveOmit<ToWorker, 'id'>;

/** 只依赖 Worker 的最小子集，方便在 Node 测试里替换成假 Worker */
export interface WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface WorkerClientOptions {
  onProgress?: (phase: string) => void;
  onError?: (error: Error) => void;
}

interface Pending {
  resolve: (value: FromWorker) => void;
  reject: (error: Error) => void;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  const message = typeof value === 'string' && value ? value : fallback;
  return new Error(message);
}

export class WorkerClient {
  private worker: WorkerPort | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private disposed = false;

  constructor(
    private readonly createWorker: () => WorkerPort,
    private readonly options: WorkerClientOptions = {},
  ) {}

  call(payload: RequestPayload, transfer: Transferable[] = []): Promise<FromWorker> {
    if (this.disposed) return Promise.reject(new Error('后台线程已关闭'));
    const id = ++this.seq;
    return new Promise<FromWorker>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ensureWorker().postMessage({ ...payload, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(toError(error, '无法提交后台任务'));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('后台线程已关闭'));
    this.destroyWorker();
  }

  private ensureWorker(): WorkerPort {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event) => this.handleMessage(event);
    worker.onerror = (event) => {
      const message = typeof event?.message === 'string' && event.message ? event.message : '后台线程出错';
      this.handleFailure(worker, new Error(message));
    };
    worker.onmessageerror = () => {
      this.handleFailure(worker, new Error('后台线程返回了无法解析的消息'));
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(event: MessageEvent): void {
    const message = event.data as FromWorker | undefined;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'progress') {
      this.options.onProgress?.(message.phase);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.type === 'error') entry.reject(new Error(message.message));
    else entry.resolve(message);
  }

  private handleFailure(failed: WorkerPort, error: Error): void {
    if (this.disposed || this.worker !== failed) return;
    this.destroyWorker();
    this.failAll(error);
    this.options.onError?.(error);
  }

  private failAll(error: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  private destroyWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      /* 已经结束的 Worker 可以忽略 */
    }
  }
}
