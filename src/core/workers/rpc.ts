declare var self: Worker;

// ── Message Types ──────────────────────────────────────────────────────

interface CallMessage {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

interface ResultMessage {
  type: "result";
  id: number;
  data: unknown;
}

interface ErrorMessage {
  type: "error";
  id: number;
  message: string;
  stack?: string;
}

interface EventMessage {
  type: "event";
  event: string;
  data: unknown;
}

interface CallbackRequest {
  type: "callback";
  id: number;
  name: string;
  data: unknown;
}

interface CallbackResponse {
  type: "callback-result";
  id: number;
  data: unknown;
  error?: string;
}

interface InitMessage {
  type: "init";
  config: Record<string, unknown>;
}

interface DisposeMessage {
  type: "dispose";
}

type WorkerInbound = CallMessage | InitMessage | DisposeMessage | CallbackResponse;
type WorkerOutbound = ResultMessage | ErrorMessage | EventMessage | CallbackRequest;

// ── Worker-Side Handler ────────────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => unknown;

export interface WorkerHandlerContext {
  emit(event: string, data: unknown): void;
  requestCallback<T>(name: string, data: unknown, timeoutMs?: number): Promise<T>;
}

export function createWorkerHandler(
  handlers: Record<string, HandlerFn>,
  onInit?: (config: Record<string, unknown>, ctx: WorkerHandlerContext) => void | Promise<void>,
  onDispose?: () => void | Promise<void>,
): WorkerHandlerContext {
  let callbackIdCounter = 0;
  let initDone = false;
  let initReceived = false;
  let initQueue: WorkerInbound[] = [];
  const pendingCallbacks = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const ctx: WorkerHandlerContext = {
    emit(event: string, data: unknown) {
      postMessage({ type: "event", event, data } satisfies EventMessage);
    },
    requestCallback<T>(name: string, data: unknown, timeoutMs = 60_000): Promise<T> {
      const id = callbackIdCounter++;
      postMessage({ type: "callback", id, name, data } satisfies CallbackRequest);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingCallbacks.delete(id)) {
            reject(new Error(`Callback timeout: ${name}`));
          }
        }, timeoutMs);
        pendingCallbacks.set(id, {
          resolve: (v: unknown) => {
            clearTimeout(timer);
            (resolve as (v: unknown) => void)(v);
          },
          reject: (e: Error) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
  };

  const allHandlers: Record<string, HandlerFn> = {
    ...handlers,
    __memoryUsage: () => {
      // Force GC before reporting so heapUsed reflects live objects,
      // not the allocator high-water mark from hours ago.
      try {
        Bun.gc(true);
      } catch {}
      const usage = process.memoryUsage();
      return { heapUsed: usage.heapUsed, rss: usage.rss };
    },
  };

  async function handleCall(msg: WorkerInbound & { type: "call" }) {
    const fn = allHandlers[msg.method];
    if (!fn) {
      postMessage({
        type: "error",
        id: msg.id,
        message: `Unknown method: ${msg.method}`,
      } satisfies ErrorMessage);
      return;
    }
    try {
      const result = await fn(...msg.args);
      postMessage({ type: "result", id: msg.id, data: result } satisfies ResultMessage);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      postMessage({
        type: "error",
        id: msg.id,
        message: error.message,
        stack: error.stack,
      } satisfies ErrorMessage);
    }
  }

  self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
    const msg = e.data;

    switch (msg.type) {
      case "call": {
        if (initReceived && !initDone) {
          initQueue.push(msg);
          return;
        }
        await handleCall(msg);
        break;
      }

      case "callback-result": {
        const pending = pendingCallbacks.get(msg.id);
        if (pending) {
          pendingCallbacks.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.data);
          }
        }
        break;
      }

      case "init": {
        initReceived = true;
        try {
          await onInit?.(msg.config, ctx);
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          ctx.emit("init-error", { message: error.message, stack: error.stack });
        }
        initDone = true;
        const queued = initQueue;
        initQueue = [];
        for (const m of queued) {
          await handleCall(m as WorkerInbound & { type: "call" });
        }
        break;
      }

      case "dispose": {
        try {
          await onDispose?.();
        } catch {}
        process.exit(0);
      }
    }
  };

  return ctx;
}

// ── Main Thread Client ─────────────────────────────────────────────────

type EventListener = (data: unknown) => void;
type CallbackHandler = (data: unknown) => Promise<unknown>;

export class WorkerClient {
  protected worker: Worker;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;
  private eventListeners = new Map<string, Set<EventListener>>();
  private callbackHandlers = new Map<string, CallbackHandler>();
  private disposed = false;
  private workerPath: string;
  private initConfig?: Record<string, unknown>;
  private workerOpts?: { smol?: boolean };
  private restartCount = 0;
  private static readonly MAX_RESTARTS = 3;

  onStatusChange?: (status: "starting" | "ready" | "crashed" | "restarting") => void;
  onRpcStart?: () => void;
  onRpcEnd?: (error?: boolean) => void;

  constructor(
    workerPath: string,
    initConfig?: Record<string, unknown>,
    workerOpts?: { smol?: boolean },
  ) {
    this.workerPath = workerPath;
    this.initConfig = initConfig;
    this.workerOpts = workerOpts;
    this.worker = this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const w = new Worker(this.workerPath, this.workerOpts);
    w.unref();
    w.onmessage = (e: MessageEvent<WorkerOutbound | CallbackRequest>) => this.handleMessage(e.data);
    w.onerror = (e: ErrorEvent) => this.handleWorkerError(e);
    w.addEventListener("close", () => this.handleWorkerClose());
    if (this.initConfig) {
      w.postMessage({ type: "init", config: this.initConfig } satisfies InitMessage);
    }
    this.onStatusChange?.("starting");
    return w;
  }

  protected tryRestart(): boolean {
    if (this.disposed || this.restartCount >= WorkerClient.MAX_RESTARTS) return false;
    this.restartCount++;
    this.onStatusChange?.("restarting");
    try {
      this.worker.terminate();
    } catch {}
    try {
      this.worker = this.spawnWorker();
      return true;
    } catch {
      this.onStatusChange?.("crashed");
      return false;
    }
  }

  protected resetRestartCount(): void {
    this.restartCount = 0;
  }

  private static readonly CALL_TIMEOUT = 30_000;

  protected call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.callWithTimeout<T>(WorkerClient.CALL_TIMEOUT, method, ...args);
  }

  protected callWithTimeout<T>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Worker disposed"));
    const id = this.nextId++;
    this.worker.postMessage({ type: "call", id, method, args } satisfies CallMessage);
    this.onRpcStart?.();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.onRpcEnd?.(true);
          reject(new Error(`Worker RPC timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          this.onRpcEnd?.();
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          this.onRpcEnd?.(true);
          reject(e);
        },
      });
    });
  }

  queryMemory(): Promise<{ heapUsed: number; rss: number }> {
    return this.call<{ heapUsed: number; rss: number }>("__memoryUsage");
  }

  protected fire(method: string, ...args: unknown[]): void {
    if (this.disposed) return;
    const id = this.nextId++;
    this.worker.postMessage({ type: "call", id, method, args } satisfies CallMessage);
  }

  on(event: string, fn: EventListener): void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(fn);
  }

  off(event: string, fn: EventListener): void {
    this.eventListeners.get(event)?.delete(fn);
  }

  registerCallback(name: string, handler: CallbackHandler): void {
    this.callbackHandlers.set(name, handler);
  }

  private handleMessage(msg: WorkerOutbound | CallbackRequest) {
    switch (msg.type) {
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }

      case "error": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          const err = new Error(msg.message);
          if (msg.stack) err.stack = msg.stack;
          p.reject(err);
        }
        break;
      }

      case "event": {
        const fns = this.eventListeners.get(msg.event);
        if (fns) {
          for (const fn of fns) {
            try {
              fn(msg.data);
            } catch {}
          }
        }
        break;
      }

      case "callback": {
        const handler = this.callbackHandlers.get(msg.name);
        const respond = (resp: CallbackResponse) => {
          try {
            this.worker.postMessage(resp);
          } catch {}
        };
        if (handler) {
          Promise.resolve()
            .then(() => handler(msg.data))
            .then((result) => {
              respond({
                type: "callback-result",
                id: msg.id,
                data: result,
              } satisfies CallbackResponse);
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              respond({
                type: "callback-result",
                id: msg.id,
                data: null,
                error: error.message,
              } satisfies CallbackResponse);
            });
        } else {
          respond({
            type: "callback-result",
            id: msg.id,
            data: null,
            error: `No callback handler for: ${msg.name}`,
          } satisfies CallbackResponse);
        }
        break;
      }
    }
  }

  private handleWorkerError(e: ErrorEvent) {
    for (const [, p] of this.pending) {
      p.reject(new Error(`Worker error: ${e.message}`));
    }
    this.pending.clear();
    if (!this.disposed) this.onStatusChange?.("crashed");
  }

  private handleWorkerClose() {
    for (const [, p] of this.pending) {
      p.reject(new Error("Worker closed unexpectedly"));
    }
    this.pending.clear();
    if (!this.disposed) {
      this.onStatusChange?.("crashed");
      this.tryRestart();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending) {
      p.reject(new Error("Worker disposed"));
    }
    this.pending.clear();
    // Send dispose message so the worker can clean up child processes
    // (e.g. LSP servers). The worker's onDispose handler runs cleanup
    // then calls process.exit(0). The worker is already unref()'d
    // (see spawnWorker), so it won't block the main process from exiting.
    try {
      this.worker.postMessage({ type: "dispose" });
    } catch {}
  }
}
