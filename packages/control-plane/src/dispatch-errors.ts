import { createHash } from "node:crypto";

/** Bound repeat diagnostics while preserving the first occurrence of each distinct error. */
export class DispatchErrorReporter {
  private readonly recent = new Map<
    string,
    { error: unknown; lastReported: number; suppressed: number }
  >();
  constructor(
    private readonly sink?: (error: unknown) => void,
    private readonly now = Date.now,
  ) {}
  report(error: unknown): void {
    if (!this.sink) return;
    const key = createHash("sha256")
      .update(error instanceof Error ? `${error.name}:${error.message}` : String(error))
      .digest("hex");
    const at = this.now();
    const prior = this.recent.get(key);
    if (prior) {
      prior.suppressed++;
      if (at - prior.lastReported < 5000) return;
      this.summary(prior);
      prior.lastReported = at;
      return;
    }
    if (this.recent.size >= 128) {
      const oldest = this.recent.entries().next().value;
      if (oldest) {
        this.summary(oldest[1]);
        this.recent.delete(oldest[0]);
      }
    }
    this.recent.set(key, { error, lastReported: at, suppressed: 0 });
    this.emit(error);
  }
  flush(): void {
    for (const entry of this.recent.values()) this.summary(entry);
    this.recent.clear();
  }
  private summary(entry: { error: unknown; suppressed: number }): void {
    if (!entry.suppressed) return;
    const text = entry.error instanceof Error ? entry.error.message : String(entry.error);
    const summary = new Error(
      `Repeated dispatch error (${entry.suppressed} additional ${entry.suppressed === 1 ? "occurrence" : "occurrences"}): ${text}`,
    );
    if (entry.error instanceof Error) summary.name = entry.error.name;
    this.emit(summary);
    entry.suppressed = 0;
  }
  private emit(error: unknown): void {
    try {
      this.sink?.(error);
    } catch {
      /* Diagnostics cannot stop dispatch. */
    }
  }
}
