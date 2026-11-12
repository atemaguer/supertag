import { Sandbox, type SandboxApiOpts, SandboxNotFoundError } from "e2b";

export interface SandboxOwner {
  readonly hostId: string;
  readonly hostGeneration: bigint;
  readonly taskId: string;
  readonly attemptId: string;
  readonly allocationId: string;
}

export interface SandboxIdentity {
  readonly sandboxId: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SandboxInventory {
  find(metadata: Readonly<Record<string, string>>): Promise<readonly SandboxIdentity[]>;
  /** Undefined means the provider definitively reported this sandbox ID absent. */
  get(sandboxId: string): Promise<SandboxIdentity | undefined>;
  kill(sandboxId: string): Promise<void>;
}

export type SandboxStopResult =
  | { readonly state: "stopped"; readonly sandboxId: string }
  | { readonly state: "uncertain" };

export function sandboxOwnershipMetadata(owner: SandboxOwner): Readonly<Record<string, string>> {
  if (
    owner.hostGeneration < 1n ||
    [owner.hostId, owner.taskId, owner.attemptId, owner.allocationId].some(
      (value) => !value || value.length > 256 || /\p{Cc}/u.test(value),
    )
  )
    throw new Error("Invalid sandbox ownership");
  return {
    "supertag.hostId": owner.hostId,
    "supertag.hostGeneration": owner.hostGeneration.toString(),
    "supertag.taskId": owner.taskId,
    "supertag.attemptId": owner.attemptId,
    "supertag.allocationId": owner.allocationId,
  };
}

/**
 * An ID supplied by the Worker Host was already verified and recorded under
 * this allocation. Without that receipt, discovery must identify exactly one
 * owned sandbox before any termination or absence can count as evidence.
 */
export async function stopOwnedSandbox(
  inventory: SandboxInventory,
  owner: SandboxOwner,
  sandboxId?: string,
): Promise<SandboxStopResult> {
  const metadata = sandboxOwnershipMetadata(owner);
  const matches = (sandbox: SandboxIdentity) =>
    Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value);
  try {
    if (sandboxId === undefined) {
      const found = await inventory.find(metadata);
      const ids = [...new Set(found.filter(matches).map((sandbox) => sandbox.sandboxId))];
      if (ids.length !== 1 || !ids[0]) return { state: "uncertain" };
      sandboxId = ids[0];
    }
    if (!sandboxId) return { state: "uncertain" };
    const before = await inventory.get(sandboxId);
    if (before === undefined) return { state: "stopped", sandboxId };
    if (before.sandboxId !== sandboxId || !matches(before)) return { state: "uncertain" };

    // An acknowledgement can be lost after the provider stops the sandbox.
    // Inspect the exact ID even when Kill returns a transport error.
    await inventory.kill(sandboxId).catch(() => undefined);
    return (await inventory.get(sandboxId)) === undefined
      ? { state: "stopped", sandboxId }
      : { state: "uncertain" };
  } catch {
    return { state: "uncertain" };
  }
}

export function e2bSandboxInventory(
  options: SandboxApiOpts = {},
  client: Pick<typeof Sandbox, "list" | "getInfo" | "kill"> = Sandbox,
): SandboxInventory {
  return {
    async find(metadata) {
      const pages = client.list({
        ...options,
        query: { metadata: { ...metadata }, state: ["running", "paused"] },
      });
      const found: SandboxIdentity[] = [];
      for (let page = 0; pages.hasNext; page++) {
        if (page >= 16) throw new Error("Sandbox ownership inventory exceeds its limit");
        found.push(...(await pages.nextItems(options)));
      }
      return found;
    },
    async get(sandboxId) {
      try {
        return await client.getInfo(sandboxId, options);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return undefined;
        throw error;
      }
    },
    async kill(sandboxId) {
      await client.kill(sandboxId, options);
    },
  };
}
