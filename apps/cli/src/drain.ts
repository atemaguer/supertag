import { stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectError } from "@connectrpc/connect";
import {
  hostCredentialPath,
  hostServiceDirectory,
  type RunningAttempt,
  readStatus,
  runningProcess,
  type ServiceSlot,
} from "./local-state.js";
import { hostClient, operatorErrorMessage } from "./operator-client.js";
import { readWorkerHostCredential } from "./worker-hosts.js";

/** The Task Attempt time limit assumed for a host service that recorded none. */
const DEFAULT_ATTEMPT_TIME_LIMIT_MS = 60 * 60_000;

/** How long `up` and `down` wait for the Control Plane to drain or resume their own host. */
const OWN_HOST_TIMEOUT_MS = 10_000;

/** A draining host waits at most this long past its longest remaining Task Attempt time limit. */
export const DRAIN_GRACE_MS = 30_000;
/** And never longer than this. */
export const DRAIN_CAP_MS = 30 * 60_000;
/** Maximum time `supertag down` waits before leaving a running host alone. */
export const DOWN_WAIT_MS = 5 * 60_000;
/** How often waiting prints progress. */
export const DRAIN_PROGRESS_MS = 10_000;

/** Time for drain waits; tests pass a fake. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** How long to wait for these Task Attempts: their longest remaining time limit plus a grace. */
export function drainBoundMs(
  attempts: readonly RunningAttempt[],
  timeLimitMs: number,
  now: number,
): number {
  if (attempts.length === 0) return 0;
  const remaining = Math.max(
    0,
    ...attempts.map((attempt) => Date.parse(attempt.startedAt) + timeLimitMs - now),
  );
  return Math.min(remaining + DRAIN_GRACE_MS, DRAIN_CAP_MS);
}

export type DrainOutcome = "idle" | "finished" | "timeout" | "stopped" | "forced";

/**
 * Waits for a host's running Task Attempts to finish, bounded by {@link drainBoundMs}, printing
 * progress every 10 seconds. `force` or an aborted `signal` (Ctrl-C) stops waiting; interrupted
 * Task Attempts then follow the existing recovery rules.
 */
export async function waitForAttempts(input: {
  readonly service: string;
  /** The host's running Task Attempts now, or undefined once its process is gone. */
  readonly read: () => Promise<
    { readonly attempts: readonly RunningAttempt[]; readonly timeLimitMs: number } | undefined
  >;
  readonly write: (text: string) => void;
  readonly clock?: Clock;
  readonly force?: boolean;
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
}): Promise<DrainOutcome> {
  const clock = input.clock ?? realClock;
  const plural = (count: number) => `${count} Task Attempt${count === 1 ? "" : "s"}`;
  const first = await input.read();
  if (first === undefined || first.attempts.length === 0) return "idle";
  if (input.force === true) {
    input.write(
      `Not waiting for ${plural(first.attempts.length)} on host service ${input.service} (--force); they follow the recovery rules.\n`,
    );
    return "forced";
  }
  const started = clock.now();
  const deadline =
    started +
    Math.min(
      drainBoundMs(first.attempts, first.timeLimitMs, started),
      input.maxWaitMs ?? DRAIN_CAP_MS,
    );
  const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
  const describe = (attempts: readonly RunningAttempt[]) =>
    attempts.map((attempt) => `Task ${attempt.taskId}, Attempt ${attempt.attemptId}`).join("; ");
  const stopHint =
    input.maxWaitMs === undefined
      ? "pass --force to stop waiting"
      : `run supertag down ${input.service} --force to stop now`;
  input.write(
    `Draining host service ${input.service}: waiting for ${plural(first.attempts.length)} to finish, at most ${seconds(deadline - started)} seconds. ${describe(first.attempts)}. Press Ctrl-C or ${stopHint}.\n`,
  );
  let progress = started;
  for (;;) {
    await clock.sleep(1_000, input.signal);
    if (input.signal?.aborted === true) {
      input.write(
        `Stopped waiting for host service ${input.service}; running Task Attempts follow the recovery rules.\n`,
      );
      return "stopped";
    }
    const current = await input.read();
    if (current === undefined || current.attempts.length === 0) {
      input.write(`Task Attempts on host service ${input.service} finished.\n`);
      return "finished";
    }
    const now = clock.now();
    if (now >= deadline) {
      input.write(
        `Stopped waiting for host service ${input.service} after ${seconds(now - started)} seconds; ${plural(current.attempts.length)} still running: ${describe(current.attempts)}. ${input.maxWaitMs === undefined ? "Pass --force to stop now" : `Run supertag down ${input.service} --force to stop now`}.\n`,
      );
      return "timeout";
    }
    if (now - progress >= DRAIN_PROGRESS_MS) {
      progress = now;
      input.write(
        `Still waiting for ${plural(current.attempts.length)} on host service ${input.service}, at most ${seconds(deadline - now)} more seconds...\n`,
      );
    }
  }
}

/** Marks a host service drained by `up` or `down`; the host resumes itself when it starts. */
export function drainMarkerPath(service: string): string {
  return join(hostServiceDirectory(service), "drained");
}

/**
 * Drains a running host service before it stops: the Worker Host takes no new Task Attempts, and
 * running ones get time to finish. The host's own credential authorizes the drain, so this works
 * on a shared Control Plane too.
 */
export async function drainHost(
  slot: ServiceSlot,
  options: {
    readonly write: (text: string) => void;
    readonly force?: boolean;
    readonly maxWaitMs?: number;
    readonly clock?: Clock;
    readonly signal?: AbortSignal;
    readonly fetch?: typeof fetch;
  },
): Promise<DrainOutcome> {
  if ((await runningProcess(slot)).pid === undefined) return "idle";
  const status = await readStatus(slot);
  const path = hostCredentialPath(slot.service);
  const credential = (await stat(path).catch(() => undefined))
    ? await readWorkerHostCredential(path).catch(() => undefined)
    : undefined;
  const url = status?.url ?? credential?.controlPlane;
  if (credential !== undefined && url !== undefined) {
    const failure = await ownHost(url, credential, options.fetch)
      .drainWorkerHost({ id: credential.workerHostId }, { timeoutMs: OWN_HOST_TIMEOUT_MS })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (failure === undefined)
      await writeFile(drainMarkerPath(slot.service), `${credential.workerHostId}\n`, {
        mode: 0o600,
      });
    else
      options.write(
        `Could not drain Worker Host ${credential.workerHostId} (${failureText(failure)}); new Task Attempts may still arrive while it stops.\n`,
      );
  }
  const signal = interruptible(options.signal);
  try {
    return await waitForAttempts({
      service: slot.service,
      read: async () => {
        if ((await runningProcess(slot)).pid === undefined) return undefined;
        const current = await readStatus(slot);
        return {
          attempts: current?.attempts ?? [],
          timeLimitMs: current?.attemptTimeLimitMs ?? DEFAULT_ATTEMPT_TIME_LIMIT_MS,
        };
      },
      write: options.write,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      signal: signal.signal,
    });
  } finally {
    signal.dispose();
  }
}

/** Ctrl-C while waiting stops waiting, not the command. */
function interruptible(given: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const stop = () => controller.abort();
  given?.addEventListener("abort", stop, { once: true });
  if (given?.aborted) controller.abort();
  process.on("SIGINT", stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", stop);
      given?.removeEventListener("abort", stop);
    },
  };
}

/** Ends a drain `up` or `down` started, with the host's own credential. */
export async function resumeIfDrained(
  service: string,
  managementUrl: string,
  credential: { readonly workerHostId: string; readonly token: string },
): Promise<boolean> {
  const marker = drainMarkerPath(service);
  if (!(await stat(marker).catch(() => undefined))) return false;
  const resumed = await ownHost(managementUrl, credential)
    .resumeWorkerHost({ id: credential.workerHostId }, { timeoutMs: OWN_HOST_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
  if (!resumed) return false;
  await unlink(marker).catch(() => undefined);
  return true;
}

/** Calls `HostService` as the Worker Host itself, with its own credential. */
function ownHost(
  url: string,
  credential: { readonly workerHostId: string; readonly token: string },
  request?: typeof fetch,
) {
  return hostClient({
    url,
    token: credential.token,
    workerHostId: credential.workerHostId,
    ...(request === undefined ? {} : { fetch: request }),
  });
}

function failureText(error: unknown): string {
  if (error instanceof ConnectError) return operatorErrorMessage(error);
  return error instanceof Error ? error.message : String(error);
}
