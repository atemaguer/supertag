/** Bound extension latency; this deadline does not cancel the underlying extension promise. */
export async function probeWorklet<T>(probe: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(probe),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worklet capability discovery timed out")), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
