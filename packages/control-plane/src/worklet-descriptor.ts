import type { Worklet } from "@supertag/worker-sdk";

/** Bound discovery latency without claiming cancellation of the plugin promise. */
export async function describeWorklet(worklet: Worklet) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => worklet.describe()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worklet description timed out")), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
