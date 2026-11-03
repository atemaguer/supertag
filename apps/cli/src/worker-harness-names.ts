/** Advertised harnesses identify built-in Workers; custom Workers may only declare a type. */
export function workerHarnessNames(worker: Record<string, unknown>): string[] {
  const harnesses = Array.isArray(worker["profileCapabilities"])
    ? worker["profileCapabilities"].flatMap((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || !("harness" in entry)) return [];
        return typeof entry.harness === "string" && entry.harness.length > 0 ? [entry.harness] : [];
      })
    : [];
  return harnesses.length > 0
    ? [...new Set(harnesses)].sort()
    : [String(worker["type"] ?? "unknown")];
}
