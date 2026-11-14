import { createHash } from "node:crypto";
import type {
  SandboxOwner,
  SandboxStopResult,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import type { Sandbox, SandboxService } from "modal";

export type { SandboxOwner, SandboxStopResult };

export interface SandboxIdentity {
  readonly sandboxId: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SandboxInventory {
  find(metadata: Readonly<Record<string, string>>): Promise<readonly SandboxIdentity[]>;
  /** Requires server-returned tags: Modal fromId alone only constructs a handle. */
  get(sandboxId: string): Promise<SandboxIdentity>;
  /** Null means running. Errors, including NotFound, do not prove termination. */
  poll(sandboxId: string): Promise<number | null>;
  /** Returns only after Modal terminate({wait:true}) observes a terminal result. */
  terminate(sandboxId: string): Promise<number>;
}

function ownerDigest(owner: SandboxOwner): Buffer {
  if (
    owner.hostGeneration < 1n ||
    owner.hostGeneration > 18_446_744_073_709_551_615n ||
    [owner.hostId, owner.taskId, owner.attemptId, owner.allocationId].some(
      (value) => !value || value.length > 256 || /\p{Cc}/u.test(value),
    )
  )
    throw new Error("Invalid sandbox ownership");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "supertag.modal.allocation.v1",
        owner.hostId,
        owner.hostGeneration.toString(),
        owner.taskId,
        owner.attemptId,
        owner.allocationId,
      ]),
    )
    .digest();
}

/** Create-time tags: a full digest keeps all owner fields within Modal's tag budget. */
export function sandboxOwnershipMetadata(owner: SandboxOwner): Readonly<Record<string, string>> {
  return { "supertag.owner.v1": ownerDigest(owner).toString("hex") };
}

/** Stable create-time name, within Modal's 64-character name limit. */
export function sandboxOwnershipName(owner: SandboxOwner): string {
  return `supertag-${ownerDigest(owner).toString("base64url")}`;
}

export function sandboxOwnershipMatches(owner: SandboxOwner, sandbox: SandboxIdentity): boolean {
  return Object.entries(sandboxOwnershipMetadata(owner)).every(
    ([key, value]) => sandbox.metadata[key] === value,
  );
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

function terminal(code: unknown): code is number {
  return (
    typeof code === "number" &&
    Number.isInteger(code) &&
    code >= -2_147_483_648 &&
    code <= 2_147_483_647
  );
}

/**
 * Modal inventory contains only running sandboxes. Missing list/name results and
 * NotFound errors therefore never prove a recorded allocation stopped. Require
 * exact server-returned owner tags and a terminal result for that sandbox ID.
 * The caller owns the SDK client and closes it when the provider process stops.
 */
export async function stopOwnedSandbox(
  inventory: SandboxInventory,
  owner: SandboxOwner,
  sandboxId?: string,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<SandboxStopResult> {
  const metadata = sandboxOwnershipMetadata(owner);
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Invalid sandbox stop timeout");
  if (options.signal?.aborted) return { state: "uncertain" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const interrupted = new Promise<SandboxStopResult>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ state: "uncertain" }), {
      once: true,
    });
  });
  const timer = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  const check = () => controller.signal.throwIfAborted();

  const stop = async (): Promise<SandboxStopResult> => {
    try {
      check();
      if (sandboxId === undefined) {
        const found = await inventory.find(metadata);
        check();
        const ids = [
          ...new Set(
            found
              .filter((item) => sandboxOwnershipMatches(owner, item))
              .map((item) => item.sandboxId),
          ),
        ];
        if (ids.length !== 1) return { state: "uncertain" };
        sandboxId = ids[0];
      }
      if (!sandboxId || !validId(sandboxId)) return { state: "uncertain" };
      const before = await inventory.get(sandboxId);
      check();
      if (before.sandboxId !== sandboxId || !sandboxOwnershipMatches(owner, before))
        return { state: "uncertain" };
      const initial = await inventory.poll(sandboxId);
      check();
      if (terminal(initial)) return { state: "stopped", sandboxId };
      if (initial !== null) return { state: "uncertain" };

      try {
        const code = await inventory.terminate(sandboxId);
        check();
        if (terminal(code)) return { state: "stopped", sandboxId };
      } catch {
        check();
        // The termination response can be lost after the sandbox has stopped.
        // Reattach the exact ID; do not infer completion from absence in list().
      }
      const after = await inventory.get(sandboxId);
      check();
      if (after.sandboxId !== sandboxId || !sandboxOwnershipMatches(owner, after))
        return { state: "uncertain" };
      const code = await inventory.poll(sandboxId);
      check();
      return terminal(code) ? { state: "stopped", sandboxId } : { state: "uncertain" };
    } catch {
      return { state: "uncertain" };
    }
  };
  try {
    // The SDK has no per-operation AbortSignal on these methods. Returning an
    // uncertain result fences late completions; check() prevents later effects.
    return await Promise.race([stop(), interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function modalSandboxInventory(
  client: { readonly sandboxes: Pick<SandboxService, "list" | "fromId"> },
  scope: { readonly appId: string; readonly environment?: string },
): SandboxInventory {
  if (!validId(scope.appId) || (scope.environment !== undefined && !validId(scope.environment)))
    throw new Error("Invalid Modal inventory scope");
  const withSandbox = async <T>(
    id: string,
    action: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> => {
    const sandbox = await client.sandboxes.fromId(id);
    try {
      if (sandbox.sandboxId !== id) throw new Error("Modal inventory returned a different sandbox");
      return await action(sandbox);
    } finally {
      sandbox.detach();
    }
  };
  return {
    async find(metadata) {
      const found: SandboxIdentity[] = [];
      const ids = new Set<string>();
      for await (const sandbox of client.sandboxes.list({ ...scope, tags: { ...metadata } })) {
        try {
          if (found.length >= 256 || ids.has(sandbox.sandboxId))
            throw new Error("Modal ownership inventory exceeds its limit or repeats an ID");
          ids.add(sandbox.sandboxId);
          found.push({ sandboxId: sandbox.sandboxId, metadata: await sandbox.getTags() });
        } finally {
          sandbox.detach();
        }
      }
      return found;
    },
    get: (id) =>
      withSandbox(id, async (sandbox) => ({
        sandboxId: sandbox.sandboxId,
        metadata: await sandbox.getTags(),
      })),
    poll: (id) => withSandbox(id, (sandbox) => sandbox.poll()),
    terminate: (id) => withSandbox(id, (sandbox) => sandbox.terminate({ wait: true })),
  };
}
