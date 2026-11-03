/** Process-local RPC observations. No request headers, bodies, IDs, or error messages are retained. */
export interface RpcLifecycleEvent {
  readonly phase: "started" | "finished";
  readonly service: string;
  readonly method: string;
  readonly streaming: boolean;
  readonly at: string;
  readonly code?: number;
  readonly durationMs?: number;
}
export interface RpcMethodSnapshot {
  readonly service: string;
  readonly method: string;
  readonly started: number;
  readonly completed: number;
  readonly active: number;
  readonly activeStreams: number;
  readonly errors: number;
  /** gRPC status codes 0–16. Array position is the code, so error cardinality is fixed. */
  readonly statusCodes: readonly number[];
  readonly durationMs: {
    readonly count: number;
    readonly total: number;
    readonly max: number;
    readonly buckets: readonly { readonly le: number | null; readonly count: number }[];
  };
}
export interface RpcTelemetrySnapshot {
  readonly startedAt: string;
  readonly capturedAt: string;
  readonly methods: readonly RpcMethodSnapshot[];
  readonly channels: { readonly active: number; readonly opened: number; readonly closed: number };
  readonly queues: {
    readonly active: number;
    readonly frames: number;
    readonly bytes: number;
    readonly capacityFrames: number;
    readonly capacityBytes: number;
    readonly peakFrames: number;
    readonly peakBytes: number;
    readonly rejections: number;
  };
  readonly closeCodes: Readonly<Record<string, number>>;
  readonly traceErrors: number;
}
export interface RpcQueueTelemetry {
  update(frames: number, bytes: number): void;
  reject(): void;
  close(): void;
}
type Response =
  | { readonly stream: false; readonly message: unknown }
  | { readonly stream: true; readonly message: AsyncIterable<unknown> };
type Row = {
  service: string;
  method: string;
  started: number;
  completed: number;
  active: number;
  activeStreams: number;
  errors: number;
  statusCodes: number[];
  total: number;
  max: number;
  buckets: number[];
};
const LATENCIES = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 30_000, Number.POSITIVE_INFINITY];
const CLOSE_CODES = new Set([
  1000, 1001, 1006, 1007, 1013, 4001, 4002, 4003, 4004, 4005, 4006, 4007,
]);
const add = (value: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);

/** Bounded cumulative counters and optional structured lifecycle events shared by RPC adapters. */
export class RpcTelemetry {
  readonly #startedAt = new Date().toISOString();
  readonly #methods = new Map<string, Row>();
  readonly #channels = { active: 0, opened: 0, closed: 0 };
  readonly #queues = {
    active: 0,
    frames: 0,
    bytes: 0,
    capacityFrames: 0,
    capacityBytes: 0,
    peakFrames: 0,
    peakBytes: 0,
    rejections: 0,
  };
  readonly #closeCodes: Record<string, number> = {};
  #traceErrors = 0;
  readonly #now: () => number;
  readonly #maxMethods: number;
  constructor(
    private readonly options: {
      readonly onEvent?: (event: RpcLifecycleEvent) => void;
      readonly maxMethods?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.#maxMethods = options.maxMethods ?? 128;
    if (!Number.isSafeInteger(this.#maxMethods) || this.#maxMethods < 1 || this.#maxMethods > 1024)
      throw new Error("RPC method observation limit must be between 1 and 1024");
    this.#now = options.now ?? (() => performance.now());
  }
  snapshot(): RpcTelemetrySnapshot {
    return {
      startedAt: this.#startedAt,
      capturedAt: new Date().toISOString(),
      methods: [...this.#methods.values()]
        .map((row) => ({
          service: row.service,
          method: row.method,
          started: row.started,
          completed: row.completed,
          active: row.active,
          activeStreams: row.activeStreams,
          errors: row.errors,
          statusCodes: [...row.statusCodes],
          durationMs: {
            count: row.completed,
            total: row.total,
            max: row.max,
            buckets: LATENCIES.map((le, index) => ({
              le: Number.isFinite(le) ? le : null,
              count: row.buckets[index] ?? 0,
            })),
          },
        }))
        .sort((a, b) => `${a.service}/${a.method}`.localeCompare(`${b.service}/${b.method}`)),
      channels: { ...this.#channels },
      queues: { ...this.#queues },
      closeCodes: { ...this.#closeCodes },
      traceErrors: this.#traceErrors,
    };
  }
  /** Wrap an interceptor invocation; streaming completion is measured through iteration/abort. */
  async observe<R extends Response>(
    descriptor: { readonly service: string; readonly method: string; readonly streaming: boolean },
    signal: AbortSignal,
    operation: () => Promise<R>,
    errorCode: (error: unknown) => number,
  ): Promise<R> {
    const row = this.#row(descriptor.service, descriptor.method);
    const startedAt = this.#now();
    row.started = add(row.started);
    row.active++;
    if (descriptor.streaming) row.activeStreams++;
    this.#emit({
      phase: "started",
      service: row.service,
      method: row.method,
      streaming: descriptor.streaming,
      at: new Date().toISOString(),
    });
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      const status = Number.isInteger(code) && code >= 0 && code <= 16 ? code : 2;
      const elapsed = Math.max(0, this.#now() - startedAt);
      const durationMs = Number.isFinite(elapsed) ? elapsed : 0;
      row.active--;
      if (descriptor.streaming) row.activeStreams--;
      row.completed = add(row.completed);
      if (status !== 0) row.errors = add(row.errors);
      row.statusCodes[status] = add(row.statusCodes[status] ?? 0);
      row.total = add(row.total, durationMs);
      row.max = Math.max(row.max, durationMs);
      for (let index = 0; index < LATENCIES.length; index++)
        if (durationMs <= (LATENCIES[index] ?? Number.POSITIVE_INFINITY))
          row.buckets[index] = add(row.buckets[index] ?? 0);
      this.#emit({
        phase: "finished",
        service: row.service,
        method: row.method,
        streaming: descriptor.streaming,
        at: new Date().toISOString(),
        code: status,
        durationMs,
      });
    };
    const classify = (error: unknown) => {
      try {
        return errorCode(error);
      } catch {
        return 2;
      }
    };
    const abort = () =>
      finish(
        classify(signal.reason) === 4 ||
          (signal.reason instanceof Error && signal.reason.name === "TimeoutError")
          ? 4
          : 1,
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await operation();
      if (!response.stream) {
        finish(0);
        return response;
      }
      const stream = response.message;
      return {
        ...response,
        message: (async function* () {
          let completed = false;
          try {
            yield* stream;
            completed = true;
          } catch (error) {
            finish(classify(error));
            throw error;
          } finally {
            finish(completed ? 0 : 1);
          }
        })(),
      };
    } catch (error) {
      finish(classify(error));
      throw error;
    }
  }
  openChannel(): () => void {
    this.#channels.active++;
    this.#channels.opened = add(this.#channels.opened);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.#channels.active--;
      this.#channels.closed = add(this.#channels.closed);
    };
  }
  recordClose(code: number): void {
    const key = CLOSE_CODES.has(code) ? String(code) : "other";
    this.#closeCodes[key] = add(this.#closeCodes[key] ?? 0);
  }
  openQueue(capacityFrames: number, capacityBytes: number): RpcQueueTelemetry {
    const queues = this.#queues;
    let frames = 0,
      bytes = 0,
      closed = false;
    queues.active++;
    queues.capacityFrames += capacityFrames;
    queues.capacityBytes += capacityBytes;
    return {
      update(nextFrames, nextBytes) {
        if (closed) return;
        queues.frames += nextFrames - frames;
        queues.bytes += nextBytes - bytes;
        frames = nextFrames;
        bytes = nextBytes;
        queues.peakFrames = Math.max(queues.peakFrames, queues.frames);
        queues.peakBytes = Math.max(queues.peakBytes, queues.bytes);
      },
      reject() {
        queues.rejections = add(queues.rejections);
      },
      close() {
        if (closed) return;
        closed = true;
        queues.active--;
        queues.frames -= frames;
        queues.bytes -= bytes;
        queues.capacityFrames -= capacityFrames;
        queues.capacityBytes -= capacityBytes;
      },
    };
  }
  #row(service: string, method: string): Row {
    if (
      !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/u.test(service) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(method)
    ) {
      service = "other";
      method = "other";
    }
    let key = `${service}/${method}`;
    let row = this.#methods.get(key);
    if (row) return row;
    if (this.#methods.size >= this.#maxMethods) {
      service = "other";
      method = "other";
      key = "other/other";
      row = this.#methods.get(key);
      if (row) return row;
    }
    row = {
      service,
      method,
      started: 0,
      completed: 0,
      active: 0,
      activeStreams: 0,
      errors: 0,
      statusCodes: Array.from({ length: 17 }, () => 0),
      total: 0,
      max: 0,
      buckets: LATENCIES.map(() => 0),
    };
    this.#methods.set(key, row);
    return row;
  }
  #emit(event: RpcLifecycleEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      this.#traceErrors = add(this.#traceErrors);
    }
  }
}
