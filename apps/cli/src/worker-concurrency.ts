import { availableParallelism, totalmem } from "node:os";

/** The fewest and most Task Attempts per harness Worker the machine-derived default allows. */
export const MIN_MACHINE_CONCURRENCY = 2;
export const MAX_MACHINE_CONCURRENCY = 8;

/** Memory one running Task Attempt is assumed to need, in GB. */
const GB_PER_ATTEMPT = 3;

/** The CPU and memory a machine-derived concurrency is computed from. */
export interface MachineResources {
  readonly cpus: number;
  /** Total memory in bytes. */
  readonly memoryBytes: number;
}

/** Where a host's concurrency came from: supertag.yaml, or this machine's CPU and memory. */
export type ConcurrencySource = "file" | "machine";

/** This machine's CPU count and total memory. */
export function machineResources(): MachineResources {
  return { cpus: availableParallelism(), memoryBytes: totalmem() };
}

/**
 * Task Attempts one harness Worker runs at once when supertag.yaml does not say. Task Attempts
 * mostly wait on the model, so the machine allows several: floor(min(CPU cores, memory GB / 3) / 2),
 * kept from 2 through 8. A 14-core, 36 GB laptop gets 6 per harness.
 */
export function machineWorkerConcurrency(resources: MachineResources = machineResources()): number {
  const memoryGb = resources.memoryBytes / 1024 ** 3;
  const derived = Math.floor(Math.min(resources.cpus, memoryGb / GB_PER_ATTEMPT) / 2);
  return Math.min(MAX_MACHINE_CONCURRENCY, Math.max(MIN_MACHINE_CONCURRENCY, derived));
}

/** The largest per-Worker concurrency a Worker Host may declare. */
export const MAX_WORKER_CONCURRENCY = 16;

/** Reads a per-Worker concurrency: a whole number from 1 through 16. */
export function parseWorkerConcurrency(value: unknown): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d+\s*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_WORKER_CONCURRENCY)
    throw new Error(`must be a whole number from 1 through ${MAX_WORKER_CONCURRENCY}`);
  return number;
}
