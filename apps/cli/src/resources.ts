import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { TaskDelivery } from "@supertag/core";
import {
  parseApplySetName,
  parseVolumeSource,
  plainCommandText,
  TASK_FINDING_SEVERITIES,
  type TaskFinding,
  taskClaimDeclineNextStep,
  taskFindingLine,
  unsandboxedCommandHoldsOf,
  unsandboxedCommandsReason,
} from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type { ControlPlaneClient } from "./control-plane-client.js";
import {
  formatDelivery,
  hasDelivery,
  type LocalCheckouts,
  localCheckouts,
} from "./delivery-view.js";
import { locationKey } from "./field-management.js";
import { money } from "./money.js";
import { runningCommandText } from "./running-command.js";
import { hostStorageLines, sandboxStorage, UNKNOWN_TASK_STORAGE } from "./storage-durability.js";
import { isSupertagYamlInput, SUPERTAG_YAML } from "./supertag-yaml.js";
import {
  declaredConfiguration,
  isSurfaceProvider,
  parseSurfaceAccountManifest,
  resolveSurfaceSecrets,
  type SecretResolver,
  type SurfaceAccountManifest,
  verifySurfaceAccount,
} from "./surface-account-manifest.js";
import { terminalJson, terminalText } from "./terminal-text.js";
import { workerHarnessNames } from "./worker-harness-names.js";

/** Message the control plane records when an Attempt stops to register a durable wait. */
const DURABLE_WAIT_STOP_MESSAGE = "Execution registered a durable wait";

interface Resource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly spec?: unknown;
  readonly status?: unknown;
}

interface ResourceList {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly items: readonly Resource[];
}

const resources = {
  tag: { path: "tags", mutable: true },
  "permission-set": { path: "permission-sets", mutable: true },
  "context-set": { path: "context-sets", mutable: true },
  role: { path: "roles", mutable: true },
  "surface-account": { path: "surface-accounts", mutable: true },
  "worker-host": { path: "worker-hosts", mutable: false },
  "worker-profile": { path: "worker-profiles", mutable: false },
  task: { path: "tasks", mutable: false },
  session: { path: "sessions", mutable: false },
  volume: { path: "volumes", mutable: true },
  workspace: { path: "workspaces", mutable: true },
  "auth-key": { path: "auth-keys", mutable: false },
  "operator-token": { path: "operator-tokens", mutable: false },
  objective: { path: "objectives", mutable: true },
} as const;

// Manifest kinds use PascalCase; they are not CLI noun aliases.
const manifestResources = new Map(
  Object.entries(resources).map(([noun, descriptor]) => [
    noun
      .split("-")
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(""),
    descriptor,
  ]),
);

export type ResourceCommand = "apply" | "delete" | "describe" | "diff" | "get" | "watch";

export function isResourceCommand(value: string | undefined): value is ResourceCommand {
  return (
    value === "apply" ||
    value === "delete" ||
    value === "describe" ||
    value === "diff" ||
    value === "get" ||
    value === "watch"
  );
}

export async function runResourceCommand(
  client: ControlPlaneClient,
  command: ResourceCommand,
  args: readonly string[],
): Promise<string> {
  if (command === "apply" || command === "diff") return runManifestCommand(client, command, args);
  if (command === "delete") return deleteResource(client, args);
  if (command === "watch") return watchResources(client, args);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { output: { type: "string" } },
    strict: true,
  });
  const output = values.output ?? (command === "describe" ? "text" : "json");
  if (output !== "json" && output !== "text" && output !== "yaml")
    throw new Error("--output must be json, text, or yaml");
  if (command !== "describe" && output === "text")
    throw new Error("Text output is available for describe; get returns JSON or YAML");
  if (command !== "get" && output === "yaml") throw new Error("YAML output is available for get");
  const [kind, name, ...rest] = positionals;
  if (rest.length > 0 || kind === undefined)
    throw new Error(`Usage: supertag ${command} KIND [NAME]`);
  const descriptor = descriptorFor(kind);
  if (output === "yaml") {
    if (!(descriptor.path in APPLY_ORDER))
      throw new Error(
        "YAML manifests are available for volume, workspace, surface, tag, role, permission-set, context-set, and objective",
      );
    if (descriptor.path === "objectives" && name === undefined)
      throw new Error("Usage: supertag get objective ID --output yaml");
    if (name !== undefined) {
      const resource = await client.request<Resource>(
        `/api/v1/${descriptor.path}/${encodeURIComponent(name)}`,
      );
      if (descriptor.path === "surface-accounts" && !declaredByManifest(resource))
        throw new Error(
          `Surface Account ${name} was set up with supertag setup surface, so it has no manifest or secret references to export. To manage it declaratively, write a SurfaceAccount manifest for the same provider account and apply it; apply adopts the account once its credentials verify.`,
        );
      return exportManifest(resource);
    }
    // Built-in Roles exist on every Control Plane, and interactively set up Surface Accounts
    // have no secret references, so a listing exports only resources a manifest can reproduce.
    const list = await client.request<ResourceList>(`/api/v1/${descriptor.path}`);
    return list.items
      .filter((item) => !(isRecord(item.status) && item.status["builtIn"] === true))
      .filter((item) => item.kind !== "SurfaceAccount" || declaredByManifest(item))
      .map(exportManifest)
      .join("---\n");
  }
  const resource =
    name === undefined
      ? await client.request<ResourceList>(`/api/v1/${descriptor.path}`)
      : await client.request<Resource>(`/api/v1/${descriptor.path}/${encodeURIComponent(name)}`);
  if (command === "describe" && output === "text" && name !== undefined && "kind" in resource) {
    if (resource.kind === "Task") {
      const tagId = isRecord(resource.spec) ? resource.spec["tagId"] : undefined;
      const tags = await client.request<ResourceList>("/api/v1/tags").catch(() => undefined);
      // Keep unresolved Tag IDs out of the human-readable description.
      const tagName = (Array.isArray(tags?.items) ? tags.items : []).find(
        (item) => isRecord(item?.metadata) && item.metadata["id"] === tagId,
      )?.metadata["name"];
      const url = (client as { readonly url?: string }).url;
      const checkouts = url === undefined ? undefined : await localCheckouts(url);
      const tagNames = new Map<string, string>();
      for (const item of Array.isArray(tags?.items) ? tags.items : [])
        if (
          isRecord(item?.metadata) &&
          typeof item.metadata["id"] === "string" &&
          typeof item.metadata["name"] === "string"
        )
          tagNames.set(item.metadata["id"], item.metadata["name"]);
      return describeTask(resource, {
        tagNames,
        ...(typeof tagName === "string" ? { tagName } : {}),
        ...(checkouts === undefined ? {} : { checkouts }),
      });
    }
    if (resource.kind === "WorkerHost") return describeWorkerHost(resource);
    if (resource.kind === "Tag") return describeTag(resource);
    if (resource.kind === "Workspace") return describeWorkspace(resource, Date.now());
    if (resource.kind === "Volume") return describeVolume(resource);
    if (resource.kind === "Session") {
      const states = await client.request<{ states: readonly Record<string, unknown>[] }>(
        `/api/v1/sessions/${encodeURIComponent(name)}/states`,
      );
      const tagId = isRecord(resource.spec) ? resource.spec["tagId"] : undefined;
      const tags = await client.request<ResourceList>("/api/v1/tags").catch(() => undefined);
      const tagName = (Array.isArray(tags?.items) ? tags.items : []).find(
        (item) => isRecord(item?.metadata) && item.metadata["id"] === tagId,
      )?.metadata["name"];
      return describeSession(
        resource,
        states.states,
        typeof tagName === "string" ? tagName : undefined,
      );
    }
  }
  return terminalJson(
    resource,
    output === "text" || (values.output === undefined && process.stdout.isTTY === true),
  );
}

interface ResourceDeletion {
  readonly dryRun: boolean;
  readonly action: "retire" | "delete";
  readonly removed: readonly string[];
  readonly notes: readonly string[];
}

const DELETE_USAGE =
  "Usage: supertag delete tag|role|permission-set|context-set|volume|workspace|surface NAME [--dry-run]";

/**
 * Deletes one configuration resource. The API Server refuses a resource that is still in use and
 * names every reference; `--dry-run` asks it for the same answer without changing anything.
 */
async function deleteResource(
  client: ControlPlaneClient,
  args: readonly string[],
): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" } },
    strict: true,
  });
  const [kind, name, ...rest] = positionals;
  if (kind === undefined || name === undefined || rest.length > 0) throw new Error(DELETE_USAGE);
  const descriptor = descriptorFor(kind);
  if (descriptor.path === "objectives")
    throw new Error(
      `Objectives are cancelled, not deleted, so their history stays: supertag cancel objective ${name}`,
    );
  if (!(descriptor.path in APPLY_ORDER) || !(descriptor.path in DELETE_LABELS))
    throw new Error(`${kind} cannot be deleted. ${DELETE_USAGE}`);
  const dryRun = values["dry-run"] === true;
  const result = await client.request<ResourceDeletion>(
    `/api/v1/${descriptor.path}/${encodeURIComponent(name)}${dryRun ? "?dryRun=true" : ""}`,
    { method: "DELETE" },
  );
  const label = `${DELETE_LABELS[descriptor.path] ?? kind} ${name}`;
  const verb = result.action === "retire" ? "retired" : "deleted";
  const lines = [
    dryRun
      ? `Dry run: ${label} would be ${verb}. Nothing was changed.`
      : `${label} ${verb}.${result.action === "retire" ? " Its history is kept." : ""}`,
  ];
  if (result.removed.length > 0)
    lines.push(
      dryRun ? "Would remove with it:" : "Removed with it:",
      ...result.removed.map((item) => `  ${item}`),
    );
  lines.push(...result.notes);
  return `${lines.map(terminalText).join("\n")}\n`;
}

const DELETE_LABELS: Readonly<Record<string, string>> = {
  "surface-accounts": "Surface Account",
  tags: "Tag",
  roles: "Role",
  "permission-sets": "Permission Set",
  "context-sets": "Context Set",
  volumes: "Volume",
  workspaces: "Workspace",
};

/** A readable view of stored observations; get remains the machine-readable resource. */
/** Open findings by severity, highest first; nothing when the Task has none open. */
export function describeOpenFindings(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (typeof value["unreadable"] === "string")
    return [`Open findings: unreadable (${value["unreadable"]})`];
  const groups = TASK_FINDING_SEVERITIES.map((severity) => ({
    severity,
    findings: (Array.isArray(value[severity]) ? value[severity] : []) as TaskFinding[],
  })).filter((group) => group.findings.length > 0);
  if (!groups.length) return [];
  return [
    `Open findings: ${groups.map((group) => `${group.findings.length} ${group.severity}`).join(", ")}`,
    ...groups.flatMap((group) => group.findings.map((finding) => `  ${taskFindingLine(finding)}`)),
  ];
}

/** The findings a re-review confirms fixed and, once accepted, what closing each one did. */
export function describeFindingClosures(fixed: unknown, closures: unknown): string[] {
  const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
  const reference = (item: Record<string, unknown>) =>
    `${String(item["taskId"])} ${String(item["findingId"])}`;
  const outcomes = records(closures);
  if (outcomes.length)
    return [
      "Finding closures:",
      ...outcomes.map(
        (item) =>
          `  ${reference(item)}: ${String(item["outcome"])}${
            typeof item["reason"] === "string" ? ` (${item["reason"]})` : ""
          }`,
      ),
    ];
  const confirmed = records(fixed);
  if (!confirmed.length) return [];
  return [
    "Confirms fixed (accepting closes these findings):",
    ...confirmed.map((item) => `  ${reference(item)}`),
  ];
}

/** Team posts and direct messages a Task received mid-Attempt as live input. */
function describeTeamInput(
  value: unknown,
  tagNames: ReadonlyMap<string, string> | undefined,
): string[] {
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  if (items.length === 0) return [];
  return [
    "Team coordination received mid-Attempt:",
    ...items.map((item) => {
      const sender = String(item["senderTagId"]);
      const kind = item["itemKind"] === "post" ? "post" : "direct message";
      return `  ${String(item["at"])}  ${String(item["itemType"])} ${kind} ${String(item["itemId"])} from ${tagNames?.get(sender) ?? sender}${item["status"] === "accepted" ? "" : item["status"] === "revoked" ? " (revoked; not delivered)" : item["status"] === "withdrawn" ? " (withdrawn: not read before the final response; the next digest carries it)" : " (uncertain; the next digest carries it)"}${item["truncated"] === true ? " (cut; read the rest with read_mailbox or read_workstream)" : ""}`;
    }),
  ];
}

export function describeTask(
  resource: Resource,
  context: {
    readonly tagName?: string;
    readonly checkouts?: LocalCheckouts;
    readonly tagNames?: ReadonlyMap<string, string>;
  } = {},
): string {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const status = isRecord(resource.status) ? resource.status : {};
  const assignment = isRecord(status["assignment"]) ? status["assignment"] : undefined;
  const attempt = isRecord(status["attempt"]) ? status["attempt"] : undefined;
  const id = String(resource.metadata["id"]);
  const lines = [
    `Task: ${id}`,
    `Phase: ${String(status["phase"])}`,
    `Tag: ${context.tagName ?? "unknown Tag"}`,
    `Session: ${String(spec["sessionId"])}`,
  ];
  if (isRecord(status["execution"]))
    lines.push(...describeTaskExecution(status["execution"], context));
  if (isRecord(spec["workspace"]))
    lines.push(
      `Workspace: ${String(spec["workspace"]["name"])} (branch ${String(spec["workspace"]["branch"])}, delivery ${String(spec["workspace"]["delivery"])})`,
    );
  const prepared = isRecord(status["preparedWorkspace"]) ? status["preparedWorkspace"] : undefined;
  if (
    prepared &&
    typeof prepared["digest"] === "string" &&
    typeof prepared["provider"] === "string"
  )
    lines.push(
      `Environment: ${prepared["provider"]}, prepared ${prepared["provider"] === "local" ? `per Task (${shortDigest(prepared["digest"])})` : shortDigest(prepared["digest"])}${typeof prepared["trustedCommit"] === "string" ? `, trusted commit ${prepared["trustedCommit"].slice(0, 7)}` : ""}`,
    );
  const delivery = isRecord(status["delivery"])
    ? (status["delivery"] as unknown as TaskDelivery)
    : undefined;
  if (hasDelivery(delivery))
    lines.push(
      "Delivered:",
      ...formatDelivery(delivery, {
        indent: "  ",
        ...(context.checkouts === undefined ? {} : { checkouts: context.checkouts }),
      }),
    );
  else if (isRecord(status["pullRequest"])) {
    const pullRequest = status["pullRequest"];
    lines.push(
      `Pull request: ${String(pullRequest["repository"])}#${String(pullRequest["number"])} (${String(pullRequest["state"])}) ${String(pullRequest["url"])}`,
    );
  }
  if (
    !hasDelivery(delivery) &&
    isRecord(status["pullRequest"]) &&
    typeof status["pullRequest"]["lastError"] === "string"
  )
    lines.push(
      `Pull request update failed: ${status["pullRequest"]["lastError"]}${
        typeof status["pullRequest"]["nextAttemptAt"] === "string"
          ? ` (retrying at ${status["pullRequest"]["nextAttemptAt"]})`
          : " (not retrying)"
      }`,
    );
  lines.push(...describeTaskStorage(status["storage"], delivery, id));
  lines.push(...describeOpenFindings(status["openFindings"]));
  lines.push(...describeFindingClosures(status["fixedFindings"], status["findingClosures"]));
  const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).join(", ") : "");
  if (assignment) {
    const uncertain = isRecord(assignment["uncertainAttempt"])
      ? assignment["uncertainAttempt"]
      : undefined;
    lines.push(
      `Objective: ${String(assignment["objectiveId"])}`,
      `Team: ${String(assignment["teamId"])}`,
      // An uncertain Task is still running as far as the store knows, but no one is running it.
      `Assignment: ${uncertain ? "uncertain" : String(assignment["phase"])}`,
      `Priority: ${String(assignment["priority"])}`,
    );
    if (assignment["phase"] === "queued") {
      if (assignment["approval"] === "pending") lines.push("Waiting for approval.");
      if (ids(assignment["dependencies"]))
        lines.push(`Requires accepted Tasks: ${ids(assignment["dependencies"])}`);
      lines.push(`Eligible after: ${String(assignment["availableAt"])}`);
    }
    const wait = isRecord(assignment["wait"]) ? assignment["wait"] : undefined;
    if (
      wait &&
      wait["attemptCount"] === assignment["attemptCount"] &&
      (assignment["phase"] === "waiting" || assignment["phase"] === "running")
    ) {
      if (typeof wait["registeredAt"] === "string")
        lines.push(`Waiting since: ${wait["registeredAt"]}`);
      if (typeof wait["reason"] === "string" && wait["reason"])
        lines.push(`Wait reason: ${JSON.stringify(wait["reason"])}`);
      lines.push("Recorded wait conditions:");
      if (ids(wait["acceptedTaskIds"]))
        lines.push(`  Accepted Tasks: ${ids(wait["acceptedTaskIds"])}`);
      if (ids(wait["submittedTaskIds"]))
        lines.push(`  Submitted Tasks: ${ids(wait["submittedTaskIds"])}`);
      if (wait["mailbox"] === true) lines.push("  New mailbox message");
      if (wait["notBefore"]) lines.push(`  Time: ${String(wait["notBefore"])}`);
      if (isRecord(wait["workstreamPosts"]))
        lines.push(
          `  Workstream: ${String(wait["workstreamPosts"]["workstreamId"])} after post ${String(wait["workstreamPosts"]["afterSequence"])}`,
        );
      if (assignment["phase"] === "running")
        lines.push("The wait is registered; execution has not yet settled into waiting.");
    }
    if (uncertain)
      lines.push(
        `Uncertain since: ${String(uncertain["detectedAt"])}`,
        `Attempt ${String(uncertain["attemptId"])} may have executed, so SuperTag will not replay it. It keeps a Worker capacity slot until an operator recovers it.`,
        `Why: ${JSON.stringify(String(uncertain["reason"]))}`,
        `To recover, on Worker Host ${String(uncertain["workerHostId"] ?? "that ran it")}: stop the host service first (supertag down SERVICE), confirm the Attempt's processes and remote executions stopped, then run:`,
        `  ${String(uncertain["recoverCommand"])}`,
        "Then start the host again. The Task fails with its outcome recorded as unknown.",
      );
    else if (assignment["leaseExpiresAt"])
      lines.push(`Execution lease expires: ${String(assignment["leaseExpiresAt"])}`);
    if (
      !uncertain &&
      assignment["phase"] === "running" &&
      typeof assignment["leaseExpiresAt"] === "string" &&
      Date.parse(assignment["leaseExpiresAt"]) <= Date.now()
    )
      lines.push(
        "Execution state: stalled; the recorded execution lease has expired. Recovery or reconciliation is pending. This does not prove execution stopped or that replay is safe.",
      );
  }
  const scheduling = isRecord(status["scheduling"]) ? status["scheduling"] : undefined;
  if (
    scheduling &&
    (assignment?.["phase"] === "queued" || (!assignment && status["phase"] === "pending"))
  ) {
    lines.push(
      `Last scheduling check: ${String(scheduling["status"])} at ${String(scheduling["observedAt"])}`,
    );
    if (scheduling["status"] === "waiting" && isRecord(scheduling["wait"]))
      lines.push(...describeSchedulingWait(scheduling["wait"]));
    if (scheduling["status"] === "incompatible" && typeof scheduling["reason"] === "string")
      lines.push(`Waiting: ${scheduling["reason"]}.`);
    if (ids(scheduling["unmetRequirements"]))
      lines.push(`Unmet requirements: ${ids(scheduling["unmetRequirements"])}`);
    lines.push(...unsandboxedCommandHoldsOf(scheduling).map(unsandboxedCommandsReason));
    if (Array.isArray(scheduling["workspaceRefusals"]))
      for (const refusal of scheduling["workspaceRefusals"])
        if (typeof refusal === "string") lines.push(`Workspace provider refusal: ${refusal}`);
    for (const requirement of Array.isArray(scheduling["unmetRequirements"])
      ? scheduling["unmetRequirements"]
      : [])
      if (typeof requirement === "string" && requirement.startsWith("labels:"))
        lines.push(...describeMissingLabels(requirement.slice("labels:".length).split(",")));
      else if (
        typeof requirement === "string" &&
        requirement.startsWith("workspace.checkout-or-clone:")
      ) {
        const workspace = requirement.slice("workspace.checkout-or-clone:".length);
        lines.push(
          `No connected Worker Host bound to this Tag declares a checkout of Workspace ${workspace}, can clone its source, or has a Workspace environment provider.`,
          "A source Workspace needs a host whose profiles can clone it or start a prepared environment.",
          `Bind such a host, or declare a checkout: supertag connect worklet --workspace ${shellArg(workspace)}=PATH ...`,
        );
      }
  }
  if (!attempt) {
    lines.push("No execution Attempt has been recorded.");
    if (assignment?.["phase"] === "queued" && !scheduling && assignment["approval"] !== "pending")
      lines.push(
        "No scheduling diagnosis is recorded; queue status alone does not identify a capacity or connectivity problem.",
      );
  } else {
    lines.push(`Latest Attempt: ${String(attempt["id"])} (${attemptPhase(attempt)})`);
    // A long command and a hang look alike from events alone; show what the harness says runs.
    const command =
      attempt["phase"] === "running"
        ? runningCommandText(attempt["runningCommand"], Date.now())
        : undefined;
    if (command) lines.push(`Command: ${command}`);
    if (isRecord(attempt["workerProfile"]))
      lines.push(
        `Worker Profile: ${String(attempt["workerProfile"]["id"])}@${String(attempt["workerProfile"]["revision"])}`,
      );
    lines.push(
      `Worker: ${String(attempt["workerId"] ?? "not recorded")}`,
      `Worker Host: ${String(attempt["workerHostId"] ?? "not recorded")}`,
      `Worklet: ${String(attempt["workletId"] ?? "not recorded")}`,
    );
    const selection = isRecord(attempt["selection"]) ? attempt["selection"] : undefined;
    if (selection && ids(selection["allowedWorkerHostIds"]))
      lines.push(`Eligible Worker Hosts: ${ids(selection["allowedWorkerHostIds"])}`);
    const reservation =
      selection && isRecord(selection["reservation"]) ? selection["reservation"] : undefined;
    if (reservation)
      lines.push(
        `Placement reservation: ${String(reservation["phase"])} (expires ${String(reservation["expiresAt"])})`,
      );
    // Registering a durable wait ends the Attempt through cancellation; that is a wait, not a failure.
    if (isRecord(attempt["failure"]) && typeof attempt["failure"]["message"] === "string") {
      if (attempt["failure"]["message"] === DURABLE_WAIT_STOP_MESSAGE)
        lines.push(
          `Attempt ended to wait durably at ${String(attempt["failure"]["at"])}; this is not a failure.`,
        );
      else lines.push(`Recorded failure: ${JSON.stringify(attempt["failure"]["message"])}`);
    }
    // Warnings never change the outcome; they keep non-fatal problems, such as an incomplete
    // native Session archive, visible after an otherwise completed Attempt.
    if (Array.isArray(attempt["warnings"]))
      for (const warning of attempt["warnings"])
        if (isRecord(warning) && typeof warning["message"] === "string")
          lines.push(`Recorded warning: ${JSON.stringify(warning["message"])}`);
    const placement = isRecord(attempt["placement"]) ? attempt["placement"] : undefined;
    const environment = (name: string, value: unknown) => {
      if (isRecord(value))
        lines.push(
          `${name}: ${String(value["id"])} (${String(value["provider"])}, ${String(value["placement"])})`,
        );
      else lines.push(`${name}: not recorded`);
    };
    if (placement) {
      environment("Harness runtime", placement["harnessRuntime"]);
      environment("Tool execution environment", placement["executionEnvironment"]);
      lines.push(`Execution cleanup evidence: ${String(placement["cleanup"])}`);
      const cleanupFailure = isRecord(placement["cleanupFailure"])
        ? placement["cleanupFailure"]
        : undefined;
      if (cleanupFailure) {
        lines.push(
          "Execution state: cleanup is unconfirmed; the recorded phase does not establish current process activity.",
        );
        lines.push(`Recorded cleanup failure at ${String(cleanupFailure["at"])}:`);
        if (Array.isArray(cleanupFailure["items"]))
          for (const item of cleanupFailure["items"])
            if (isRecord(item) && typeof item["text"] === "string")
              lines.push(`  ${JSON.stringify(item["text"])}`);
      } else if (assignment?.["phase"] === "waiting") {
        lines.push(
          placement["cleanup"] === "confirmed"
            ? "Execution state: the assignment is waiting; prior execution cleanup is confirmed."
            : "Execution state: the assignment is waiting, but prior execution cleanup is unconfirmed.",
        );
      } else if (placement["cleanup"] === "confirmed") {
        lines.push("Execution state: a terminal execution event is recorded.");
      } else if (attempt["phase"] === "running") {
        lines.push(
          "Execution state: the Attempt is recorded as running; current process activity is not verified.",
        );
      } else {
        lines.push("Execution state: no terminal cleanup evidence is recorded.");
      }
      if (placement["cleanup"] !== "confirmed")
        lines.push(
          cleanupFailure
            ? "Recorded cleanup failure leaves execution uncertain; it does not prove the process stopped."
            : "No terminal execution event is recorded for this Attempt. Missing evidence does not prove execution stopped.",
        );
    }
    if (
      (status["phase"] === "cancelled" || assignment?.["phase"] === "cancelled") &&
      placement?.["cleanup"] !== "confirmed"
    )
      lines.push(
        "Cancellation is recorded, but execution cleanup is unconfirmed. This does not prove the process stopped or that Worker Host capacity was released.",
      );
    if (
      (status["phase"] === "cancelled" || assignment?.["phase"] === "cancelled") &&
      attempt["phase"] === "running"
    )
      lines.push(
        "This cancelled Task still holds a Worker Host capacity slot. Reconnect the original Worklet so SuperTag can check the Attempt and release the slot if it never started or has stopped. If the outcome remains unknown, verify that all execution stopped, then use supertag recover worklet --confirm-stopped and reconnect the Worklet.",
      );
    if (isRecord(attempt["lastEvent"]))
      lines.push(
        `Last recorded event: ${String(attempt["lastEvent"]["type"])} at ${String(attempt["lastEvent"]["at"])}`,
      );
  }
  lines.push(...describeTeamInput(status["teamInput"], context.tagNames));
  lines.push(...describeTaskAttempts(status["attempts"]));
  lines.push(...describeTaskMounts(status["attempts"]));
  lines.push(...describeTaskWrites(status["attempts"]));
  lines.push(
    "",
    "This view uses stored evidence; it does not contact a Worker Host.",
    `Event history: supertag events task ${shellArg(id)}`,
  );
  if (typeof spec["sessionId"] === "string")
    lines.push(`Session: supertag describe session ${shellArg(spec["sessionId"])}`);
  if (typeof attempt?.["workerHostId"] === "string")
    lines.push(`Host: supertag describe worker-host ${shellArg(attempt["workerHostId"])}`);
  if (assignment?.["phase"] === "queued")
    lines.push(
      "Review bindings: supertag list tag",
      "Review approvals: supertag list inbox --kind task-approval",
    );
  if (assignment?.["phase"] === "waiting")
    lines.push(`Watch stored changes: supertag watch task ${shellArg(id)}`);
  return `${lines.map(terminalText).join("\n")}\n`;
}

/**
 * An Attempt's phase for people: one that ended to wait durably shows "ended to wait" and its
 * recorded reason; "cancelled" stays for real cancellations.
 */
function attemptPhase(attempt: Record<string, unknown>): string {
  const wait = attempt["endedToWait"];
  if (!isRecord(wait)) return String(attempt["phase"]);
  return typeof wait["reason"] === "string"
    ? `ended to wait: ${JSON.stringify(wait["reason"])}`
    : "ended to wait";
}

/**
 * One line per Task Attempt with its provider-reported cost, so the cost of each owner wake or
 * retry is visible. Long histories show the most recent Attempts.
 */
function describeTaskAttempts(value: unknown): string[] {
  const attempts = Array.isArray(value) ? value.filter(isRecord) : [];
  if (attempts.length === 0) return [];
  const costOf = (attempt: Record<string, unknown>) => {
    const cost = attempt["reportedCost"];
    return isRecord(cost) &&
      typeof cost["amountMinor"] === "number" &&
      typeof cost["currency"] === "string"
      ? {
          amountMinor: cost["amountMinor"],
          currency: cost["currency"],
          estimated: cost["estimated"] === true,
        }
      : undefined;
  };
  const totals = new Map<string, number>();
  let unknown = 0;
  for (const attempt of attempts) {
    const cost = costOf(attempt);
    if (cost) totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amountMinor);
    else unknown++;
  }
  const total = [...totals].map(([currency, minor]) => money(minor, currency)).join(" + ");
  const shown = attempts.slice(-30);
  return [
    `Task Attempts (${attempts.length}${total ? `, ${total} reported` : ""}${unknown ? `, ${unknown} without a reported cost` : ""}):`,
    ...(attempts.length > shown.length
      ? [`  ${attempts.length - shown.length} earlier Task Attempts not shown`]
      : []),
    ...shown.map((attempt) => {
      const cost = costOf(attempt);
      const shownCost = cost
        ? `${money(cost.amountMinor, cost.currency)}${cost.estimated ? " (estimated)" : ""}`
        : "cost not reported";
      return `  ${String(attempt["number"])}. ${String(attempt["id"])} ${attemptPhase(attempt)}, started ${String(attempt["startedAt"])}, ${shownCost}`;
    }),
  ];
}

/** Most objects of each `copy` mount `describe task` lists. */
const DESCRIBED_MOUNT_OBJECTS = 20;

/**
 * Each Attempt's live attachments and copied content: one line per mount and a copy's first
 * objects. A mount whose digest differs from the earliest earlier Attempt that copied the same
 * path is marked changed. Paths, keys, and ETags are Worker-reported, so they are cleaned first.
 */
function describeTaskMounts(value: unknown): string[] {
  const attempts = (Array.isArray(value) ? value.filter(isRecord) : []).flatMap((attempt) => {
    const manifests = Array.isArray(attempt["mountManifests"])
      ? attempt["mountManifests"].filter(
          (manifest): manifest is Record<string, unknown> =>
            isRecord(manifest) && typeof manifest["path"] === "string",
        )
      : [];
    const liveMounts = Array.isArray(attempt["liveMounts"])
      ? attempt["liveMounts"].filter(isRecord)
      : [];
    return manifests.length === 0 && liveMounts.length === 0
      ? []
      : [{ number: Number(attempt["number"]), manifests, liveMounts }];
  });
  attempts.sort((left, right) => left.number - right.number);
  const lines: string[] = [];
  for (const attempt of attempts.slice(-30)) {
    lines.push(`Mounts (Attempt ${attempt.number}):`);
    for (const mount of attempt.liveMounts) {
      lines.push(
        `  ${plainText(mount["volume"], 63)}  ${plainText(mount["path"], 200)}  mount ${plainText(mount["access"], 16)}  live`,
        `    source ${plainText(mount["source"], 4096)}`,
        `    prefix ${mount["prefix"] === "" ? "(entire source)" : plainText(mount["prefix"], 4096)}`,
        `    attached ${plainText(mount["attachedAt"], 64)}`,
      );
    }
    for (const manifest of attempt.manifests) {
      const path = String(manifest["path"]);
      const earlier = attempts.find(
        (candidate) =>
          candidate.number < attempt.number &&
          candidate.manifests.some((entry) => entry["path"] === path),
      );
      const earliest = earlier?.manifests.find((entry) => entry["path"] === path);
      const changed =
        earlier !== undefined && earliest?.["digest"] !== manifest["digest"]
          ? ` (changed since Attempt ${earlier.number})`
          : "";
      const objects = Array.isArray(manifest["objects"])
        ? manifest["objects"].filter(isRecord)
        : [];
      const count = typeof manifest["objectCount"] === "number" ? manifest["objectCount"] : 0;
      lines.push(
        `  ${plainText(manifest["volume"], 63)}  ${plainText(path, 200)}  ${plainText(manifest["strategy"], 16)} ${plainText(manifest["access"], 16)}  ${count} ${count === 1 ? "object" : "objects"}, ${byteText(manifest["totalBytes"])}  ${mountDigestText(manifest["digest"])}${changed}`,
      );
      const shown = objects.slice(0, DESCRIBED_MOUNT_OBJECTS);
      for (const object of shown) {
        const version = [
          typeof object["etag"] === "string" ? `etag ${plainText(object["etag"], 40)}` : "",
          typeof object["versionId"] === "string"
            ? `version ${plainText(object["versionId"], 40)}`
            : "",
          typeof object["sha256"] === "string" ? mountDigestText(object["sha256"]) : "",
        ].filter(Boolean);
        lines.push(
          `    ${[plainText(object["key"], 200), byteText(object["size"]), ...version].join("  ")}`,
        );
      }
      if (count > shown.length) lines.push(`    … ${count - shown.length} more objects`);
    }
  }
  return lines;
}

function describeTaskWrites(value: unknown): string[] {
  const lines: string[] = [];
  for (const attempt of Array.isArray(value) ? value.filter(isRecord) : []) {
    const manifests = Array.isArray(attempt["mountOutputManifests"])
      ? attempt["mountOutputManifests"].filter(isRecord)
      : [];
    if (manifests.length === 0) continue;
    lines.push(`Writes (Attempt ${String(attempt["number"])}):`);
    for (const manifest of manifests) {
      const objects = Array.isArray(manifest["objects"])
        ? manifest["objects"].filter(isRecord)
        : [];
      const bytes = objects.reduce(
        (sum, object) => sum + (typeof object["size"] === "number" ? object["size"] : 0),
        0,
      );
      lines.push(
        `  ${plainText(manifest["volume"], 63)}  ${plainText(manifest["path"], 200)}  ${plainText(manifest["status"], 16)}  ${objects.length} files, ${byteText(bytes)}; ${String(manifest["skipped"])} skipped`,
      );
      for (const object of objects)
        lines.push(
          `    ${plainText(object["key"], 200)}  ${byteText(object["size"])}  sha256 ${plainText(object["sha256"], 64)}`,
        );
      if (isRecord(manifest["error"]))
        lines.push(
          `    error ${plainText(manifest["error"]["key"], 200)}: ${plainText(manifest["error"]["reason"], 1024)}`,
        );
      const remaining = Array.isArray(manifest["notAttempted"]) ? manifest["notAttempted"] : [];
      if (remaining.length)
        lines.push(`    notAttempted: ${remaining.map((key) => plainText(key, 200)).join(", ")}`);
    }
  }
  return lines;
}

/**
 * Where the Task's files, delivered branch, outputs, and artifacts live, from the Task view's
 * `storage`. A copy held only on an ephemeral Worker Host is flagged: it is lost if the host stops.
 */
function describeTaskStorage(
  value: unknown,
  delivery: TaskDelivery | undefined,
  taskId: string,
): string[] {
  if (!isRecord(value)) return [];
  const lines: string[] = [];
  const host = (id: unknown, ephemeral: boolean) =>
    `Worker Host ${plainText(id, 200)} (${ephemeral ? "ephemeral" : "persistent"})`;
  const files = isRecord(value["taskFiles"]) ? value["taskFiles"] : undefined;
  if (files) {
    const ephemeral = files["ephemeral"] === true;
    if (files["placementUnknown"] === true)
      lines.push(
        `  Task files: placement not recorded for ${host(files["workerHostId"], ephemeral)}. ${UNKNOWN_TASK_STORAGE}`,
      );
    else if (typeof files["sandbox"] === "string")
      lines.push(
        `  Task files: a ${plainText(files["sandbox"], 63)} sandbox from ${host(files["workerHostId"], ephemeral)}; ephemeral, lost when the sandbox stops`,
      );
    else
      lines.push(
        `  Task files: ${host(files["workerHostId"], ephemeral)}${ephemeral ? "; lost if it stops" : ""}`,
      );
    const workspace = delivery?.workspace;
    if (
      workspace?.head !== undefined &&
      workspace.delivery === "branch" &&
      typeof files["sandbox"] !== "string" &&
      files["placementUnknown"] !== true
    )
      lines.push(
        `  Branch ${plainText(workspace.branch, 200)}: the Workspace checkout on ${host(files["workerHostId"], ephemeral)}${ephemeral ? "; lost if it stops" : ""}`,
      );
  }
  if (delivery?.pullRequest !== undefined)
    lines.push(`  Pull request ${plainText(delivery.pullRequest.url, 400)}: the git remote`);
  const outputs = new Set((delivery?.outputs ?? []).map((output) => output.artifactId));
  const artifacts = Array.isArray(value["artifacts"]) ? value["artifacts"].filter(isRecord) : [];
  for (const artifact of artifacts) {
    const locations = Array.isArray(artifact["locations"])
      ? artifact["locations"].filter(isRecord)
      : [];
    const places = locations.map((location) =>
      location["kind"] === "volume"
        ? `Volume ${plainText(location["volume"], 200)}`
        : location["removed"] === true
          ? `Worker Host ${plainText(location["workerHostId"], 200)} (removed; its copy is gone)`
          : host(location["workerHostId"], location["ephemeral"] === true),
    );
    const count = typeof artifact["files"] === "number" ? artifact["files"] : 0;
    lines.push(
      `  ${outputs.has(String(artifact["artifactId"])) ? "Output" : "Artifact"} ${plainText(artifact["artifactId"], 200)} ${JSON.stringify(plainText(artifact["title"], 120))} (${count} ${count === 1 ? "file" : "files"}): ${places.length > 0 ? places.join(", ") : "no recorded copy"}`,
    );
    if (artifact["ephemeralOnly"] === true)
      lines.push(
        "    Ephemeral storage risk: no durable copy recorded; files may be lost when the producing Worker Host stops, or already unavailable. The Control Plane keeps no copy; a persistent Worker Host or a Volume would keep one.",
      );
  }
  if (value["moreArtifacts"] === true)
    lines.push(`  More artifacts are not shown: supertag list artifact --task ${shellArg(taskId)}`);
  return lines.length > 0 ? ["Storage:", ...lines] : [];
}

function plainText(value: unknown, maximum: number): string {
  return plainCommandText(String(value), maximum) || "(none)";
}

/** `1024 B`, `12.0 KiB`, `3.5 MiB`. */
function byteText(value: unknown): string {
  const bytes = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

/** `sha256:4f1c0e2a1b2c`: enough of a digest to tell two apart at a glance. */
function mountDigestText(value: unknown): string {
  return typeof value === "string" && /^sha256:[a-f0-9]{12}/u.test(value)
    ? value.slice(0, "sha256:".length + 12)
    : "digest unknown";
}

/** The Task's resolved harness, model, and effort, why it has them, and what its Attempt ran. */
export function describeTaskExecution(
  execution: Record<string, unknown>,
  context: { readonly tagNames?: ReadonlyMap<string, string> },
): string[] {
  const parts = [
    typeof execution["harness"] === "string" ? execution["harness"] : "any harness",
    `model ${typeof execution["model"] === "string" ? execution["model"] : "the host default"}`,
    `effort ${typeof execution["effort"] === "string" ? execution["effort"] : "the harness default"}`,
  ];
  const chooser =
    typeof execution["chosenByTagId"] === "string"
      ? (context.tagNames?.get(execution["chosenByTagId"]) ?? "unknown Tag")
      : "the delegating actor";
  const why =
    execution["source"] === "chosen"
      ? `chosen by ${chooser}`
      : execution["source"] === "escalated"
        ? typeof execution["escalation"] === "string"
          ? `escalated: ${execution["escalation"]} after Task ${String(execution["escalatedFromTaskId"])} failed or was rejected`
          : `escalation found nothing higher in the allowed range after Task ${String(execution["escalatedFromTaskId"])}`
        : execution["source"] === "default"
          ? "default"
          : undefined;
  const escalations = Array.isArray(execution["selfEscalations"])
    ? execution["selfEscalations"].filter(isRecord)
    : [];
  const shownWhy = escalations.length === 0 ? why : `${why ?? "accepted"}, then self-escalated`;
  const lines =
    execution["source"] === undefined &&
    execution["harness"] === undefined &&
    escalations.length === 0
      ? []
      : [`Execution: ${parts.join(", ")}${shownWhy === undefined ? "" : ` (${shownWhy})`}`];
  for (const escalation of escalations) {
    const by =
      typeof escalation["byTagId"] === "string"
        ? (context.tagNames?.get(escalation["byTagId"]) ?? "unknown Tag")
        : "the assignee";
    lines.push(
      `Escalated by ${by}: ${show(escalation["change"])}${
        typeof escalation["reason"] === "string" ? `: ${escalation["reason"]}` : ""
      }`,
    );
  }
  const attempt = isRecord(execution["latestAttempt"]) ? execution["latestAttempt"] : undefined;
  if (attempt) {
    lines.push(
      `Latest Attempt ran: ${show(attempt["harness"])}, model ${
        typeof attempt["model"] === "string"
          ? `${attempt["model"]}${attempt["modelSource"] === "host-default" ? " (host default)" : ""}`
          : "the harness default"
      }${typeof attempt["effort"] === "string" ? `, effort ${attempt["effort"]}` : ""}`,
    );
    if (typeof attempt["effortIgnored"] === "string") lines.push(`  ${attempt["effortIgnored"]}`);
  }
  return lines;
}

/** Explains a `labels:A,B` hold and how to satisfy each kind of label. */
/**
 * Why a queued Task has not started: dependencies not yet accepted, every matching Worker
 * busy, none connected, or a declined claim with its cause.
 */
function describeSchedulingWait(wait: Record<string, unknown>): string[] {
  if (wait["reason"] === "claim") {
    const claim = isRecord(wait["claim"]) ? wait["claim"] : {};
    return [
      `Not started: ${typeof claim["message"] === "string" ? claim["message"] : "the Control Plane declined to start the Task."}`,
      taskClaimDeclineNextStep(typeof claim["code"] === "string" ? claim["code"] : ""),
    ];
  }
  if (wait["reason"] === "dependencies") {
    const dependencies = Array.isArray(wait["dependencies"])
      ? wait["dependencies"].filter(isRecord)
      : [];
    return [
      `Waiting for ${dependencies
        .map(
          (dependency) =>
            `${String(dependency["taskId"])} (${typeof dependency["status"] === "string" ? dependency["status"] : "unavailable"})`,
        )
        .join(", ")}.`,
      "The Task is not offered to a Worker until each dependency is accepted.",
    ];
  }
  if (wait["reason"] !== "capacity")
    return [
      "Waiting for a Worker Host: no eligible host has a matching Worker connected. The Task starts when one connects.",
    ];
  const lines: string[] = [];
  let spare = false;
  for (const host of Array.isArray(wait["hosts"]) ? wait["hosts"].filter(isRecord) : []) {
    const harnesses = Array.isArray(host["harnesses"]) ? host["harnesses"].map(String) : [];
    const busy = Array.isArray(host["busyTaskIds"]) ? host["busyTaskIds"].map(String) : [];
    const capacity = typeof host["capacity"] === "number" ? host["capacity"] : 0;
    if (busy.length < capacity) spare = true;
    lines.push(
      `Waiting for a free ${harnesses.length ? harnesses.join(" or ") : "Worker"} slot on Worker Host ${String(host["workerHostId"])} (${busy.length} of ${capacity} busy${busy.length ? `: ${busy.join(", ")}` : ""})`,
    );
  }
  if (spare)
    lines.push(
      "Slots not held by a running Attempt may be reserved for a starting Attempt, or the host may be draining.",
    );
  lines.push(
    "The Task starts when a slot frees. To run more at once, raise concurrency for the host service in supertag.yaml, or pass --concurrency to supertag connect worklet.",
  );
  return lines;
}

function describeMissingLabels(labels: readonly string[]): string[] {
  const lines = [`No bound Worker Host has labels: ${labels.join(", ")}.`];
  const custom: string[] = [];
  for (const label of labels) {
    if (label.startsWith("workspace:")) {
      const workspace = label.slice("workspace:".length);
      lines.push(
        `Declare a checkout: supertag connect worklet --workspace ${shellArg(workspace)}=PATH ...`,
      );
    } else if (label.startsWith("mcp:")) {
      const server = label.slice("mcp:".length);
      lines.push(
        `No bound Worker Host provides MCP server ${server}. Add it to a host service's mcp map in supertag.yaml, such as ${server}: { url: https://... }, then run supertag up.`,
      );
    } else if (label.startsWith("harness:"))
      lines.push(
        `Run that harness: supertag connect worklet --harness ${shellArg(label.slice("harness:".length))} ...`,
      );
    else if (["linux", "macos", "windows", "x64", "arm64"].includes(label))
      lines.push(`Connect a Worker Host on ${label} and bind it to this Tag.`);
    else custom.push(label);
  }
  if (custom.length > 0)
    lines.push(
      `Add labels to a bound host: supertag connect worklet ${custom.map((label) => `--label ${shellArg(label)}`).join(" ")} ...`,
      "Or change the Tag's runsOn labels in its manifest and apply it.",
    );
  return lines;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function show(value: unknown): string {
  return value === undefined || value === null ? "not recorded" : String(value);
}
function list(value: unknown): string {
  return Array.isArray(value) && value.length ? value.map(show).join(", ") : "none recorded";
}
/** The negotiated Worklet protocol versions, which Worklets and the Control Plane check. */
function workletProtocol(status: Record<string, unknown>): string {
  if (status["protocolVersion"] === undefined) return "not recorded";
  return [
    `v${show(status["protocolVersion"])}`,
    ...(status["durableProtocolVersion"] === undefined
      ? []
      : [`durable v${show(status["durableProtocolVersion"])}`]),
    ...(status["controlProtocolVersion"] === undefined
      ? []
      : [`control v${show(status["controlProtocolVersion"])}`]),
  ].join(", ");
}
function describeWorkerHost(resource: Resource): string {
  const status = isRecord(resource.status) ? resource.status : {};
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const lines = [
    `Worker Host: ${show(resource.metadata["id"])}`,
    `Recorded phase: ${show(status["phase"])}`,
    `Recorded connection: ${show(status["connectionStatus"])}`,
    `Last seen: ${show(status["lastSeenAt"])}`,
    `Draining: ${show(spec["draining"])}`,
    `Recorded capacity: ${show(status["capacity"])}`,
    `Recorded available slots: ${show(status["availableSlots"])}`,
    `Recorded active Attempts: ${show(status["activeAttempts"])}`,
    `Worklet: ${show(status["workletId"])}`,
    `Worklet protocol: ${workletProtocol(status)}`,
    `Labels: ${list(status["labels"])}`,
  ];
  if (Array.isArray(status["grantedLabels"]) && status["grantedLabels"].length > 0)
    lines.push(`Granted by Auth Key ${show(status["authKey"])}: ${list(status["grantedLabels"])}`);
  const evidence = isRecord(status["storage"]) ? status["storage"] : undefined;
  const storage = hostStorageLines({ ephemeral: status["ephemeral"] === true });
  if (Array.isArray(evidence?.["sandboxes"]))
    for (const provider of evidence["sandboxes"])
      if (typeof provider === "string") storage.push(sandboxStorage(plainText(provider, 63)));
  if (evidence?.["placementUnknown"] !== false) storage.push(UNKNOWN_TASK_STORAGE);
  lines.push(...(storage.length > 0 ? storage : ["Storage: persistent"]));
  if (Array.isArray(status["workers"]))
    for (const worker of status["workers"])
      if (isRecord(worker)) {
        lines.push(`Worker: ${show(worker["id"])} (${workerHarnessNames(worker).join(", ")})`);
        if (Array.isArray(worker["profiles"]))
          for (const profile of worker["profiles"])
            if (isRecord(profile))
              lines.push(`  Profile: ${show(profile["id"])}@${show(profile["revision"])}`);
        if (Array.isArray(worker["profileCapabilities"]))
          for (const support of worker["profileCapabilities"])
            if (isRecord(support) && typeof support["harness"] === "string")
              lines.push(
                `  Serves ${support["harness"]}: models ${
                  Array.isArray(support["models"]) && support["models"].length > 0
                    ? list(support["models"])
                    : "not advertised (Tasks that name a model run elsewhere)"
                }; effort ${
                  Array.isArray(support["efforts"]) && support["efforts"].length > 0
                    ? list(support["efforts"])
                    : "ignored"
                }`,
              );
      }
  lines.push(
    "",
    "Stored observations only; current Host reachability and free capacity are not verified.",
    "Labels place work only. Host-declared labels are self-reported and never grant access.",
  );
  return `${lines.map(terminalText).join("\n")}\n`;
}
function describeTag(resource: Resource): string {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const status = isRecord(resource.status) ? resource.status : {};
  const lines = [
    `Tag: ${show(resource.metadata["name"])}`,
    `ID: ${show(resource.metadata["id"])}`,
    `Phase: ${show(status["phase"])}`,
  ];
  if (status["phase"] === "retired") {
    lines.push(
      `Retired: ${show(status["retiredAt"])}`,
      "A retired Tag receives no work. Its Tasks, Sessions, and approvals remain in history.",
    );
    return `${lines.map(terminalText).join("\n")}\n`;
  }
  lines.push(
    `Roles: ${list(spec["roles"])}`,
    `Bound Worker Hosts: ${list(spec["workerHosts"])}`,
    `Runs on labels: ${Array.isArray(spec["runsOn"]) && spec["runsOn"].length > 0 ? list(spec["runsOn"]) : "any bound Worker Host"}`,
    `Execution: ${describeExecution(status["execution"])}`,
  );
  if (Array.isArray(spec["workerHosts"]) && spec["workerHosts"].length === 0)
    lines.push(
      "No Worker Host is bound; bind an enrolled Host before submitting work.",
      `Bind a Host: supertag update tag ${shellArg(String(resource.metadata["name"]))} --add-worker-host HOST`,
    );
  if (Array.isArray(spec["workerHosts"]))
    for (const host of spec["workerHosts"])
      if (typeof host === "string")
        lines.push(`Inspect Host: supertag describe worker-host ${shellArg(host)}`);
  const locations = Array.isArray(spec["locations"]) ? spec["locations"].filter(isRecord) : [];
  if (locations.length > 0) lines.push("Locations:");
  for (const location of locations) {
    const scope = ["teamId", "team", "channelId", "chatId", "repoId", "repo"]
      .filter((field) => typeof location[field] === "string")
      .map((field) => `${field} ${show(location[field])}`)
      .join(", ");
    const workspaces = Array.isArray(location["workspaces"]) ? location["workspaces"] : [];
    lines.push(
      `  ${show(location["provider"])} ${scope}: Objectives created here name ${
        workspaces.length > 0
          ? `Workspaces ${list(workspaces)}`
          : location["provider"] === "github"
            ? "Workspaces whose source is this repository"
            : "no Workspace"
      }`,
    );
  }
  lines.push(
    "Bindings are configuration; they do not establish Host availability.",
    "Bindings decide which Hosts may run this Tag's Tasks; runsOn labels only choose among them.",
  );
  return `${lines.map(terminalText).join("\n")}\n`;
}
/** A Tag's allowed range; the first model and effort in each list is the default. */
function describeExecution(value: unknown): string {
  const range = isRecord(value) ? value : {};
  const values = (field: string) =>
    Array.isArray(range[field]) && range[field].length > 0 ? range[field].map(show) : undefined;
  return [
    `harness ${typeof range["harness"] === "string" ? range["harness"] : "any the Worker Host offers"}`,
    `model ${values("model")?.join(", ") ?? "any the Worker Host offers"}`,
    `effort ${values("effort")?.join(", ") ?? "the harness default"}`,
  ].join("; ");
}
/** `sha256:4f1c0e2a`: a prepared digest's first eight hex digits. */
function shortDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice(0, 15) : digest.slice(0, 8);
}

/** A past time relative to `now`: `just now`, `5m ago`, `2h ago`, or `3d ago`. */
function ago(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** A readable Volume: where its data lives and which credential name reaches it. */
export function describeVolume(resource: Resource): string {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const source = show(spec["source"]);
  const lines = [`Volume: ${show(resource.metadata["name"])}`];
  try {
    const location = parseVolumeSource(source);
    lines.push(`Source: ${source}`);
    if (location.scheme === "s3" || location.scheme === "r2") {
      lines.push(`Region: ${location.region ?? (location.scheme === "r2" ? "auto" : "us-east-1")}`);
      lines.push(`Endpoint: ${location.endpoint ?? "AWS S3 (regional default)"}`);
      lines.push(`Force path style: ${location.forcePathStyle ?? false}`);
    } else if (location.scheme === "modal-volume") {
      lines.push("Modal environment: Worker Host configuration");
      lines.push("Access: native mounts only, requiring exact-name host consent");
    } else if (location.scheme === "gs") {
      lines.push("Access: native mounts only, using a provider-held Modal Secret");
    }
  } catch {
    // Older catalog rows may be invalid or contain secrets; never echo their source.
    lines.push(
      "Source: invalid (stored source could not be parsed; apply a valid Volume source URL)",
    );
  }
  if (spec["credential"] === undefined)
    lines.push("Credential: none (no Worker Host copies this Volume)");
  else if (source.startsWith("modal-volume://"))
    lines.push(
      `Credential: ${show(spec["credential"])} (a name; each Worker Host maps it to exact-name modal-volume consent)`,
    );
  else if (source.startsWith("file://"))
    lines.push(
      `Credential: ${show(spec["credential"])} (a name; each Worker Host that maps it consents to exposing this directory)`,
    );
  else
    lines.push(
      `Credential: ${show(spec["credential"])} (a name; each Worker Host that serves this Volume maps it to a secret)`,
    );
  return `${lines.map(terminalText).join("\n")}\n`;
}

export function describeWorkspace(resource: Resource, now: number): string {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const status = isRecord(resource.status) ? resource.status : {};
  const name = show(resource.metadata["name"]);
  const lines = [
    `Workspace: ${name}`,
    `Source: ${spec["source"] === undefined ? "none (checkouts on Worker Hosts only)" : show(spec["source"])}`,
    `Base ref: ${spec["ref"] === undefined ? "the checkout's current branch, else main" : show(spec["ref"])}`,
    `Setup: ${spec["setup"] === undefined ? "none" : show(spec["setup"])}`,
    `Delivery: ${show(spec["delivery"])}`,
  ];
  const mounts = Array.isArray(spec["mounts"]) ? spec["mounts"].filter(isRecord) : [];
  if (mounts.length > 0) {
    lines.push("Mounts:");
    for (const mount of mounts)
      lines.push(
        `  ${show(mount["volume"])} at ${show(mount["path"])} (${show(mount["access"])}, ${show(mount["strategy"])}${mount["maxBytes"] === undefined ? "" : `, maxBytes ${show(mount["maxBytes"])}`})`,
      );
  }
  const hosts = Array.isArray(status["workerHosts"]) ? status["workerHosts"].filter(isRecord) : [];
  if (hosts.length === 0)
    lines.push(
      "Worker Hosts with a checkout: none",
      `Declare one: supertag connect worklet --workspace ${shellArg(name)}=PATH ...`,
    );
  else {
    lines.push("Worker Hosts with a checkout:");
    for (const host of hosts)
      lines.push(`  ${show(host["id"])} (${show(host["connectionStatus"])})`);
  }
  const environments = Array.isArray(status["environments"])
    ? status["environments"].filter(isRecord)
    : undefined;
  if (environments !== undefined) {
    const rows = environments.map((environment) => {
      const prepared = isRecord(environment["prepared"]) ? environment["prepared"] : undefined;
      const provider = show(environment["provider"]);
      const detail =
        typeof environment["refusal"] === "string"
          ? `refuses: ${environment["refusal"]}`
          : provider === "local"
            ? "per Task"
            : prepared === undefined
              ? "not prepared yet"
              : `${shortDigest(show(prepared["digest"]))}  trusted ${show(prepared["trustedCommit"]).slice(0, 7)}  ${ago(show(prepared["at"]), now)}`;
      return [`${show(environment["workerHostId"])} (${provider})`, detail] as const;
    });
    const width = Math.max(0, ...rows.map(([host]) => host.length));
    lines.push(
      rows.length === 0 ? "Prepared environments: none" : "Prepared environments:",
      ...rows.map(([host, detail]) => `  ${host.padEnd(width)}  ${detail}`),
    );
  }
  lines.push(
    "",
    "Checkout declarations come from each Worker Host's latest connection; paths stay on the host.",
  );
  if (environments !== undefined && environments.length > 0)
    lines.push(
      "Prepared environments come from each host's latest Task Attempt of this Workspace; local hosts prepare one per Task.",
    );
  return `${lines.map(terminalText).join("\n")}\n`;
}
function describeSession(
  resource: Resource,
  states: readonly Record<string, unknown>[],
  tagName?: string,
): string {
  const status = isRecord(resource.status) ? resource.status : {};
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const origin = isRecord(spec["origin"]) ? spec["origin"] : {};
  const lines = [
    `Session: ${show(resource.metadata["id"])}`,
    `Tag: ${tagName ?? "unknown Tag"}`,
    ...(typeof spec["parentSessionId"] === "string"
      ? [
          `Work Session: ${show(origin["title"])}`,
          `Parent: supertag describe session ${shellArg(spec["parentSessionId"])}`,
        ]
      : []),
    `Phase: ${show(status["phase"])}`,
    ...(status["latestTaskStatus"] === undefined
      ? []
      : [`Latest Task: ${show(status["latestTaskStatus"])}`]),
    `Last interaction: ${show(status["lastInteractionAt"])}`,
    `Native archives returned: ${states.length} (up to 100)`,
  ];
  for (const state of states)
    lines.push(
      `  ${show(state["harnessId"])}: ${show(state["status"])}; native ID ${show(state["nativeId"])}; updated ${show(state["updatedAt"])}`,
    );
  lines.push(
    states.some((state) => state["status"] === "resumable")
      ? "A resumable archive is recorded; a later Task of this Session resumes it with the same harness, reply audience, and workspace."
      : "No resumable native archive was returned.",
    "Native archives preserve conversation state, not workspace files. Archive contents are omitted.",
  );
  return `${lines.map(terminalText).join("\n")}\n`;
}

/** One manifest from `-f`, with the file and position it came from. */
interface ManifestDocument {
  readonly source: string;
  readonly resource: Resource;
  readonly name: string;
  readonly path: string;
  readonly index: number;
  /** Relative `file:` secret references resolve against this directory. */
  readonly directory: string;
}

/**
 * Referenced resources may precede their referrers in files; apply them first. Surface
 * Accounts come first because Tag locations and Permission Sets name them.
 */
const APPLY_ORDER: Readonly<Record<string, number>> = {
  "surface-accounts": 0,
  volumes: 1,
  workspaces: 2,
  "context-sets": 3,
  "permission-sets": 4,
  roles: 5,
  tags: 6,
  objectives: 7,
};

const REFERENCE_KINDS = {
  roles: "Role",
  "permission-sets": "Permission Set",
  "context-sets": "Context Set",
  tags: "Tag",
  workspaces: "Workspace",
} as const;

type ReferencePath = keyof typeof REFERENCE_KINDS;

/** What `apply` and `diff` were asked to do beyond reading the input. */
interface ManifestOptions {
  readonly applySet?: string;
  readonly prune: boolean;
  readonly force: boolean;
  /** Resolves `{ secretRef: NAME }` SurfaceAccount secrets; absent for `apply -f`. */
  readonly resolveSecret?: SecretResolver;
  /** Provider verification for SurfaceAccount secrets; the setup verification by default. */
  readonly verifySurface?: SurfaceVerifier;
}

/** Verifies resolved SurfaceAccount secrets with the provider, as setup does. */
export type SurfaceVerifier = (
  manifest: SurfaceAccountManifest,
  secrets: Readonly<Record<string, string>>,
) => Promise<VerifiedSurfaceAccount>;

/** Options for {@link applyManifests}. */
export interface ApplyManifestsOptions {
  /** `diff` plans without writing and never reads secrets. Defaults to `apply`. */
  readonly command?: "apply" | "diff";
  /** Apply as a set, recording membership so a later `prune` can remove what the input drops. */
  readonly applySet?: string;
  readonly prune?: boolean;
  /** Take ownership of fields another manager owns. */
  readonly force?: boolean;
  /**
   * Resolves a SurfaceAccount `{ secretRef: NAME }` to its value, such as from the secrets map
   * in supertag.yaml. Values are sent only to the Control Plane, never written or printed.
   */
  readonly resolveSecret?: SecretResolver;
  /** Relative `file:` secret references resolve here. Defaults to the working directory. */
  readonly baseDirectory?: string;
  /** Names the input in messages, such as `supertag.yaml provision`. Defaults to `manifest`. */
  readonly source?: string;
  /** Replaces provider verification; intended for tests. */
  readonly verifySurface?: SurfaceVerifier;
  /**
   * Create resources that do not exist yet and leave existing ones untouched, as supertag.yaml
   * provisioning does on every `supertag up`.
   */
  readonly createOnly?: boolean;
}

/**
 * Applies, or with `command: "diff"` plans, already parsed manifests through the same pipeline
 * as `supertag apply -f`: validation of the whole input before any write, dependency order,
 * field ownership, apply sets, and prune. supertag.yaml provisioning passes its `provision:`
 * manifests here with a `resolveSecret` backed by its `secrets:` map.
 */
export async function applyManifests(
  client: ControlPlaneClient,
  manifests: readonly unknown[],
  options: ApplyManifestsOptions = {},
): Promise<string> {
  if (options.prune === true && options.applySet === undefined)
    throw new Error("prune requires applySet; pruning removes only members of that set");
  const label = options.source ?? "manifest";
  const directory = options.baseDirectory ?? process.cwd();
  const parsed = manifestDocuments(
    manifests.map((value, index) => ({
      source: manifests.length === 1 ? label : `${label}[${index}]`,
      value,
      directory,
    })),
    label,
  );
  const documents = options.createOnly === true ? await missingDocuments(client, parsed) : parsed;
  if (documents.length === 0) return "";
  return runManifests(client, options.command ?? "apply", documents, {
    ...(options.applySet === undefined ? {} : { applySet: parseApplySetName(options.applySet) }),
    prune: options.prune === true,
    force: options.force === true,
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    ...(options.verifySurface === undefined ? {} : { verifySurface: options.verifySurface }),
  });
}

/** Documents whose resource does not exist yet. */
async function missingDocuments(
  client: ControlPlaneClient,
  documents: readonly ManifestDocument[],
): Promise<readonly ManifestDocument[]> {
  const missing: ManifestDocument[] = [];
  for (const document of documents)
    if ((await getOptional(client, document.path, document.name)) === undefined)
      missing.push(document);
  return missing;
}

/** One `provision:` entry of a control-plane service: a manifest path, or an inline manifest. */
export type ProvisionInput =
  | { readonly path: string }
  | { readonly manifest: unknown; readonly source: string };

/**
 * supertag.yaml provisioning: creates the resources its `provision:` entries declare that do not
 * exist yet, recorded under the apply set `provision`. Existing resources are never changed or
 * deleted. SurfaceAccount `secretRef`s resolve through `resolveSecret`. Returns one line per
 * created resource.
 */
export async function provisionManifests(
  client: ControlPlaneClient,
  inputs: readonly ProvisionInput[],
  options: {
    readonly resolveSecret?: SecretResolver;
    /** Inline manifests' relative `file:` references resolve here. */
    readonly baseDirectory: string;
    readonly verifySurface?: SurfaceVerifier;
  },
): Promise<string> {
  const entries: { source: string; value: unknown; directory: string }[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    if ("path" in input) {
      const found = await readManifestEntries(input.path).catch((error: unknown) => {
        errors.push(`supertag.yaml provision: ${input.path}: ${messageOf(error)}`);
        return { entries: [], errors: [] };
      });
      entries.push(...found.entries);
      errors.push(...found.errors);
    } else
      entries.push({
        source: input.source,
        value: input.manifest,
        directory: options.baseDirectory,
      });
  }
  const documents = await missingDocuments(
    client,
    manifestDocuments(entries, "supertag.yaml provision", errors),
  );
  if (documents.length === 0) return "";
  const applied = await runManifests(client, "apply", documents, {
    applySet: "provision",
    prune: false,
    force: false,
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    ...(options.verifySurface === undefined ? {} : { verifySurface: options.verifySurface }),
  });
  return applied.replace(/^(\S+) configured/gmu, "$1 created (provision)");
}

/** What validating a SurfaceAccount established before anything is written. */
interface SurfacePreparation {
  readonly manifest: SurfaceAccountManifest;
  /** Present when apply must store credentials: the account is new, or something changed. */
  readonly verified?: VerifiedSurfaceAccount;
  /** The provider account it names, once known: stored, or just verified. */
  readonly externalAccountId?: string;
  /** No account has this name yet, so Tag locations cannot resolve it before apply. */
  readonly pending: boolean;
}

interface ManifestValidation {
  readonly plans: ReadonlyMap<ManifestDocument, PlannedResource>;
  readonly surfaces: ReadonlyMap<ManifestDocument, SurfacePreparation>;
}

interface FieldChange {
  readonly path: string;
  readonly action: "add" | "remove" | "change";
  readonly before?: unknown;
  readonly after?: unknown;
}

interface FieldConflict {
  readonly path: string;
  readonly manager: string;
}

/** A server dry run: the merged spec and what applying the manifest would change. */
interface PlannedResource extends Resource {
  readonly plan: {
    readonly action: "create" | "update" | "unchanged";
    readonly changes: readonly FieldChange[];
    readonly conflicts: readonly FieldConflict[];
    /** Objectives only: changes apply cannot make, such as a new outcome. */
    readonly refusals?: readonly { readonly path: string; readonly reason: string }[];
    /** Objectives only: applying starts the owner. */
    readonly start?: boolean;
    /** Objectives only: why applying leaves the Objective unchanged. */
    readonly held?: string;
    /** Surface Accounts, when apply sent resolved values: whether they match the vault. */
    readonly secrets?: "changed" | "unchanged";
  };
  /** Surface Accounts only: the provider account the name already holds. */
  readonly current?: { readonly provider: string; readonly externalAccountId: string };
}

interface PruneItem {
  readonly kind: string;
  readonly name: string;
  /** Objectives are cancelled and keep their history; other kinds are deleted. */
  readonly action: "delete" | "cancel" | "skip";
  readonly reason?: string;
}

async function runManifestCommand(
  client: ControlPlaneClient,
  command: "apply" | "diff",
  args: readonly string[],
): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      filename: { type: "string", short: "f" },
      set: { type: "string" },
      prune: { type: "boolean" },
      "force-conflicts": { type: "boolean" },
    },
    strict: true,
  });
  if (positionals.length > 0 || values.filename === undefined) {
    throw new Error(
      `Usage: supertag ${command} -f FILE|DIRECTORY [--set NAME [--prune]] [--force-conflicts]`,
    );
  }
  await rejectSupertagYaml(values.filename);
  if (values.prune === true && values.set === undefined)
    throw new Error(
      "--prune requires --set NAME. Pruning deletes only resources recorded in that set, so SuperTag needs to know which set the input declares.",
    );
  const options: ManifestOptions = {
    ...(values.set === undefined ? {} : { applySet: parseApplySetName(values.set) }),
    prune: values.prune === true,
    force: values["force-conflicts"] === true,
  };
  return runManifests(client, command, await readManifestDocuments(values.filename), options);
}

async function runManifests(
  client: ControlPlaneClient,
  command: "apply" | "diff",
  documents: readonly ManifestDocument[],
  options: ManifestOptions,
): Promise<string> {
  const { plans, surfaces } = await validateManifestDocuments(client, documents, command, options);
  if (command === "diff")
    return renderPlan(
      orderForApply(documents),
      plans,
      options.prune ? await pruneSet(client, documents, options, true) : [],
    );
  assertNoConflicts(
    documents,
    plans,
    "Run supertag diff to review, then apply with --force-conflicts to take ownership.",
  );
  const applied = await applyManifestDocuments(client, documents, options, surfaces);
  if (!options.prune) return applied;
  const prunedNow = await pruneSet(client, documents, options, false);
  return `${applied}${prunedNow.map(pruneLine).join("")}`;
}

/**
 * supertag.yaml lists the services `supertag up` runs and is not a manifest, so `apply -f` refuses
 * it with guidance.
 */
async function rejectSupertagYaml(path: string): Promise<void> {
  if ((await stat(path)).isDirectory()) return;
  const parsed = parseAllDocuments(await readFile(path, "utf8"));
  const only = parsed.length === 1 ? parsed[0] : undefined;
  const value: unknown = only !== undefined && only.errors.length === 0 ? only.toJS() : undefined;
  if (isSupertagYamlInput(value, path))
    throw new Error(
      `${path} is a ${SUPERTAG_YAML}, which lists the services supertag up runs and is not a resource manifest. Apply resources as manifests, each with apiVersion: supertag/v1, kind, metadata.name, and spec, such as: supertag apply -f tag.yaml. A control-plane service can also create them on every supertag up with provision.`,
    );
}

function assertNoConflicts(
  documents: readonly ManifestDocument[],
  plans: ReadonlyMap<ManifestDocument, PlannedResource>,
  guidance: string,
): void {
  const refusals = orderForApply(documents).flatMap((document) =>
    (plans.get(document)?.plan.refusals ?? []).map(
      (refusal) => `${label(document)}: ${refusal.path}: ${refusal.reason}`,
    ),
  );
  if (refusals.length > 0)
    throw new Error(
      `Nothing was applied. The input changes what cannot change:\n  ${refusals.join("\n  ")}`,
    );
  const conflicts = orderForApply(documents).flatMap((document) =>
    (plans.get(document)?.plan.conflicts ?? []).map(
      (conflict) => `${label(document)}: ${conflict.path} is owned by ${conflict.manager}`,
    ),
  );
  if (conflicts.length > 0)
    throw new Error(
      `Nothing was applied. The input changes fields another manager owns:\n  ${conflicts.join("\n  ")}\n${guidance}`,
    );
}

async function readManifestDocuments(path: string): Promise<readonly ManifestDocument[]> {
  const { entries, errors } = await readManifestEntries(path);
  return manifestDocuments(entries, path, errors);
}

/** The manifests in a file or a directory's .yaml, .yml, and .json files, with parse errors. */
async function readManifestEntries(path: string): Promise<{
  readonly entries: { source: string; value: unknown; directory: string }[];
  readonly errors: string[];
}> {
  const files = (await stat(path)).isDirectory()
    ? (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/u.test(entry.name))
        .map((entry) => entry.name)
        .toSorted()
        .map((name) => join(path, name))
    : [path];
  if (files.length === 0) throw new Error(`${path} contains no .yaml, .yml, or .json files`);
  const entries: { source: string; value: unknown; directory: string }[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const values: unknown[] = [];
    for (const document of parseAllDocuments(await readFile(file, "utf8"))) {
      if (document.errors.length > 0) {
        errors.push(`${file}: ${document.errors[0]?.message ?? "invalid YAML"}`);
        continue;
      }
      const value: unknown = document.toJS();
      if (value === null || value === undefined) continue;
      values.push(...(Array.isArray(value) ? value : [value]));
    }
    values.forEach((value, index) => {
      entries.push({
        source: values.length === 1 ? file : `${file} document ${index + 1}`,
        value,
        directory: dirname(file),
      });
    });
  }
  return { entries, errors };
}

/** Checks each manifest's shape and kind, and that the input defines each resource once. */
function manifestDocuments(
  entries: readonly {
    readonly source: string;
    readonly value: unknown;
    readonly directory: string;
  }[],
  input: string,
  errors: string[] = [],
): readonly ManifestDocument[] {
  const documents: ManifestDocument[] = [];
  for (const { source, value, directory } of entries) {
    try {
      const resource = parseManifest(value);
      const descriptor = manifestResources.get(resource.kind);
      if (descriptor === undefined) throw new Error(`Unknown manifest kind: ${resource.kind}`);
      if (!descriptor.mutable) throw new Error(`${resource.kind} is observed state`);
      if (!(descriptor.path in APPLY_ORDER)) throw new Error(`${resource.kind} cannot be applied`);
      // Literal secrets and malformed references fail here, before anything leaves the CLI.
      if (descriptor.path === "surface-accounts") parseSurfaceAccountManifest(resource);
      documents.push({
        source,
        resource,
        name: requiredName(resource),
        path: descriptor.path,
        index: documents.length,
        directory,
      });
    } catch (error) {
      errors.push(`${source}: ${messageOf(error)}`);
    }
  }
  const seen = new Map<string, ManifestDocument>();
  for (const document of documents) {
    const key = `${document.path}/${document.name}`;
    const prior = seen.get(key);
    if (prior)
      errors.push(
        `${document.source}: ${label(document)} is also defined in ${prior.source}; define each resource once`,
      );
    else seen.set(key, document);
  }
  if (errors.length > 0) throw new Error(`Invalid manifests:\n  ${errors.join("\n  ")}`);
  if (documents.length === 0) throw new Error(`${input} contains no manifests`);
  return documents;
}

function manifestQuery(options: ManifestOptions, dryRun: boolean): string {
  const query = new URLSearchParams();
  if (dryRun) query.set("dryRun", "true");
  if (options.applySet !== undefined) query.set("applySet", options.applySet);
  if (options.force) query.set("force", "true");
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

async function pruneSet(
  client: ControlPlaneClient,
  documents: readonly ManifestDocument[],
  options: ManifestOptions,
  dryRun: boolean,
): Promise<readonly PruneItem[]> {
  const result = await client.request<{ items: readonly PruneItem[] }>(
    `/api/v1/apply-sets/${encodeURIComponent(options.applySet ?? "")}/prune${dryRun ? "?dryRun=true" : ""}`,
    {
      method: "POST",
      body: JSON.stringify({
        keep: documents.map((document) => ({ kind: document.resource.kind, name: document.name })),
      }),
    },
  );
  return result.items;
}

function pruneLine(item: PruneItem): string {
  if (item.action === "delete") return `${item.kind}/${item.name} deleted\n`;
  if (item.action === "cancel") return `${item.kind}/${item.name} cancelled; its history is kept\n`;
  return `${item.kind}/${item.name} ${notRemoved(item)}: ${item.reason ?? "still in use"}\n`;
}

function notRemoved(item: PruneItem): string {
  return item.kind === "Objective" ? "not cancelled" : "not deleted";
}

/**
 * Checks every document before anything changes: the API Server validates and plans each one
 * without writing, and each reference must be defined in the input or already exist. Apply also
 * resolves and verifies Surface Account secrets here, so a rejected credential leaves
 * everything unchanged.
 */
async function validateManifestDocuments(
  client: ControlPlaneClient,
  documents: readonly ManifestDocument[],
  command: "apply" | "diff",
  options: ManifestOptions,
): Promise<ManifestValidation> {
  const errors: string[] = [];
  const planned = new Map<ManifestDocument, PlannedResource>();
  const surfaces = new Map<ManifestDocument, SurfacePreparation>();
  const plan = (document: ManifestDocument, body: unknown) =>
    client.request<PlannedResource>(`/api/v1/${document.path}${manifestQuery(options, true)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  // Surface Accounts first: Tag locations in the same input may name them.
  await Promise.all(
    documents
      .filter((document) => document.path === "surface-accounts")
      .map(async (document) => {
        try {
          const prepared = await prepareSurfaceAccount(client, document, command, options, plan);
          planned.set(document, prepared.plan);
          surfaces.set(document, prepared.surface);
        } catch (error) {
          errors.push(`${document.source}: ${label(document)}: ${messageOf(error)}`);
        }
      }),
  );
  const identities = new Map<string, ManifestDocument>();
  for (const [document, surface] of surfaces) {
    if (surface.externalAccountId === undefined) continue;
    const identity = `${surface.manifest.provider}:${surface.externalAccountId}`;
    const prior = identities.get(identity);
    if (prior === undefined) identities.set(identity, document);
    else
      errors.push(
        `${document.source}: ${label(document)} names the same ${surface.manifest.provider} account as ${label(prior)} (${surface.externalAccountId}); declare each account once`,
      );
  }
  const pending = await pendingTagLocations(client, documents, surfaces);
  await Promise.all(
    documents
      .filter((document) => document.path !== "surface-accounts")
      .map(async (document) => {
        try {
          const indices = pending.get(document);
          planned.set(
            document,
            indices === undefined
              ? await plan(document, document.resource)
              : withPendingLocations(
                  await plan(document, withoutLocations(document.resource, indices)),
                  document.resource,
                  indices,
                ),
          );
        } catch (error) {
          errors.push(`${document.source}: ${label(document)}: ${messageOf(error)}`);
        }
      }),
  );
  const defined = new Set(documents.map((document) => `${document.path}/${document.name}`));
  const existing = new Map<string, Promise<boolean>>();
  const exists = (path: ReferencePath, name: string) => {
    const key = `${path}/${name}`;
    if (!existing.has(key))
      existing.set(
        key,
        getOptional(client, path, name).then(
          (resource) =>
            resource !== undefined &&
            (path !== "roles" ||
              !isRecord(resource.status) ||
              resource.status["phase"] === "active"),
        ),
      );
    return existing.get(key) as Promise<boolean>;
  };
  for (const document of documents) {
    if (!planned.has(document)) continue;
    for (const [path, name] of manifestReferences(document.path, document.resource.spec)) {
      if (defined.has(`${path}/${name}`) || (await exists(path, name))) continue;
      errors.push(
        `${document.source}: ${label(document)} references ${REFERENCE_KINDS[path]} ${name}, which is neither in this input nor on the Control Plane`,
      );
    }
  }
  if (errors.length > 0)
    throw new Error(
      `${command === "apply" ? "Nothing was applied. " : ""}Invalid manifests:\n  ${errors.toSorted().join("\n  ")}`,
    );
  return { plans: planned, surfaces };
}

/**
 * Plans one Surface Account. `diff` never reads secrets, so it compares only the declared
 * fields and references. `apply` resolves the secrets and asks the Control Plane whether they
 * match the stored credential; when the account is new or anything changed, it verifies them
 * with the provider, as setup does, before any resource in the input is written.
 */
async function prepareSurfaceAccount(
  client: ControlPlaneClient,
  document: ManifestDocument,
  command: "apply" | "diff",
  options: ManifestOptions,
  plan: (document: ManifestDocument, body: unknown) => Promise<PlannedResource>,
): Promise<{ readonly plan: PlannedResource; readonly surface: SurfacePreparation }> {
  const manifest = parseSurfaceAccountManifest(document.resource);
  const credentials =
    command === "apply"
      ? await resolveSurfaceSecrets(manifest, {
          baseDirectory: document.directory,
          ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
        })
      : undefined;
  const planned = await plan(
    document,
    credentials === undefined ? document.resource : { ...document.resource, credentials },
  );
  const current = planned.current;
  const surface: SurfacePreparation = {
    manifest,
    pending: planned.plan.action === "create",
    ...(current === undefined ? {} : { externalAccountId: current.externalAccountId }),
  };
  const blocked = (planned.plan.refusals ?? []).length > 0 || planned.plan.conflicts.length > 0;
  const unchanged = planned.plan.action === "unchanged" && planned.plan.secrets === "unchanged";
  if (credentials === undefined || blocked || unchanged) return { plan: planned, surface };
  let verified: VerifiedSurfaceAccount;
  try {
    verified = await (options.verifySurface ?? verifySurfaceAccount)(manifest, credentials);
  } catch (error) {
    throw new Error(`provider verification failed: ${messageOf(error)}`);
  }
  if (current !== undefined && current.externalAccountId !== verified.externalAccountId)
    throw new Error(
      `${document.name} is ${current.provider} account ${current.externalAccountId}, but its credentials belong to ${verified.externalAccountId}. Delete it, then apply the other account under a new name`,
    );
  if (current === undefined) {
    const holder = await getOptional(
      client,
      "surface-accounts",
      `${verified.provider}:${verified.externalAccountId}`,
    );
    if (holder !== undefined && declaredByManifest(holder))
      throw new Error(
        `${verified.provider} account ${verified.externalAccountId} is already declared as SurfaceAccount ${String(holder.metadata["name"])}`,
      );
  }
  return {
    plan: planned,
    surface: { ...surface, verified, externalAccountId: verified.externalAccountId },
  };
}

/** A Surface Account a manifest applied records where its secrets came from. */
function declaredByManifest(resource: Resource): boolean {
  return isRecord(resource.spec) && isRecord(resource.spec["secrets"]);
}

/**
 * Tag locations that name a Surface Account this input creates. The Control Plane cannot
 * resolve them until that account exists, so they are planned on the client and applied after it.
 * A location is pending when its account matches the new account's name or verified provider
 * ID, or, with no account given, when the new account is the provider's only one.
 */
async function pendingTagLocations(
  client: ControlPlaneClient,
  documents: readonly ManifestDocument[],
  surfaces: ReadonlyMap<ManifestDocument, SurfacePreparation>,
): Promise<ReadonlyMap<ManifestDocument, readonly number[]>> {
  const created = [...surfaces.values()].filter((surface) => surface.pending);
  const tags = documents.filter((document) => document.path === "tags");
  if (created.length === 0 || tags.length === 0) return new Map();
  const accounts = (await client.request<ResourceList>("/api/v1/surface-accounts")).items;
  const pending = new Map<ManifestDocument, number[]>();
  for (const document of tags) {
    const spec = isRecord(document.resource.spec) ? document.resource.spec : {};
    const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
    locations.forEach((location: unknown, index: number) => {
      if (!isRecord(location)) return;
      const provider = location["provider"];
      const account = location["account"];
      const candidates = created.filter((surface) => surface.manifest.provider === provider);
      if (candidates.length === 0) return;
      const existing = accounts.filter(
        (item) => isRecord(item.spec) && item.spec["provider"] === provider,
      );
      const matches =
        typeof account === "string"
          ? !existing.some(
              (item) =>
                item.metadata["name"] === account ||
                item.metadata["id"] === account ||
                (isRecord(item.spec) && item.spec["externalAccountId"] === account),
            ) &&
            candidates.some(
              (surface) =>
                surface.manifest.name === account || surface.externalAccountId === account,
            )
          : account === undefined && existing.length === 0 && candidates.length === 1;
      if (matches) pending.set(document, [...(pending.get(document) ?? []), index]);
    });
  }
  return pending;
}

function withoutLocations(resource: Resource, indices: readonly number[]): Resource {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
  return {
    ...resource,
    spec: { ...spec, locations: locations.filter((_, index) => !indices.includes(index)) },
  };
}

/** Adds the locations the Control Plane could not plan yet, as additions. */
function withPendingLocations(
  planned: PlannedResource,
  resource: Resource,
  indices: readonly number[],
): PlannedResource {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
  const additions = indices
    .map((index) => locations[index])
    .filter(isRecord)
    .map((location) => ({
      path: `spec.locations[${locationKey(location)}]`,
      action: "add" as const,
      after: location,
    }));
  return {
    ...planned,
    plan: {
      ...planned.plan,
      action: planned.plan.action === "unchanged" ? "update" : planned.plan.action,
      changes: [...planned.plan.changes, ...additions],
    },
  };
}

function manifestReferences(path: string, spec: unknown): readonly [ReferencePath, string][] {
  if (!isRecord(spec)) return [];
  const names = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (path === "roles")
    return [
      ...names(spec["contextSets"]).map(
        (name) => ["context-sets", name] as [ReferencePath, string],
      ),
      ...names(spec["permissionSets"]).map(
        (name) => ["permission-sets", name] as [ReferencePath, string],
      ),
    ];
  if (path === "objectives") {
    const references: [ReferencePath, string][] = [];
    if (typeof spec["owner"] === "string") references.push(["tags", spec["owner"]]);
    for (const name of names(spec["workspaces"])) references.push(["workspaces", name]);
    for (const team of Object.values(isRecord(spec["teams"]) ? spec["teams"] : {}))
      if (isRecord(team)) {
        if (typeof team["lead"] === "string") references.push(["tags", team["lead"]]);
        for (const name of names(team["members"])) references.push(["tags", name]);
      }
    return references;
  }
  if (path !== "tags") return [];
  const references: [ReferencePath, string][] = names(spec["roles"]).map((name) => ["roles", name]);
  for (const location of Array.isArray(spec["locations"]) ? spec["locations"] : [])
    if (isRecord(location)) {
      for (const name of names(location["permissionSets"]))
        references.push(["permission-sets", name]);
      for (const name of names(location["contextSets"])) references.push(["context-sets", name]);
      for (const name of names(location["workspaces"])) references.push(["workspaces", name]);
    }
  for (const grant of Array.isArray(spec["acceptsMessagesFrom"]) ? spec["acceptsMessagesFrom"] : [])
    if (isRecord(grant) && typeof grant["tag"] === "string")
      references.push(["tags", grant["tag"]]);
  return references;
}

/** Referenced kinds first; within a kind, input order. */
function orderForApply(documents: readonly ManifestDocument[]): readonly ManifestDocument[] {
  return documents.toSorted(
    (left, right) =>
      (APPLY_ORDER[left.path] ?? 0) - (APPLY_ORDER[right.path] ?? 0) || left.index - right.index,
  );
}

/**
 * Applies in dependency order. A Tag that accepts messages from a Tag later in the input needs
 * that sender to exist, so the sender is first created empty. Not transactional.
 */
async function applyManifestDocuments(
  client: ControlPlaneClient,
  documents: readonly ManifestDocument[],
  options: ManifestOptions,
  surfaces: ReadonlyMap<ManifestDocument, SurfacePreparation> = new Map(),
): Promise<string> {
  const ordered = orderForApply(documents);
  const tagsInInput = new Map(
    ordered
      .filter((document) => document.path === "tags")
      .map((document) => [document.name, document]),
  );
  const created = new Set<string>();
  const applied: ManifestDocument[] = [];
  const lines: string[] = [];
  const post = (body: unknown, path: string) =>
    client.request<
      Resource & {
        readonly warnings?: readonly string[];
        readonly started?: { readonly taskId: string };
        readonly notStarted?: string;
      }
    >(`/api/v1/${path}${manifestQuery(options, false)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  for (const document of ordered) {
    try {
      if (document.path === "tags" && isRecord(document.resource.spec)) {
        const grants = document.resource.spec["acceptsMessagesFrom"];
        for (const grant of Array.isArray(grants) ? grants : []) {
          const sender = isRecord(grant) ? tagsInInput.get(String(grant["tag"])) : undefined;
          if (
            !sender ||
            sender === document ||
            applied.includes(sender) ||
            created.has(sender.name)
          )
            continue;
          if ((await getOptional(client, "tags", sender.name)) !== undefined) continue;
          await post({ ...sender.resource, spec: {} }, "tags");
          created.add(sender.name);
        }
      }
      // A Surface Account carries the provider-verified account only when it must be stored.
      const verified = surfaces.get(document)?.verified;
      const result = await post(
        verified === undefined ? document.resource : { ...document.resource, verified },
        document.path,
      );
      if (document.path === "surface-accounts") {
        applied.push(document);
        lines.push(
          verified === undefined
            ? `${label(document)} configured; credentials unchanged\n`
            : `${label(document)} configured; verified ${verified.provider} account ${verified.displayName} (${verified.externalAccountId})\n`,
        );
        continue;
      }
      // Objectives report conditions that would hold their Tasks; the write still succeeded.
      for (const warning of result.warnings ?? [])
        process.stderr.write(
          `Warning: ${terminalText(label(document))}: ${terminalText(warning)}\n`,
        );
      if (result.notStarted !== undefined)
        process.stderr.write(
          `Warning: ${terminalText(label(document))}: the owner was not started: ${terminalText(result.notStarted).replace(/\.?$/u, ".")} Apply again once that is fixed to start it.\n`,
        );
      if (result.started !== undefined)
        lines.push(`${label(document)} started its owner with Task ${result.started.taskId}\n`);
    } catch (error) {
      const notApplied = ordered.filter((item) => !applied.includes(item));
      throw new Error(
        [
          `${label(document)} (${document.source}) failed: ${messageOf(error)}`,
          `Applied: ${applied.map(label).join(", ") || "none"}`,
          `Not applied: ${notApplied.map(label).join(", ") || "none"}`,
        ].join("\n"),
      );
    }
    applied.push(document);
    lines.push(`${label(document)} configured\n`);
  }
  return lines.join("");
}

/** A Terraform-style plan: one line per resource that changes, then a summary. */
function renderPlan(
  documents: readonly ManifestDocument[],
  plans: ReadonlyMap<ManifestDocument, PlannedResource>,
  pruned: readonly PruneItem[],
): string {
  const rows: { readonly head: string; readonly details: readonly string[] }[] = [];
  const counts = { create: 0, update: 0, delete: 0, cancel: 0, conflict: 0, kept: 0 };
  for (const document of documents) {
    const plan = plans.get(document)?.plan;
    if (plan === undefined) continue;
    const name = `${document.resource.kind} ${document.name}`;
    const start = plan.start === true ? ["starts the owner"] : [];
    if (plan.held !== undefined) {
      rows.push({ head: `= ${name}`, details: [plan.held] });
    } else if ((plan.refusals ?? []).length > 0) {
      for (const refusal of plan.refusals ?? []) {
        counts.conflict += 1;
        rows.push({ head: `! ${name}`, details: [`${refusal.path}: ${refusal.reason}`] });
      }
    } else if (plan.action === "create") {
      counts.create += 1;
      rows.push({
        head: `+ ${name}`,
        details:
          document.path === "surface-accounts"
            ? [`${surfaceProvider(document)}; apply reads and verifies its secrets`]
            : [...describeCreation(plan.changes), ...start],
      });
    } else if (plan.action === "update") {
      counts.update += 1;
      rows.push({ head: `~ ${name}`, details: [...describeChanges(plan.changes), ...start] });
    }
    for (const conflict of plan.conflicts) {
      counts.conflict += 1;
      rows.push({
        head: `! ${name}`,
        details: [
          `${conflict.path} owned by ${conflict.manager}  (use --force-conflicts)`,
          ...(conflict.manager === "init"
            ? [
                "To adopt into another set, review this change, then run supertag apply -f FILE --set NAME --force-conflicts.",
              ]
            : []),
        ],
      });
    }
  }
  for (const item of pruned) {
    const name = `${item.kind} ${item.name}`;
    if (item.action === "delete") {
      counts.delete += 1;
      rows.push({ head: `- ${name}`, details: [] });
    } else if (item.action === "cancel") {
      counts.cancel += 1;
      rows.push({ head: `- ${name}`, details: ["cancel; its history is kept"] });
    } else {
      counts.kept += 1;
      rows.push({
        head: `= ${name}`,
        details: [`${notRemoved(item)}: ${item.reason ?? "still in use"}`],
      });
    }
  }
  const width = Math.max(0, ...rows.map((row) => row.head.length)) + 3;
  const lines = rows.flatMap((row) =>
    row.details.length === 0
      ? [row.head]
      : row.details.map(
          (detail, index) => `${index === 0 ? row.head.padEnd(width) : " ".repeat(width)}${detail}`,
        ),
  );
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const summary = [
    `${counts.create} to create`,
    `${counts.update} to update`,
    `${counts.delete} to delete`,
    ...(counts.cancel > 0 ? [`${counts.cancel} to cancel`] : []),
    plural(counts.conflict, "conflict"),
    ...(counts.kept > 0 ? [`${counts.kept} not deleted`] : []),
  ].join(", ");
  if (lines.length === 0) lines.push("No changes. The Control Plane matches the input.");
  const secrets = documents.some((document) => document.path === "surface-accounts")
    ? "Surface Account secret values are not read by diff. Apply compares them with the stored credentials and verifies and stores any that changed.\n"
    : "";
  return `${lines.map(terminalText).join("\n")}\nPlan: ${summary}.\n${secrets}`;
}

function surfaceProvider(document: ManifestDocument): string {
  const spec = isRecord(document.resource.spec) ? document.resource.spec : {};
  return String(spec["provider"]);
}

/** A new resource lists only the entries it creates in nested maps, such as an Objective's Teams. */
function describeCreation(changes: readonly FieldChange[]): readonly string[] {
  return describeChanges(changes.filter((change) => /^spec\.teams\[/u.test(change.path)));
}

/** One line per changed field, grouping entries of the same list field. */
function describeChanges(changes: readonly FieldChange[]): readonly string[] {
  const lists = new Map<string, string[]>();
  const lines: string[] = [];
  for (const change of changes) {
    // A Surface Account's options and secret references read best one per line, with values.
    const option = /^spec\.(configuration|secrets)\[(.*)\]$/su.exec(change.path);
    const path = option === null ? change.path : `spec.${option[1]}.${option[2]}`;
    const entry = option === null ? /^(spec\.[A-Za-z]+)\[(.*)\]$/su.exec(change.path) : null;
    if (entry?.[1] !== undefined && entry[2] !== undefined) {
      const symbol = change.action === "add" ? "+" : change.action === "remove" ? "-" : "~";
      const items = lists.get(entry[1]) ?? [];
      if (!lists.has(entry[1])) {
        lists.set(entry[1], items);
        lines.push(entry[1]);
      }
      items.push(`${symbol} ${entry[2]}`);
      continue;
    }
    lines.push(
      `${path}: ${
        change.action === "add"
          ? `+ ${shortValue(change.after)}`
          : change.action === "remove"
            ? `- ${shortValue(change.before)}`
            : `${shortValue(change.before)} -> ${shortValue(change.after)}`
      }`,
    );
  }
  return lines.map((line) => {
    const items = lists.get(line);
    return items === undefined ? line : `${line}: ${items.join(", ")}`;
  });
}

function shortValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const quoted = typeof value === "string" && /[\s,]/u.test(text) ? JSON.stringify(text) : text;
  return quoted.length > 60 ? `${quoted.slice(0, 57)}...` : quoted;
}

async function getOptional(
  client: ControlPlaneClient,
  path: string,
  name: string,
): Promise<Resource | undefined> {
  try {
    return await client.request<Resource>(`/api/v1/${path}/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not exist")) return undefined;
    throw error;
  }
}

function label(document: ManifestDocument): string {
  return `${document.resource.kind}/${document.name}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The apply-able form of a stored resource: identity, desired fields, no server bookkeeping. */
function exportManifest(resource: Resource): string {
  return stringifyYaml({
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: { name: resource.metadata["name"] },
    spec:
      resource.kind === "Objective"
        ? objectiveManifestSpec(resource.spec)
        : resource.kind === "SurfaceAccount"
          ? surfaceAccountManifestSpec(resource.spec)
          : pruneManagedFields(resource.spec),
  });
}

/**
 * A Surface Account's declarable fields: the options verification recorded, in manifest form,
 * and the secret references from the last apply. Secret values never leave the vault.
 */
function surfaceAccountManifestSpec(spec: unknown): Record<string, unknown> {
  const record = isRecord(spec) ? spec : {};
  const provider = record["provider"];
  if (!isSurfaceProvider(provider)) throw new Error("Surface Account provider is invalid");
  return {
    provider,
    displayName: record["displayName"],
    configuration: declaredConfiguration({
      provider,
      authMethod: String(record["authMethod"]),
      externalAccountId: String(record["externalAccountId"]),
      configuration: isRecord(record["configuration"]) ? record["configuration"] : {},
    }),
    secrets: record["secrets"],
  };
}

/** An Objective's declarable fields, leaving out defaults so the manifest stays short. */
function objectiveManifestSpec(spec: unknown): Record<string, unknown> {
  const record = isRecord(spec) ? spec : {};
  const empty = (value: unknown) =>
    value === undefined ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0);
  const teams = Object.fromEntries(
    Object.entries(isRecord(record["teams"]) ? record["teams"] : {}).map(([key, team]) => [
      key,
      isRecord(team)
        ? Object.fromEntries(Object.entries(team).filter(([, value]) => !empty(value)))
        : team,
    ]),
  );
  return Object.fromEntries(
    Object.entries({ ...record, teams }).filter(
      ([field, value]) => field === "runtimeActions" || !empty(value),
    ),
  );
}

async function watchResources(
  client: ControlPlaneClient,
  args: readonly string[],
): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { once: { type: "boolean" }, output: { type: "string" } },
    strict: true,
  });
  const [kind, name, ...rest] = positionals;
  if (kind === undefined || rest.length > 0)
    throw new Error("Usage: supertag watch KIND [NAME] [--once]");
  if (values.output !== undefined && values.output !== "json")
    throw new Error("Watch supports --output json; text output is available for describe");
  const path = descriptorFor(kind).path;
  const pathname =
    name === undefined ? `/api/v1/${path}` : `/api/v1/${path}/${encodeURIComponent(name)}`;
  const first = await client.request<Resource | ResourceList>(pathname);
  const human = values.output === undefined && process.stdout.isTTY === true;
  const rendered = terminalJson(first, human);
  if (values.once === true) return rendered;
  process.stdout.write(rendered);
  let priorVersion = watchedVersion(first);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (stopped) break;
      const next = await client.request<Resource | ResourceList>(pathname);
      const version = watchedVersion(next);
      if (version !== priorVersion) {
        process.stdout.write(terminalJson(next, human));
        priorVersion = version;
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }
  return "";
}

function watchedVersion(resource: Resource | ResourceList): string {
  return String(resource.metadata?.["resourceVersion"] ?? JSON.stringify(resource));
}

function parseManifest(value: unknown): Resource {
  if (
    !isRecord(value) ||
    typeof value["kind"] !== "string" ||
    typeof value["apiVersion"] !== "string" ||
    !isRecord(value["metadata"])
  ) {
    throw new Error("Manifest requires apiVersion, kind, and metadata");
  }
  requiredName(value as unknown as Resource);
  return value as unknown as Resource;
}

function descriptorFor(kind: string): { readonly path: string; readonly mutable: boolean } {
  if (!Object.hasOwn(resources, kind))
    throw new Error(
      `Unknown resource kind: ${kind}. Use one of: ${Object.keys(resources).join(", ")}`,
    );
  const descriptor = resources[kind as keyof typeof resources];
  return descriptor;
}

function requiredName(resource: Resource): string {
  const name = resource.metadata["name"];
  if (typeof name !== "string" || name.trim() === "")
    throw new Error(`${resource.kind} metadata.name is required`);
  return name.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A resource spec without the identifiers and timestamps the Control Plane adds. */
export function pruneManagedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneManagedFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== "id" &&
          key !== "createdAt" &&
          key !== "updatedAt" &&
          key !== "createdBy" &&
          key !== "permissionSetId" &&
          key !== "contextSetId",
      )
      .map(([key, child]) => [key, pruneManagedFields(child)]),
  );
}
