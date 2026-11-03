import { type AsyncHook, AsyncLocalStorage, createHook } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const LAG_THRESHOLD_MS = 1_000;
const SAMPLE_INTERVAL_MS = 250;

export interface EventLoopLagWarning {
  readonly activity: string;
  readonly lagMs: number;
}

/** Attributes long synchronous turns, including async continuations, to their parent activity. */
export class EventLoopLagMonitor {
  readonly #context = new AsyncLocalStorage<string>();
  readonly #started = new Map<number, { activity: string; at: number }>();
  readonly #warn: (warning: EventLoopLagWarning) => void;
  #hook: AsyncHook | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #expected = 0;
  #lastWarningAt = 0;

  constructor(warn: (warning: EventLoopLagWarning) => void) {
    this.#warn = warn;
  }

  start(): void {
    if (this.#timer) return;
    this.#hook = createHook({
      before: (id) => {
        const activity = this.#context.getStore();
        if (activity) this.#started.set(id, { activity, at: performance.now() });
      },
      after: (id) => {
        const started = this.#started.get(id);
        if (!started) return;
        this.#started.delete(id);
        this.#report(started.activity, performance.now() - started.at);
      },
      destroy: (id) => {
        this.#started.delete(id);
      },
    });
    this.#hook.enable();
    this.#expected = performance.now() + SAMPLE_INTERVAL_MS;
    this.#timer = setInterval(() => {
      const now = performance.now();
      const lagMs = now - this.#expected;
      this.#expected = now + SAMPLE_INTERVAL_MS;
      // A scoped callback already emitted its more useful, named warning.
      if (lagMs > LAG_THRESHOLD_MS && this.#lastWarningAt < now - lagMs) {
        this.#report("unattributed event-loop work", lagMs);
      }
    }, SAMPLE_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#hook?.disable();
    this.#hook = undefined;
    this.#started.clear();
  }

  run<T>(activity: string, work: () => T): T {
    return this.#context.run(activity, () => {
      const started = performance.now();
      try {
        return work();
      } finally {
        this.#report(activity, performance.now() - started);
      }
    });
  }

  #report(activity: string, lagMs: number): void {
    if (lagMs <= LAG_THRESHOLD_MS) return;
    this.#lastWarningAt = performance.now();
    this.#warn({ activity, lagMs: Math.round(lagMs) });
  }
}

export const controlPlaneEventLoopLag = new EventLoopLagMonitor(({ activity, lagMs }) => {
  process.stderr.write(
    `${JSON.stringify({ level: "warn", type: "control-plane.event-loop-lag", lagMs, activity })}\n`,
  );
});
