import type {
  GatewayCredentialVault,
  ManagedResourceKind,
  ResourceManagement,
  Store,
  WorkerHost,
} from "@supertag/core";
import { MANAGED_RESOURCE_KINDS, objectiveClosed, parseApplySetName } from "@supertag/core";
import { applyDeletion, deletionRefusal, planDeletion } from "./resource-deletion.js";

export interface PruneItem {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  /** Objectives are cancelled, keeping their history; other kinds are deleted or retired. */
  readonly action: "delete" | "cancel" | "skip";
  readonly reason?: string;
}

/**
 * Removes the members of one apply set that the latest input no longer lists: Objectives first,
 * which are cancelled rather than deleted, then Tags, and Surface Accounts last, with the same in-use
 * protection as `supertag delete`. A member that is still in use is skipped with a reason and
 * stays in the set, so a later prune tries again. A dry run reports the same decisions from the
 * current state, counting the Objectives it would cancel as closed.
 */
export async function pruneApplySet(
  store: Store,
  input: {
    readonly applySet: string;
    readonly keep: readonly { readonly kind: string; readonly name: string }[];
    readonly dryRun: boolean;
    readonly workerHosts?: () => Promise<readonly WorkerHost[]>;
    /** Removes a retired Surface Account's stored credential. */
    readonly credentialVault?: Pick<GatewayCredentialVault, "delete">;
    /** Cancels an Objective and its open Tasks, as `supertag cancel objective` does. */
    readonly cancelObjective?: (id: string, reason: string) => Promise<void>;
  },
): Promise<readonly PruneItem[]> {
  const applySet = parseApplySetName(input.applySet);
  const keep = new Set(input.keep.map((item) => `${item.kind}/${item.name}`));
  const members = (await store.listApplySetMembers(applySet))
    .filter((member) => !keep.has(`${member.kind}/${member.name}`))
    .toSorted(
      (left, right) =>
        MANAGED_RESOURCE_KINDS.indexOf(right.kind) - MANAGED_RESOURCE_KINDS.indexOf(left.kind) ||
        left.name.localeCompare(right.name),
    );
  const items: PruneItem[] = [];
  const closing = new Set<string>();
  for (const member of members) {
    if (member.kind === "Objective") {
      const item = await pruneObjective(store, member, applySet, input);
      if (item.action === "cancel") closing.add(member.name);
      items.push(item);
      continue;
    }
    const reason = await pruneMember(store, member, input, closing);
    items.push(
      reason === undefined
        ? { kind: member.kind, name: member.name, action: "delete" }
        : { kind: member.kind, name: member.name, action: "skip", reason },
    );
  }
  return items;
}

/**
 * Cancels an Objective the input no longer declares; its Tasks, results, and history remain. An
 * Objective that already ended leaves the set unchanged.
 */
async function pruneObjective(
  store: Store,
  member: ResourceManagement,
  applySet: string,
  input: {
    readonly dryRun: boolean;
    readonly cancelObjective?: (id: string, reason: string) => Promise<void>;
  },
): Promise<PruneItem> {
  const objective = await store.getObjective(member.name).catch(() => undefined);
  const forget = async () => {
    if (!input.dryRun) await store.deleteResourceManagement(member.kind, member.name);
  };
  if (objective === undefined || objectiveClosed(objective.status)) {
    await forget();
    return objective?.status === "completed"
      ? {
          kind: member.kind,
          name: member.name,
          action: "skip",
          reason: "already completed; it leaves the set",
        }
      : { kind: member.kind, name: member.name, action: "cancel" };
  }
  if (input.dryRun) return { kind: member.kind, name: member.name, action: "cancel" };
  if (input.cancelObjective === undefined)
    return {
      kind: member.kind,
      name: member.name,
      action: "skip",
      reason: "no Control Plane is running to cancel it",
    };
  try {
    await input.cancelObjective(member.name, `Removed from apply set ${applySet}.`);
  } catch (error) {
    return {
      kind: member.kind,
      name: member.name,
      action: "skip",
      reason: `could not be cancelled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  await forget();
  return { kind: member.kind, name: member.name, action: "cancel" };
}

/** Deletes one member unless something still uses it; returns why it was skipped. */
async function pruneMember(
  store: Store,
  member: ResourceManagement,
  input: {
    readonly dryRun: boolean;
    readonly workerHosts?: () => Promise<readonly WorkerHost[]>;
    readonly credentialVault?: Pick<GatewayCredentialVault, "delete">;
  },
  closing: ReadonlySet<string>,
): Promise<string | undefined> {
  const plan = await planDeletion(store, member.kind, member.name, input.workerHosts, closing);
  if (plan === undefined) {
    // Already gone, for example deleted outside the set; forget the stale record.
    if (!input.dryRun) await store.deleteResourceManagement(member.kind, member.name);
    return undefined;
  }
  const refusal = deletionRefusal(plan);
  if (refusal !== undefined || input.dryRun) return refusal;
  try {
    await applyDeletion(store, plan, input.credentialVault);
    return undefined;
  } catch (error) {
    return `could not be deleted: ${error instanceof Error ? error.message : String(error)}`;
  }
}
