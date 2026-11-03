import { basename, dirname, isAbsolute, relative } from "node:path";
import type { TaskDelivery } from "@supertag/core";
import { loadServicesFile } from "./supertag-yaml.js";

/** Workspace name to checkout path on this machine, from its host services. */
export type LocalCheckouts = Readonly<Record<string, string>>;

/**
 * The checkouts this machine's host services of its local Control Plane declare, when the Control
 * Plane is local. Paths stay on Worker Hosts, so only this machine can say where a branch lives.
 */
export async function localCheckouts(controlPlaneUrl: string): Promise<LocalCheckouts | undefined> {
  let hostname: string;
  try {
    hostname = new URL(controlPlaneUrl).hostname;
  } catch {
    return undefined;
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) return undefined;
  try {
    const file = await loadServicesFile();
    const workspaces: Record<string, string> = {};
    for (const service of file.services)
      if (service.type === "host" && "service" in service.controlPlane)
        Object.assign(workspaces, service.workspaces);
    return Object.keys(workspaces).length > 0 ? workspaces : undefined;
  } catch {
    return undefined;
  }
}

/** True when a Task delivered something a person can look at. */
export function hasDelivery(delivery: TaskDelivery | null | undefined): delivery is TaskDelivery {
  if (!delivery) return false;
  const workspace = delivery.workspace;
  return (
    delivery.patches.length > 0 ||
    delivery.pullRequest !== undefined ||
    delivery.outputs.length > 0 ||
    (workspace !== undefined &&
      workspace.head !== undefined &&
      workspace.delivery === "branch" &&
      workspace.changedFiles !== 0)
  );
}

/** Readable lines for one Task's delivery, with the commands that fetch or inspect it. */
export function formatDelivery(
  delivery: TaskDelivery,
  options: { readonly indent?: string; readonly checkouts?: LocalCheckouts; readonly cwd?: string },
): string[] {
  const indent = options.indent ?? "";
  const lines: string[] = [];
  const workspace = delivery.workspace;
  if (workspace !== undefined && workspace.head !== undefined) {
    const path = options.checkouts?.[workspace.name];
    const files =
      workspace.changedFiles === undefined
        ? ""
        : `, ${workspace.changedFiles} changed file${workspace.changedFiles === 1 ? "" : "s"}`;
    lines.push(
      `${indent}Branch ${workspace.branch} in Workspace ${workspace.name}${path ? ` (${path})` : ""}${files}`,
    );
    if (path !== undefined && workspace.changedFiles !== 0) {
      const within = relative(path, options.cwd ?? process.cwd());
      const inside = within === "" || (!within.startsWith("..") && !isAbsolute(within));
      const git = inside ? "git" : `git -C ${shellWord(path)}`;
      const base = workspace.ref ?? workspace.base?.slice(0, 12) ?? "main";
      lines.push(
        `${indent}  Review:   ${git} diff ${shellWord(base)}...${shellWord(workspace.branch)}`,
        `${indent}  Check out: ${git} switch ${shellWord(workspace.branch)}`,
      );
    }
  }
  for (const patch of delivery.patches)
    lines.push(
      `${indent}Patch ${patch.path}: supertag download artifact ${shellWord(patch.artifactId)} --path ${shellWord(patch.path)} --out ${shellWord(basename(patch.path))}`,
    );
  const pullRequest = delivery.pullRequest;
  if (pullRequest !== undefined) {
    const state =
      pullRequest.state === "ready"
        ? "ready for review"
        : pullRequest.state === "closed"
          ? "closed"
          : "draft";
    lines.push(`${indent}Pull request ${pullRequest.url} (${state})`);
    if (pullRequest.lastError !== undefined)
      lines.push(
        `${indent}  Last update failed: ${pullRequest.lastError}${pullRequest.nextAttemptAt ? `; retrying at ${pullRequest.nextAttemptAt}` : "; not retrying"}`,
      );
  }
  for (const output of delivery.outputs)
    for (const path of output.paths)
      lines.push(
        `${indent}Output ${path}: supertag download artifact ${shellWord(output.artifactId)} --path ${shellWord(path)} --out ${shellWord(basename(path) || basename(dirname(path)))}`,
      );
  return lines;
}

/** One short phrase for a delivery, for timelines. */
export function deliverySummary(delivery: TaskDelivery): string {
  const parts: string[] = [];
  const workspace = delivery.workspace;
  if (workspace?.head !== undefined && workspace.delivery === "branch")
    parts.push(`branch ${workspace.branch}`);
  for (const patch of delivery.patches) parts.push(`patch ${patch.path} (${patch.artifactId})`);
  if (delivery.pullRequest !== undefined) parts.push(`pull request ${delivery.pullRequest.url}`);
  for (const output of delivery.outputs) parts.push(`output ${output.paths.join(", ")}`);
  return parts.join("; ");
}

export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
