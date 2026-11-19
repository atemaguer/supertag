/**
 * Creating a Tag from the desktop's New Tag form: what the connected Worker Hosts can run it
 * on, and the request that creates it with the lead Tag defaults `supertag init` gives.
 */

import {
  type HarnessExecutionProfile,
  HarnessKind,
  HostPhase,
  type Tag,
  type WorkerHostStatus,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { NewTag, TagOptions } from "../../src/tag-admin";
import { harnessName } from "./convert";

/**
 * The runtime actions `supertag init` gives its lead Tag: read and edit files in its Workspace,
 * and schedule its own follow-ups. files:write does not imply files:read.
 */
const NEW_TAG_ACTIONS = ["files:read", "files:write", "schedule:create"];
/** Running commands, which `supertag init` also gives a lead whose host can run them. */
const COMMANDS = "commands:execute";
/**
 * Web access, which a new Tag gets unless the form switched it off: reading web pages, and
 * network access for its commands. Current Codex models run commands only in code mode, which
 * needs it. Cursor has no web fetch tool and runs no Task that may use one.
 */
const WEB = "web:fetch";

/**
 * Whether a host whose harness reports `profile` runs that harness's commands. Codex sandboxes
 * its own; Claude Code runs them in its own sandbox on a host with `command_sandbox`; Claude Code,
 * Cursor, and OpenCode otherwise need the host's opt-in to run them unsandboxed, a
 * local-vm container, or a remote sandbox. As the Control Plane places Tasks.
 */
function runsCommands(kind: HarnessKind, profile: HarnessExecutionProfile | undefined): boolean {
  if (
    kind === HarnessKind.CLAUDE_CODE ||
    kind === HarnessKind.CURSOR ||
    kind === HarnessKind.OPENCODE
  ) {
    return (
      profile !== undefined &&
      (profile.allowUnsandboxedCommands ||
        (kind === HarnessKind.CLAUDE_CODE && profile.commandSandbox) ||
        profile.sharedExecution !== undefined ||
        profile.remoteFileWorkspace)
    );
  }
  return true;
}

/**
 * Whether a host lane runs a Task with an unscoped `web:fetch`. A remote sandbox or local-vm
 * container has no network, and the web tools would run on the host, so it does not.
 */
const runsWeb = (profile: HarnessExecutionProfile | undefined) => !profile?.remoteFileWorkspace;

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

/**
 * The options the current hosts offer: their harnesses, which of those none runs commands for,
 * and their Workspaces. A revoked, removed, or offline host offers nothing.
 */
export function optionsOf(hosts: readonly WorkerHostStatus[]): TagOptions {
  const harnesses: string[] = [];
  const commands: string[] = [];
  const web: string[] = [];
  const workspaces: string[] = [];
  for (const host of hosts) {
    if (
      host.revokedAtMs !== undefined ||
      host.removedAtMs !== undefined ||
      host.phase === HostPhase.OFFLINE ||
      host.phase === HostPhase.REVOKED
    ) {
      continue;
    }
    const kinds: [HarnessKind, HarnessExecutionProfile | undefined][] = [
      ...host.harnesses.map(
        (slot) =>
          [slot.harnessKind, slot.executionProfile] as [
            HarnessKind,
            HarnessExecutionProfile | undefined,
          ],
      ),
      [host.harnessKind, host.executionProfile],
    ];
    for (const [kind, profile] of kinds) {
      if (kind === HarnessKind.UNSPECIFIED) continue;
      harnesses.push(harnessName(kind));
      if (runsCommands(kind, profile)) commands.push(harnessName(kind));
      if (runsWeb(profile)) web.push(harnessName(kind));
    }
    workspaces.push(...host.workspaceIds);
  }
  const offered = sortedUnique(harnesses);
  return {
    harnesses: offered,
    workspaces: sortedUnique(workspaces),
    noCommands: offered.filter((harness) => !commands.includes(harness)),
    noWeb: offered.filter((harness) => !web.includes(harness)),
  };
}

/** The `PutTag` request a new Tag sends; `commands` says whether it may run commands. */
export function putTagRequest(tag: NewTag, commands: boolean) {
  const kind = (HarnessKind as unknown as Record<string, unknown>)[tag.harness.toUpperCase()];
  if (typeof kind !== "number" || kind === HarnessKind.UNSPECIFIED) {
    throw "Choose a harness for the Tag.";
  }
  const name = tag.name?.trim();
  const workspaceId = tag.workspaceId;
  return {
    tagId: tag.tagId,
    ...(name !== undefined && name !== "" && name !== tag.tagId ? { name } : {}),
    harnessKind: kind as HarnessKind,
    allowedActions: [
      ...(commands ? [COMMANDS] : []),
      ...NEW_TAG_ACTIONS,
      ...(tag.webAccess === false || kind === HarnessKind.CURSOR ? [] : [WEB]),
    ],
    ...(workspaceId !== undefined && workspaceId !== ""
      ? {
          workspace: {
            workspaceId,
            baseRef: tag.workspaceRef ?? "",
            baseCommit: tag.workspaceCommit ?? "",
          },
        }
      : {}),
    ...(tag.maxWorkSessions === undefined ? {} : { maxWorkSessions: tag.maxWorkSessions }),
    // Zero creates a new Tag and never replaces an existing one.
    expectedRevision: 0n,
  };
}

/**
 * The branch a new Tag on a local Workspace follows: the one the Workspace's other Tags follow,
 * preferring a lead's. A local Workspace needs a branch or a commit.
 */
export function branchToFollow(tags: readonly Tag[], workspaceId: string): string | undefined {
  let found: { lead: boolean; branch: string } | undefined;
  for (const tag of tags) {
    const workspace = tag.workspace;
    if (
      workspace === undefined ||
      workspace.workspaceId !== workspaceId ||
      workspace.remote !== undefined ||
      workspace.baseRef === ""
    ) {
      continue;
    }
    // As Rust's max_by_key: the last of the highest wins.
    if (found === undefined || tag.lead >= found.lead) {
      found = { lead: tag.lead, branch: workspace.baseRef };
    }
  }
  return found?.branch;
}
