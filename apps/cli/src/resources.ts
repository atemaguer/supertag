import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type JsonObject, type MessageInitShape, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { TaskDelivery } from "@supertag/core";
import {
  parseApplySetName,
  parseVolumeSource,
  plainCommandText,
  TASK_FINDING_SEVERITIES,
  type TaskFinding,
  taskFindingLine,
  unsandboxedCommandHoldsOf,
  unsandboxedCommandsReason,
} from "@supertag/core";
import {
  type ApplyManifestsResponse,
  DeletionAction,
  ErrorDetailSchema,
  type FieldChange,
  FieldChangeAction,
  type ManifestDocumentSchema,
  ManifestOutcome,
  type ManifestPlan,
  PlanAction,
  PruneAction,
  type PruneResult,
  ResourceKind,
} from "@supertag/operator-api";
import { parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type { ControlPlaneClient } from "./control-plane-client.js";
import {
  formatDelivery,
  hasDelivery,
  type LocalCheckouts,
  localCheckouts,
} from "./delivery-view.js";
import { nameOf, SURFACE_PROVIDERS } from "./host-protos.js";
import {
  APPLY_ORDER,
  label,
  MANIFEST_INPUT_MAX_BYTES,
  type ManifestDocument,
  manifestDocuments,
  messageOf,
} from "./manifest-documents.js";
import { money } from "./money.js";
import {
  operatorErrorMessage,
  refusedAsError,
  resourceClient,
  workClient,
} from "./operator-client.js";
import {
  findResourceView,
  getOperatorResource,
  getResourceView,
  isOperatorResourcePath,
  listOperatorResources,
  listResourceViews,
  resourceManifests,
} from "./operator-resources.js";
import { isResourcePath, resourceKindEntry, resourceKindOfPath } from "./resource-protos.js";
import { runningCommandText } from "./running-command.js";
import { hostStorageLines, sandboxStorage, UNKNOWN_TASK_STORAGE } from "./storage-durability.js";
import { isSupertagYamlInput, SUPERTAG_YAML } from "./supertag-yaml.js";
import {
  parseSurfaceAccountManifest,
  resolveSurfaceSecrets,
  type SecretResolver,
} from "./surface-account-manifest.js";
import { runTeamCommand } from "./teams.js";
import { terminalJson, terminalText } from "./terminal-text.js";
import { sessionStateView, sessionView, taskView } from "./work-protos.js";
import {
  allSessions,
  recentTasks,
  workSessionJson,
  workSessionsJson,
  workTaskJson,
  workTasksJson,
} from "./work-reads.js";
import { workerHarnessNames } from "./worker-harness-names.js";

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
  tag: { path: "tags" },
  "permission-set": { path: "permission-sets" },
  "context-set": { path: "context-sets" },
  role: { path: "roles" },
  "surface-account": { path: "surface-accounts" },
  "worker-host": { path: "worker-hosts" },
  "worker-profile": { path: "worker-profiles" },
  task: { path: "tasks" },
  session: { path: "sessions" },
  volume: { path: "volumes" },
  workspace: { path: "workspaces" },
  "auth-key": { path: "auth-keys" },
  "operator-token": { path: "operator-tokens" },
  objective: { path: "objectives" },
} as const;

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
  // Teams are configured with their own commands; get and delete read and remove one by name.
  if (args[0] === "team" && command === "get")
    return runTeamCommand(client, ["get", ...args.slice(1)]);
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
    if (!(descriptor.path in APPLY_ORDER) || !isResourcePath(descriptor.path))
      throw new Error(
        "YAML manifests are available for volume, workspace, surface, tag, role, permission-set, context-set, and objective",
      );
    if (descriptor.path === "objectives" && name === undefined)
      throw new Error("Usage: supertag get objective ID --output yaml");
    return (await resourceManifests(client.operator, descriptor.path, name))
      .map((manifest) => stringifyYaml(manifest))
      .join("---\n");
  }
  const human = output === "text" || (values.output === undefined && process.stdout.isTTY === true);
  if (descriptor.path === "tasks" || descriptor.path === "sessions") {
    const work = workClient(client.operator);
    if (command === "describe" && output === "text" && name !== undefined)
      return descriptor.path === "tasks"
        ? describeTaskOf(client, await refusedAsError(() => work.getTask({ id: name })))
        : describeSessionOf(work, await refusedAsError(() => work.getSession({ id: name })));
    const value = await refusedAsError(async () =>
      descriptor.path === "tasks"
        ? name === undefined
          ? workTasksJson(await recentTasks(work))
          : workTaskJson(await work.getTask({ id: name }))
        : name === undefined
          ? workSessionsJson(await allSessions(work))
          : workSessionJson(await work.getSession({ id: name })),
    );
    return terminalJson(value, human);
  }
  const resource =
    name === undefined
      ? await readResources(client, descriptor.path)
      : await readResource(client, descriptor.path, name);
  if (command === "describe" && output === "text" && name !== undefined && "kind" in resource) {
    if (resource.kind === "WorkerHost") return describeWorkerHost(resource);
    if (resource.kind === "Tag") return describeTag(resource);
    if (resource.kind === "Workspace") return describeWorkspace(resource, Date.now());
    if (resource.kind === "Volume") return describeVolume(resource);
  }
  return terminalJson(resource, human);
}

/** Lists the resources at a path, through the operator RPC that serves them. */
async function readResources(client: ControlPlaneClient, path: string): Promise<ResourceList> {
  if (isOperatorResourcePath(path))
    return (await listOperatorResources(client.operator, path)) as unknown as ResourceList;
  if (isResourcePath(path))
    return (await listResourceViews(client.operator, path)) as unknown as ResourceList;
  throw new Error(`Unknown resource path: ${path}`);
}

/** Reads one resource at a path by name, as `readResources` lists them. */
async function readResource(
  client: ControlPlaneClient,
  path: string,
  name: string,
): Promise<Resource> {
  if (isOperatorResourcePath(path))
    return (await getOperatorResource(client.operator, path, name)) as unknown as Resource;
  if (isResourcePath(path))
    return (await getResourceView(client.operator, path, name)) as unknown as Resource;
  throw new Error(`Unknown resource path: ${path}`);
}

/** `describe task`: the Task as the Control Plane recorded it, with this machine's checkouts. */
async function describeTaskOf(
  client: ControlPlaneClient,
  task: Parameters<typeof taskView>[0],
): Promise<string> {
  const url = (client as { readonly url?: string }).url;
  const checkouts = url === undefined ? undefined : await localCheckouts(url);
  const chosen = task.resolution;
  const tagNames = new Map<string, string>();
  if (task.tag !== "") tagNames.set(task.tagId, task.tag);
  if (chosen !== undefined && chosen.chosenByTag !== "")
    tagNames.set(chosen.chosenByTagId, chosen.chosenByTag);
  return describeTask(taskView(task) as unknown as Resource, {
    tagNames,
    ...(task.tag === "" ? {} : { tagName: task.tag }),
    ...(checkouts === undefined ? {} : { checkouts }),
  });
}

/** `describe session`: the Session with the native archives it returned, at most 100. */
async function describeSessionOf(
  work: ReturnType<typeof workClient>,
  session: Parameters<typeof sessionView>[0],
): Promise<string> {
  const states = await refusedAsError(() =>
    work.listSessionStates({ sessionId: session.id, pageSize: 100 }),
  );
  return describeSession(
    sessionView(session) as unknown as Resource,
    states.states.map(sessionStateView),
    session.tag === "" ? undefined : session.tag,
  );
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
  if (kind === "team") {
    if (values["dry-run"] === true) throw new Error("delete team does not accept --dry-run");
    return runTeamCommand(client, ["delete", name]);
  }
  const descriptor = descriptorFor(kind);
  if (descriptor.path === "objectives")
    throw new Error(
      `Objectives are cancelled, not deleted, so their history stays: supertag cancel objective ${name}`,
    );
  if (
    !(descriptor.path in APPLY_ORDER) ||
    !(descriptor.path in DELETE_LABELS) ||
    !isResourcePath(descriptor.path)
  )
    throw new Error(`${kind} cannot be deleted. ${DELETE_USAGE}`);
  const path = descriptor.path;
  const dryRun = values["dry-run"] === true;
  const result = await refusedAsError(() =>
    resourceClient(client.operator).deleteResource({
      kind: resourceKindOfPath(path),
      name,
      dryRun,
    }),
  );
  const label = `${DELETE_LABELS[descriptor.path] ?? kind} ${name}`;
  const verb = result.action === DeletionAction.RETIRE ? "retired" : "deleted";
  const lines = [
    dryRun
      ? `Dry run: ${label} would be ${verb}. Nothing was changed.`
      : `${label} ${verb}.${result.action === DeletionAction.RETIRE ? " Its history is kept." : ""}`,
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

/** The Task result's findings by severity, highest first; nothing when it reported none. */
export function describeFindings(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (typeof value["unreadable"] === "string")
    return [`Findings: unreadable (${value["unreadable"]})`];
  const groups = TASK_FINDING_SEVERITIES.map((severity) => ({
    severity,
    findings: (Array.isArray(value[severity]) ? value[severity] : []) as TaskFinding[],
  })).filter((group) => group.findings.length > 0);
  if (!groups.length) return [];
  return [
    `Findings: ${groups.map((group) => `${group.findings.length} ${group.severity}`).join(", ")}`,
    ...groups.flatMap((group) => group.findings.map((finding) => `  ${taskFindingLine(finding)}`)),
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
  const attempt = isRecord(status["attempt"]) ? status["attempt"] : undefined;
  const id = String(resource.metadata["id"]);
  const lines = [
    `Task: ${id}`,
    `Phase: ${String(status["phase"])}`,
    `Tag: ${context.tagName ?? "unknown Tag"}`,
    `Session: ${String(spec["sessionId"])}`,
    ...(typeof spec["objectiveId"] === "string" ? [`Objective: ${spec["objectiveId"]}`] : []),
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
  lines.push(...describeFindings(status["findings"]));
  const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).join(", ") : "");
  const scheduling = isRecord(status["scheduling"]) ? status["scheduling"] : undefined;
  if (scheduling && status["phase"] === "pending") {
    lines.push(
      `Last scheduling check: ${String(scheduling["status"])} at ${String(scheduling["observedAt"])}`,
    );
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
    if (status["phase"] === "pending" && !scheduling)
      lines.push(
        "No scheduling diagnosis is recorded; queue status alone does not identify a capacity or connectivity problem.",
      );
  } else {
    lines.push(`Latest Attempt: ${String(attempt["id"])} (${String(attempt["phase"])})`);
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
    if (isRecord(attempt["failure"]) && typeof attempt["failure"]["message"] === "string")
      lines.push(`Recorded failure: ${JSON.stringify(attempt["failure"]["message"])}`);
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
    if (status["phase"] === "cancelled" && placement?.["cleanup"] !== "confirmed")
      lines.push(
        "Cancellation is recorded, but execution cleanup is unconfirmed. This does not prove the process stopped or that Worker Host capacity was released.",
      );
    if (status["phase"] === "cancelled" && attempt["phase"] === "running")
      lines.push(
        "This cancelled Task still holds a Worker Host capacity slot. Reconnect the original Worklet so SuperTag can check the Attempt and release the slot if it never started or has stopped. If the outcome remains unknown, verify that all execution stopped, then use supertag recover worklet --confirm-stopped and reconnect the Worklet.",
      );
    if (isRecord(attempt["lastEvent"]))
      lines.push(
        `Last recorded event: ${String(attempt["lastEvent"]["type"])} at ${String(attempt["lastEvent"]["at"])}`,
      );
  }
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
  if (status["phase"] === "pending") lines.push("Review bindings: supertag list tag");
  return `${lines.map(terminalText).join("\n")}\n`;
}

/**
 * One line per Task Attempt with its provider-reported cost, so the cost of each turn or
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
      return `  ${String(attempt["number"])}. ${String(attempt["id"])} ${String(attempt["phase"])}, started ${String(attempt["startedAt"])}, ${shownCost}`;
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
      : execution["source"] === "default"
        ? "default"
        : undefined;
  const lines =
    execution["source"] === undefined && execution["harness"] === undefined
      ? []
      : [`Execution: ${parts.join(", ")}${why === undefined ? "" : ` (${why})`}`];
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
interface InputDocument extends ManifestDocument {
  /** Relative `file:` secret references resolve against this directory. */
  readonly directory: string;
}

/** What `apply` and `diff` were asked to do beyond reading the input. */
interface ManifestOptions {
  readonly applySet?: string;
  readonly prune: boolean;
  readonly force: boolean;
  /** Resolves `{ secretRef: NAME }` SurfaceAccount secrets; absent for `apply -f`. */
  readonly resolveSecret?: SecretResolver;
  /** Applies only documents whose resource does not exist yet. */
  readonly createOnly?: boolean;
}

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
  /**
   * Create resources that do not exist yet and leave existing ones untouched, as supertag.yaml
   * provisioning does on every `supertag up`.
   */
  readonly createOnly?: boolean;
}

/**
 * Applies, or with `command: "diff"` plans, already parsed manifests through the same pipeline
 * as `supertag apply -f`. supertag.yaml provisioning passes its `provision:` manifests here with
 * a `resolveSecret` backed by its `secrets:` map.
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
  const documents = inputDocuments(
    manifests.map((value, index) => ({
      source: manifests.length === 1 ? label : `${label}[${index}]`,
      value,
      directory,
    })),
    label,
  );
  return runManifests(client, options.command ?? "apply", documents, {
    ...(options.applySet === undefined ? {} : { applySet: parseApplySetName(options.applySet) }),
    prune: options.prune === true,
    force: options.force === true,
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    ...(options.createOnly === true ? { createOnly: true } : {}),
  });
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
  const applied = await runManifests(
    client,
    "apply",
    inputDocuments(entries, "supertag.yaml provision", errors),
    {
      applySet: "provision",
      prune: false,
      force: false,
      createOnly: true,
      ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    },
  );
  return applied.replace(/^(\S+) configured/gmu, "$1 created (provision)");
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
  const { entries, errors } = await readManifestEntries(values.filename);
  return runManifests(client, command, inputDocuments(entries, values.filename, errors), options);
}

/**
 * Sends the input to the Control Plane, which validates, plans and applies it. Apply first
 * resolves each Surface Account's secret references where the CLI runs; the values go only to
 * the Control Plane.
 */
async function runManifests(
  client: ControlPlaneClient,
  command: "apply" | "diff",
  documents: readonly InputDocument[],
  options: ManifestOptions,
): Promise<string> {
  const resources = resourceClient(client.operator);
  const request = {
    applySet: options.applySet ?? "",
    prune: options.prune,
    forceConflicts: options.force,
  };
  if (command === "diff") {
    const planned = await refusedAsError(() =>
      resources
        .diffManifests({
          ...request,
          documents: documents.map((document) => documentMessage(document)),
        })
        .catch((error: unknown) => {
          throw oversizedInputError(error);
        }),
    );
    return renderPlan(documents, planned.plans, planned.pruned);
  }
  const secrets = await resolveSecrets(client, documents, options);
  let applied: ApplyManifestsResponse;
  try {
    applied = await resources.applyManifests({
      ...request,
      createOnly: options.createOnly === true,
      documents: documents.map((document) => documentMessage(document, secrets.get(document))),
    });
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    const oversized = oversizedInputError(error);
    if (oversized !== error) throw oversized;
    const detail = error.findDetails(ErrorDetailSchema)[0];
    const owned = detail?.fields.some((field) => field.manager !== "") === true;
    throw new Error(
      owned
        ? `${operatorErrorMessage(error)}\nRun supertag diff to review, then apply with --force-conflicts to take ownership.`
        : operatorErrorMessage(error),
    );
  }
  return renderApplied(documents, applied);
}

/** Guidance for an input the Control Plane refused for its size, which has no detail; else `error`. */
function oversizedInputError(error: unknown): unknown {
  if (
    error instanceof ConnectError &&
    error.code === Code.ResourceExhausted &&
    error.findDetails(ErrorDetailSchema).length === 0
  )
    return new Error(
      `The input is larger than the ${MANIFEST_INPUT_MAX_BYTES / 1_000_000} MB the Control Plane takes in one apply or diff. Split it into smaller inputs, such as one directory each; with --prune, give each input its own --set, because pruning removes the set's members an input does not declare.`,
    );
  return error;
}

function documentMessage(
  document: InputDocument,
  secrets?: Readonly<Record<string, string>>,
): MessageInitShape<typeof ManifestDocumentSchema> {
  return {
    manifest: JSON.parse(JSON.stringify(document.resource)) as JsonObject,
    source: document.source,
    ...(secrets === undefined ? {} : { secrets: { ...secrets } }),
  };
}

/**
 * The secret values each Surface Account references, read where the CLI runs. Provisioning skips
 * accounts that already exist, which it leaves untouched. A reference that cannot be resolved
 * refuses the whole input before anything is sent.
 */
async function resolveSecrets(
  client: ControlPlaneClient,
  documents: readonly InputDocument[],
  options: ManifestOptions,
): Promise<ReadonlyMap<InputDocument, Readonly<Record<string, string>>>> {
  const resolved = new Map<InputDocument, Readonly<Record<string, string>>>();
  const errors: string[] = [];
  for (const document of documents) {
    if (document.path !== "surface-accounts") continue;
    if (
      options.createOnly === true &&
      (await findResourceView(client.operator, "surface-accounts", document.name)) !== undefined
    )
      continue;
    try {
      resolved.set(
        document,
        await resolveSurfaceSecrets(parseSurfaceAccountManifest(document.resource), {
          baseDirectory: document.directory,
          ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
        }),
      );
    } catch (error) {
      errors.push(`${document.source}: ${label(document)}: ${messageOf(error)}`);
    }
  }
  if (errors.length > 0)
    throw new Error(`Nothing was applied. Invalid manifests:\n  ${errors.toSorted().join("\n  ")}`);
  return resolved;
}

/** What apply did, one line per document; warnings go to standard error. */
function renderApplied(
  documents: readonly InputDocument[],
  applied: ApplyManifestsResponse,
): string {
  const lines: string[] = [];
  const done: string[] = [];
  for (const result of applied.results) {
    const document = documents[result.document];
    const name = document === undefined ? result.name : label(document);
    if (result.outcome !== ManifestOutcome.APPLIED) continue;
    done.push(name);
    if (document?.path === "surface-accounts") {
      const verified = result.verification;
      lines.push(
        verified === undefined
          ? `${name} configured; credentials unchanged`
          : `${name} configured; verified ${nameOf(SURFACE_PROVIDERS, verified.provider) ?? "unknown"} account ${verified.displayName} (${verified.externalAccountId})`,
      );
      continue;
    }
    // Objectives report conditions that would hold their Tasks; the write still succeeded.
    for (const warning of result.warnings)
      process.stderr.write(`Warning: ${terminalText(name)}: ${terminalText(warning)}\n`);
    if (result.notStarted !== "")
      process.stderr.write(
        `Warning: ${terminalText(name)}: the Objective was not started: ${terminalText(result.notStarted).replace(/\.?$/u, ".")} Apply again once that is fixed to start it.\n`,
      );
    if (result.startedTaskId !== "")
      lines.push(`${name} started with Task ${result.startedTaskId}`);
    lines.push(`${name} configured`);
  }
  const failed = applied.results.find((result) => result.outcome === ManifestOutcome.FAILED);
  if (failed !== undefined) {
    const document = documents[failed.document];
    const notApplied = applied.results
      .filter(
        (result) =>
          result.outcome === ManifestOutcome.FAILED ||
          result.outcome === ManifestOutcome.NOT_APPLIED,
      )
      .map((result) => {
        const item = documents[result.document];
        return item === undefined ? result.name : label(item);
      });
    throw new Error(
      [
        `${document === undefined ? failed.name : label(document)} (${document?.source ?? `documents[${failed.document}]`}) failed: ${failed.failureMessage}`,
        `Applied: ${done.join(", ") || "none"}`,
        `Not applied: ${notApplied.join(", ") || "none"}`,
      ].join("\n"),
    );
  }
  return [...lines, ...applied.pruned.map(pruneLine)]
    .map((line) => `${terminalText(line)}\n`)
    .join("");
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

/**
 * The input's documents, checked for shape, kind and duplicates before any secret is read; the
 * Control Plane checks everything else.
 */
function inputDocuments(
  entries: readonly {
    readonly source: string;
    readonly value: unknown;
    readonly directory: string;
  }[],
  input: string,
  errors: readonly string[] = [],
): readonly InputDocument[] {
  const checked = manifestDocuments(entries, errors);
  if (checked.errors.length > 0)
    throw new Error(`Invalid manifests:\n  ${checked.errors.join("\n  ")}`);
  if (checked.documents.length === 0) throw new Error(`${input} contains no manifests`);
  return checked.documents.map((document) => ({
    ...document,
    directory: entries[document.entry]?.directory ?? process.cwd(),
  }));
}

function pruneLine(item: PruneResult): string {
  const name = `${resourceKindName(item.kind)}/${item.name}`;
  if (item.action === PruneAction.DELETE) return `${name} deleted`;
  if (item.action === PruneAction.CANCEL) return `${name} cancelled; its history is kept`;
  return `${name} ${notRemoved(item)}: ${item.reason || "still in use"}`;
}

function notRemoved(item: PruneResult): string {
  return item.kind === ResourceKind.OBJECTIVE ? "not cancelled" : "not deleted";
}

function resourceKindName(kind: ResourceKind): string {
  return resourceKindEntry(kind)?.kind ?? "Resource";
}

/** A Terraform-style plan: one line per resource that changes, then a summary. */
function renderPlan(
  documents: readonly InputDocument[],
  plans: readonly ManifestPlan[],
  pruned: readonly PruneResult[],
): string {
  const rows: { readonly head: string; readonly details: readonly string[] }[] = [];
  const counts = { create: 0, update: 0, delete: 0, cancel: 0, conflict: 0, kept: 0 };
  for (const plan of plans) {
    const document = documents[plan.document];
    const name = `${document?.resource.kind ?? resourceKindName(plan.kind)} ${document?.name ?? plan.name}`;
    const start = plan.startsObjective ? ["starts the Objective"] : [];
    if (plan.held !== "") {
      rows.push({ head: `= ${name}`, details: [plan.held] });
    } else if (plan.refusals.length > 0) {
      for (const refusal of plan.refusals) {
        counts.conflict += 1;
        rows.push({ head: `! ${name}`, details: [`${refusal.path}: ${refusal.reason}`] });
      }
    } else if (plan.action === PlanAction.CREATE) {
      counts.create += 1;
      rows.push({
        head: `+ ${name}`,
        details:
          document?.path === "surface-accounts"
            ? [`${surfaceProvider(document)}; apply reads and verifies its secrets`]
            : start,
      });
    } else if (plan.action === PlanAction.UPDATE) {
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
    const name = `${resourceKindName(item.kind)} ${item.name}`;
    if (item.action === PruneAction.DELETE) {
      counts.delete += 1;
      rows.push({ head: `- ${name}`, details: [] });
    } else if (item.action === PruneAction.CANCEL) {
      counts.cancel += 1;
      rows.push({ head: `- ${name}`, details: ["cancel; its history is kept"] });
    } else {
      counts.kept += 1;
      rows.push({
        head: `= ${name}`,
        details: [`${notRemoved(item)}: ${item.reason || "still in use"}`],
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

function surfaceProvider(document: InputDocument): string {
  const spec = isRecord(document.resource.spec) ? document.resource.spec : {};
  return String(spec["provider"]);
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
      const symbol =
        change.action === FieldChangeAction.ADD
          ? "+"
          : change.action === FieldChangeAction.REMOVE
            ? "-"
            : "~";
      const items = lists.get(entry[1]) ?? [];
      if (!lists.has(entry[1])) {
        lists.set(entry[1], items);
        lines.push(entry[1]);
      }
      items.push(`${symbol} ${entry[2]}`);
      continue;
    }
    const before = change.before === undefined ? undefined : toJson(ValueSchema, change.before);
    const after = change.after === undefined ? undefined : toJson(ValueSchema, change.after);
    lines.push(
      `${path}: ${
        change.action === FieldChangeAction.ADD
          ? `+ ${shortValue(after)}`
          : change.action === FieldChangeAction.REMOVE
            ? `- ${shortValue(before)}`
            : `${shortValue(before)} -> ${shortValue(after)}`
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
  const work = path === "tasks" || path === "sessions" ? workClient(client.operator) : undefined;
  const read = (): Promise<Resource | ResourceList> =>
    work === undefined
      ? name === undefined
        ? readResources(client, path)
        : readResource(client, path, name)
      : (refusedAsError(async () =>
          path === "tasks"
            ? name === undefined
              ? workTasksJson(await recentTasks(work))
              : workTaskJson(await work.getTask({ id: name }))
            : name === undefined
              ? workSessionsJson(await allSessions(work))
              : workSessionJson(await work.getSession({ id: name })),
        ) as Promise<unknown> as Promise<Resource | ResourceList>);
  const first = await read();
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
      const next = await read();
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

function descriptorFor(kind: string): { readonly path: string } {
  if (!Object.hasOwn(resources, kind))
    throw new Error(
      `Unknown resource kind: ${kind}. Use one of: ${Object.keys(resources).join(", ")}`,
    );
  const descriptor = resources[kind as keyof typeof resources];
  return descriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
