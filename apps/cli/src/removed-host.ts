import { rm, stat } from "node:fs/promises";
import { stateDirectory } from "@supertag/store";
import {
  ControlPlaneClient,
  type ControlPlaneTarget,
  resolveControlPlaneTarget,
} from "./control-plane-client.js";
import type { TagResource } from "./control-plane-resources.js";
import {
  hostCredentialPath,
  hostServiceDirectory,
  readStatus,
  runningProcess,
  type ServiceSlot,
} from "./local-state.js";
import { displayPath, SUPERTAG_YAML } from "./supertag-yaml.js";
import type { KnownService } from "./up.js";
import { readWorkerHostCredential, revokeOwnWorkerHostCredential } from "./worker-hosts.js";

/** Host services with state on this machine that supertag.yaml no longer names. */
export function removedHosts(known: readonly KnownService[]): readonly KnownService[] {
  return known.filter((entry) => entry.service === undefined && entry.slot.kind === "host");
}

/** What `supertag up` prints for a host service that supertag.yaml no longer names. */
export async function removedHostNote(slot: ServiceSlot): Promise<string> {
  const running = (await runningProcess(slot)).pid !== undefined;
  return `Host service ${slot.service} is no longer in ${SUPERTAG_YAML}${running ? " but still runs" : ""}. Remove it with supertag down ${slot.service}: that stops it, removes its service unit, and revokes its Worker Host and unbinds it from Tags.`;
}

/**
 * Finishes removing a stopped host service that supertag.yaml no longer names: unbinds its Worker
 * Host from Tags with operator access to its Control Plane, revokes the Worker Host with its own
 * credential, then removes the service's state from this machine. Nothing happens while its
 * process still runs. The state, including the credential, is kept unless the Worker Host was
 * unbound and revoked (or the service has no credential), so that running `supertag down SERVICE`
 * again finishes the removal.
 */
export async function retireRemovedHost(
  slot: ServiceSlot,
  write: (text: string) => void,
  request: typeof fetch = fetch,
): Promise<"removed" | "kept"> {
  if ((await runningProcess(slot)).pid !== undefined) return "kept";
  const directory = hostServiceDirectory(slot.service);
  const path = hostCredentialPath(slot.service);
  const retry = `Run supertag down ${slot.service} again`;
  const keep = (reason: string, then: string): "kept" => {
    write(
      `${reason} Kept host service ${slot.service}'s state (${displayPath(directory)}). ${then}\n`,
    );
    return "kept";
  };
  if (await stat(path).catch(() => undefined)) {
    let credential: Awaited<ReturnType<typeof readWorkerHostCredential>>;
    try {
      credential = await readWorkerHostCredential(path);
    } catch (error) {
      return keep(
        `Could not read host service ${slot.service}'s Worker Host credential (${(error as Error).message}), so its Worker Host was not unbound or revoked.`,
        `Fix ${displayPath(path)}, then ${retry.toLowerCase()}.`,
      );
    }
    const id = credential.workerHostId;
    const url = credential.controlPlane ?? (await readStatus(slot))?.url;
    if (url === undefined)
      return keep(
        `Host service ${slot.service}'s credential does not record its Control Plane, so Worker Host ${id} was not unbound or revoked.`,
        `Unbind it from its Tags and revoke it with supertag revoke worker-host-credential ${id}, then remove that directory.`,
      );
    const operator = await operatorTarget(url);
    if (operator === undefined)
      return keep(
        `No operator access to ${url}, so Worker Host ${id} was not unbound from its Tags or revoked.`,
        `${retry} with operator access to that Control Plane, or have its operator unbind it first.`,
      );
    try {
      for (const tag of await unbindFromTags(operator, id))
        write(`Unbound Worker Host ${id} from Tag ${tag}.\n`);
    } catch (error) {
      return keep(
        `Could not unbind Worker Host ${id} from its Tags (${(error as Error).message}).`,
        `${retry} once its Control Plane at ${url} runs.`,
      );
    }
    try {
      await revokeOwnWorkerHostCredential([id], request, stateDirectory());
      write(`Revoked Worker Host ${id}.\n`);
    } catch (error) {
      return keep(
        `Could not revoke Worker Host ${id} (${(error as Error).message}).`,
        `${retry} once its Control Plane at ${url} runs.`,
      );
    }
  }
  await rm(directory, { recursive: true, force: true });
  write(
    `Removed host service ${slot.service} from this machine (${displayPath(directory)}), since ${SUPERTAG_YAML} no longer names it.\n`,
  );
  return "removed";
}

/** The operator connection, when it points at the given Control Plane. */
async function operatorTarget(url: string): Promise<ControlPlaneTarget | undefined> {
  const target = await resolveControlPlaneTarget().catch(() => undefined);
  if (target === undefined) return undefined;
  const same = (value: string) => value.replace(/\/+$/u, "");
  return same(target.url) === same(url) ? target : undefined;
}

/** Removes a Worker Host from every Tag that lists it; returns those Tags. */
async function unbindFromTags(
  target: ControlPlaneTarget,
  workerHostId: string,
): Promise<readonly string[]> {
  const client = new ControlPlaneClient(target);
  const list = await client.request<{ readonly items: readonly TagResource[] }>("/api/v1/tags");
  const unbound: string[] = [];
  for (const tag of list.items) {
    const name = tag.metadata.name;
    if (name === undefined || !(tag.spec.workerHosts ?? []).includes(workerHostId)) continue;
    await client.request(
      `/api/v1/tags/${encodeURIComponent(name)}/worker-hosts/${encodeURIComponent(workerHostId)}`,
      { method: "DELETE" },
    );
    unbound.push(name);
  }
  return unbound;
}
