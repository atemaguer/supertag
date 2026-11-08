import {
  isValidGitRef,
  MAX_TASK_FINDING_TEXT,
  parseLiveMounts,
  parseMountManifests,
  parseMountOutputManifests,
  parseWorkspaceMounts,
  recordTaskFindings,
  validateArtifactPath,
} from "@supertag/core";
import type { TaskAttemptEvent, TaskAttemptSpec } from "./index.js";

/** Validate the known admission contract without projecting away provider data or extensions. */
export function decodeTaskAttemptSpec(value: unknown): TaskAttemptSpec {
  const spec = object(value, "spec");
  if (spec["version"] !== 2) throw new Error("Task Attempt Spec version must be 2");
  requiredString(spec, "taskId");
  requiredString(spec, "attemptId");
  const tag = requiredObject(spec, "tag");
  requiredString(tag, "id");
  requiredString(tag, "name");
  const profile = requiredObject(spec, "workerProfile");
  requiredString(profile, "id");
  requiredString(profile, "revision");
  const execution = requiredObject(spec, "execution");
  for (const key of ["requires", "prefers"]) {
    const values = execution[key];
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.some(
          (value) =>
            typeof value !== "object" ||
            value === null ||
            typeof value.id !== "string" ||
            !Number.isSafeInteger(value.version) ||
            value.version < 1,
        ))
    )
      throw new Error("Invalid execution capabilities");
  }
  if (execution["harness"] !== undefined) requiredString(execution, "harness");
  if (execution["model"] !== undefined) requiredString(execution, "model");
  if (
    execution["effort"] !== undefined &&
    !["low", "medium", "high"].includes(execution["effort"] as string)
  )
    throw new Error("Invalid execution effort");
  if (execution["profile"] !== undefined) {
    const explicit = requiredObject(execution, "profile");
    requiredString(explicit, "id");
    requiredString(explicit, "revision");
  }
  if (execution["limits"] !== undefined) {
    const limits = requiredObject(execution, "limits");
    for (const key of Object.keys(limits))
      if (key !== "maxNativeAgents" && key !== "maxReportedTokens" && key !== "maxReportedCost")
        throw new Error(`Unknown Task execution limit: ${key}`);
    if (
      limits["maxNativeAgents"] !== undefined &&
      (!Number.isSafeInteger(limits["maxNativeAgents"]) || Number(limits["maxNativeAgents"]) < 0)
    )
      throw new Error("Invalid maxNativeAgents execution limit");
    if (
      limits["maxReportedTokens"] !== undefined &&
      (!Number.isSafeInteger(limits["maxReportedTokens"]) ||
        Number(limits["maxReportedTokens"]) < 1)
    )
      throw new Error("Invalid maxReportedTokens execution limit");
    if (limits["maxReportedCost"] !== undefined) {
      const cost = requiredObject(limits, "maxReportedCost");
      if (Object.keys(cost).some((key) => key !== "amountMinor" && key !== "currency"))
        throw new Error("Unknown maxReportedCost execution limit field");
      if (!Number.isSafeInteger(cost["amountMinor"]) || Number(cost["amountMinor"]) < 0)
        throw new Error("Invalid maxReportedCost amountMinor execution limit");
      if (typeof cost["currency"] !== "string" || !/^[A-Z]{3}$/u.test(cost["currency"]))
        throw new Error("Invalid maxReportedCost currency execution limit");
    }
    if (Object.keys(limits).length === 0)
      throw new Error("Task execution limits must not be empty");
  }
  if (spec["placement"] !== undefined) {
    const placement = requiredObject(spec, "placement");
    items(placement, "allowedWorkerHostIds", stringItem);
    if ((placement["allowedWorkerHostIds"] as unknown[]).length === 0)
      throw new Error("Task Attempt Spec requires at least one allowed Worker Host");
    for (const key of ["workerHostId", "workletId", "workerId"])
      if (placement[key] !== undefined) requiredString(placement, key);
    if (
      placement["coordinationSlot"] !== undefined &&
      typeof placement["coordinationSlot"] !== "boolean"
    )
      throw new Error("Invalid placement coordinationSlot");
    if (placement["reservation"] !== undefined) {
      const reservation = fields(placement["reservation"], ["id", "expiresAt"]);
      requiredString(reservation, "id");
      const expiresAt = requiredString(reservation, "expiresAt");
      if (!Number.isFinite(Date.parse(expiresAt)))
        throw new Error("Invalid placement reservation expiry");
      if (placement["workerHostId"] === undefined || placement["workerId"] === undefined)
        throw new Error("Reserved placement requires a selected Worker Host and Worker");
    }
    if (
      placement["workerHostId"] !== undefined &&
      !(placement["allowedWorkerHostIds"] as unknown[]).includes(placement["workerHostId"])
    )
      throw new Error("Selected Worker Host is outside the allowed Worker Host pool");
  }
  const input = requiredObject(spec, "input");
  const origin = fields(input["origin"], [
    "surface",
    "accountId",
    "scope",
    "sessionKey",
    "occurredAt",
  ]);
  for (const key of ["source", "metadata"])
    if (origin[key] !== undefined) requiredObject(origin, key);
  items(input, "messages", (value) => {
    const message = fields(value, ["id", "text"]);
    choice(message, "role", ["requester", "teammate", "system"]);
    if (message["actor"] !== undefined) actor(message["actor"]);
  });
  if (input["attachments"] !== undefined) items(input, "attachments", resource);
  const authorization = requiredObject(spec, "authorization");
  if (authorization["version"] !== 5 && authorization["version"] !== 4)
    throw new Error("Task Attempt Spec authorization version must be 4 or 5");
  if (spec["coordination"] !== undefined) {
    const coordination = requiredObject(spec, "coordination");
    requiredString(coordination, "controlPlaneUrl");
    requiredString(coordination, "token");
    if (coordination["scope"] !== undefined && coordination["scope"] !== "surface")
      throw new Error("Unknown coordination scope");
    if (coordination["scope"] !== "surface" || coordination["objectiveId"] !== undefined)
      requiredString(coordination, "objectiveId");
  }
  text(authorization, "capturedAt");
  fields(authorization["tag"], ["id", "name"]);
  if (authorization["version"] === 5)
    fields(authorization["origin"], ["tagRouteId", "surfaceAccountId", "provider", "scope"]);
  else {
    const origin = fields(authorization["origin"], ["objectiveId", "requestedByTagId"]);
    choice(origin, "kind", ["internal"]);
  }
  actor(authorization["requester"]);
  items(authorization, "permissionSets", (value) => fields(value, ["id", "name"]));
  if (authorization["roles"] !== undefined)
    items(authorization, "roles", (value) => {
      const assignment = fields(value, ["assignmentId"]);
      if (
        !Number.isSafeInteger(assignment["assignmentRevision"]) ||
        Number(assignment["assignmentRevision"]) < 1
      )
        throw new Error("Worklet protocol Role assignment revision must be positive");
      const role = fields(assignment["role"], ["id", "name", "purpose", "instructions"]);
      if (!Number.isSafeInteger(role["revision"]) || Number(role["revision"]) < 1)
        throw new Error("Worklet protocol Role revision must be positive");
      items(role, "contextSetIds", stringItem);
      items(role, "permissionSetIds", stringItem);
    });
  items(authorization, "resources", (value) => {
    const record = authorizationResource(value);
    items(record, "sources", stringItem);
  });
  items(authorization, "runtimeActions", stringItem);
  if (authorization["mcp"] !== undefined)
    items(authorization, "mcp", (value) => {
      const grant = fields(value, ["action"]);
      if (grant["resource"] !== undefined) requiredString(grant, "resource");
    });
  if (authorization["approvals"] !== undefined)
    items(authorization, "approvals", (value) => {
      const requirement = fields(value, ["action"]);
      choice(requirement, "target", ["surface", "runtime", "mcp"]);
      if (requirement["target"] === "surface") fields(value, ["surfaceAccountId", "scope"]);
      if (requirement["target"] === "mcp" && requirement["resource"] !== undefined)
        requiredString(requirement, "resource");
      items(requirement, "permissionSets", stringItem);
      items(requirement, "approvers", stringItem);
    });
  const contextPlan = requiredObject(spec, "contextPlan");
  if (contextPlan["version"] !== 7 || !Array.isArray(contextPlan["sets"])) {
    throw new Error("Task Attempt Spec Context Plan must be version 7 with a sets array");
  }
  text(contextPlan, "capturedAt");
  items(contextPlan, "sets", (value) => {
    const set = fields(value, ["id", "name"]);
    items(set, "items", (value) => {
      const item = fields(value, ["id", "itemKey", "type"]);
      if (!Number.isSafeInteger(item["version"]) || Number(item["version"]) < 1)
        throw new Error("Worklet protocol context item version must be a positive integer");
      if (typeof item["required"] !== "boolean")
        throw new Error("Worklet protocol context item required must be a boolean");
      requiredObject(item, "config");
      if (item["snapshot"] !== undefined) requiredObject(item, "snapshot");
    });
  });
  workspacePlan(spec["workspacePlan"]);
  if (spec["session"] !== undefined) {
    const session = fields(spec["session"], ["id"]);
    if (session["sessionState"] !== undefined) sessionState(session["sessionState"]);
    if (session["persistence"] !== undefined) {
      const persistence = requiredObject(session, "persistence");
      requiredString(persistence, "controlPlaneUrl");
      requiredString(persistence, "token");
      if (Object.keys(persistence).some((key) => key !== "controlPlaneUrl" && key !== "token"))
        throw new Error("Unknown Session persistence field");
    }
    if (session["history"] !== undefined) items(session, "history", taskHistoryEntry);
  }
  return spec as unknown as TaskAttemptSpec;
}

/**
 * Validate known event payloads at the wire boundary without projecting away extensions.
 * Unknown event kinds are rejected. Ordering, capability support,
 * timestamp semantics and terminal-state policy belong to their existing owners.
 */
export function decodeTaskAttemptEvent(value: unknown): TaskAttemptEvent {
  const event = object(value, "event");
  let normalized: Record<string, unknown> = event;
  for (const key of ["taskId", "attemptId", "at", "type"]) requiredString(event, key);
  switch (event["type"]) {
    case "execution.completed":
      break;
    case "execution.started":
      requiredString(event, "workerId");
      break;
    case "execution.limits.applied":
      executionLimitReport(event);
      break;
    case "output.delta":
      text(event, "text");
      break;
    case "output.message":
      fields(event["message"], ["role", "text"]);
      break;
    case "input.withdrawn":
      requiredString(event, "commandId");
      break;
    case "execution.failed":
    case "execution.uncertain":
      fields(event["error"], ["name", "message"]);
      break;
    case "artifact.created":
      resource(event["artifact"]);
      fields(event["artifact"], ["id"]);
      break;
    case "session.updated":
      sessionState(event["sessionState"]);
      break;
    case "result":
      normalized = normalizeResultFindingText(event);
      result(normalized["result"]);
      break;
    case "tool.call.started":
      toolCall(event["call"]);
      break;
    case "tool.call.completed":
      toolCall(event["call"]);
      if (event["outcome"] !== undefined)
        items(requiredObject(event, "outcome"), "references", stringItem);
      break;
    case "tool.call.failed":
      toolCall(event["call"]);
      fields(event["error"], ["message"]);
      break;
    case "approval.requested": {
      const request = fields(event["request"], ["id", "description"]);
      if (request["data"] !== undefined) requiredObject(request, "data");
      break;
    }
    case "command.updated": {
      const command = fields(event["command"], ["id", "command", "status"]);
      if (!["running", "completed", "failed"].includes(String(command["status"])))
        throw new Error("Worklet protocol command status must be running, completed, or failed");
      break;
    }
    case "agent.updated":
      fields(event["agent"], ["id", "status"]);
      break;
    case "usage.updated": {
      const usage = requiredObject(event, "usage");
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"])
        if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]))
          throw new Error(`Worklet protocol ${key} must be a finite number`);
      for (const key of ["cacheWriteTokens", "reasoningTokens"])
        if (
          usage[key] !== undefined &&
          (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)
        )
          throw new Error(`Worklet protocol ${key} must be a nonnegative integer`);
      if (typeof usage["complete"] !== "boolean")
        throw new Error("Worklet protocol usage.complete must be a boolean");
      if (usage["reportedCost"] !== undefined) {
        const cost = requiredObject(usage, "reportedCost");
        if (!Number.isSafeInteger(cost["amountMinor"]) || Number(cost["amountMinor"]) < 0)
          throw new Error("Worklet protocol reported cost must be a nonnegative integer");
        if (typeof cost["currency"] !== "string" || !/^[A-Z]{3}$/u.test(cost["currency"]))
          throw new Error(
            "Worklet protocol reported cost currency must be an uppercase three-letter code",
          );
      }
      break;
    }
    case "progress.updated": {
      const progress = fields(event["progress"], ["summary"]);
      if (progress["items"] !== undefined)
        items(progress, "items", (item) => fields(item, ["id", "text", "status"]));
      normalized = normalizeProgressText(event);
      break;
    }
    case "workspace.mcp.resolved":
      mcpDigest(event["digest"], "workspace.mcp.resolved digest");
      break;
    case "workspace.mounts.attached":
      try {
        parseLiveMounts(event["mounts"]);
      } catch (error) {
        throw new Error(
          `Worklet protocol workspace.mounts.attached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    case "workspace.mounts.copied":
      try {
        parseMountManifests(event["mounts"]);
      } catch (error) {
        throw new Error(
          `Worklet protocol workspace.mounts.copied: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    case "workspace.mounts.written":
      try {
        parseMountOutputManifests(event["mounts"]);
      } catch (error) {
        throw new Error(
          `Worklet protocol workspace.mounts.written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    case "runtime-inputs.resolved": {
      const manifest = requiredObject(event, "manifest");
      fields(manifest["workerProfile"], ["id", "revision"]);
      fields(manifest["harness"], ["id", "version"]);
      runtimeEnvironmentManifest(manifest["executionEnvironment"]);
      if (manifest["harnessRuntime"] !== undefined)
        runtimeEnvironmentManifest(manifest["harnessRuntime"]);
      items(manifest, "inputs", (item) => fields(item, ["id", "kind"]));
      items(manifest, "omitted", (item) => fields(item, ["id", "kind", "reason"]));
      break;
    }
    default:
      throw new Error(`Unsupported Task Attempt event type: ${event["type"]}`);
  }
  return normalized as unknown as TaskAttemptEvent;
}

function truncateText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function normalizeProgressText(event: Record<string, unknown>): Record<string, unknown> {
  const progress = event["progress"] as Record<string, unknown>;
  const summary = truncateText(progress["summary"] as string, 240);
  const items = progress["items"] as Record<string, unknown>[] | undefined;
  const normalizedItems = items?.map((item) => {
    const text = truncateText(item["text"] as string, 160);
    return text === item["text"] ? item : { ...item, text };
  });
  if (
    summary === progress["summary"] &&
    (items === undefined || normalizedItems?.every((item, i) => item === items[i]))
  )
    return event;
  return {
    ...event,
    progress: { ...progress, summary, ...(items ? { items: normalizedItems } : {}) },
  };
}

function normalizeResultFindingText(event: Record<string, unknown>): Record<string, unknown> {
  const result = event["result"] as Record<string, unknown>;
  if (!Array.isArray(result["findings"])) return event;
  const findings = result["findings"] as Record<string, unknown>[];
  const normalized = findings.map((finding) => {
    if (!finding || typeof finding !== "object") return finding;
    const summary =
      typeof finding["summary"] === "string"
        ? truncateText(finding["summary"], MAX_TASK_FINDING_TEXT)
        : finding["summary"];
    const location =
      typeof finding["location"] === "string"
        ? truncateText(finding["location"], MAX_TASK_FINDING_TEXT)
        : finding["location"];
    return summary === finding["summary"] && location === finding["location"]
      ? finding
      : { ...finding, summary, ...(location === undefined ? {} : { location }) };
  });
  return normalized.every((finding, i) => finding === findings[i])
    ? event
    : { ...event, result: { ...result, findings: normalized } };
}

function runtimeEnvironmentManifest(value: unknown): void {
  const environment = fields(value, ["id", "provider", "placement"]);
  choice(environment, "placement", ["local", "remote", "managed"]);
  if (environment["provenance"] !== undefined) requiredObject(environment, "provenance");
  if (environment["guarantees"] === undefined) return;
  const guarantees = requiredObject(environment, "guarantees");
  choice(guarantees, "filesystemIsolation", ["none", "sandbox"]);
  choice(guarantees, "networkPolicy", ["none", "enforced"]);
  for (const key of ["processTreeTermination", "scopedHttp"])
    if (typeof guarantees[key] !== "boolean")
      throw new Error(`Worklet protocol environment guarantee ${key} must be a boolean`);
}

function executionLimitReport(event: Record<string, unknown>): void {
  const requested = requiredObject(event, "requested");
  const applied = requiredObject(event, "applied");
  const keys = ["maxNativeAgents", "maxReportedTokens", "maxReportedCost"];
  for (const [label, limits] of [
    ["requested", requested],
    ["applied", applied],
  ] as const)
    for (const key of Object.keys(limits))
      if (!keys.includes(key)) throw new Error(`Unknown ${label} execution limit: ${key}`);

  const requestedNative = optionalSafeInteger(requested, "maxNativeAgents", 0);
  const requestedTokens = optionalSafeInteger(requested, "maxReportedTokens", 1);
  const requestedCost = optionalMoney(requested, "maxReportedCost");
  const appliedNative = optionalAppliedNumber(applied, "maxNativeAgents", 0, [
    "provider-native",
    "harness-guard",
  ]);
  const appliedTokens = optionalAppliedNumber(applied, "maxReportedTokens", 1, [
    "interrupt-on-report",
  ]);
  const appliedCost = optionalAppliedMoney(applied, "maxReportedCost", ["provider-budget"]);

  if (requestedNative !== undefined && appliedNative === undefined)
    throw new Error("Applied limits omit requested maxNativeAgents");
  if (requestedTokens !== undefined && appliedTokens === undefined)
    throw new Error("Applied limits omit requested maxReportedTokens");
  if (requestedCost !== undefined && appliedCost === undefined)
    throw new Error("Applied limits omit requested maxReportedCost");
  if (
    requestedNative !== undefined &&
    appliedNative !== undefined &&
    appliedNative.limit > requestedNative
  )
    throw new Error("Applied maxNativeAgents exceeds the requested limit");
  if (
    requestedTokens !== undefined &&
    appliedTokens !== undefined &&
    appliedTokens.limit > requestedTokens
  )
    throw new Error("Applied maxReportedTokens exceeds the requested limit");
  if (
    requestedCost !== undefined &&
    appliedCost !== undefined &&
    (appliedCost.amountMinor > requestedCost.amountMinor ||
      appliedCost.currency !== requestedCost.currency)
  )
    throw new Error("Applied maxReportedCost exceeds or changes the requested limit");
}

function optionalSafeInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
): number | undefined {
  if (value[key] === undefined) return undefined;
  if (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum)
    throw new Error(`Worklet protocol ${key} must be an integer of at least ${minimum}`);
  return Number(value[key]);
}

function optionalMoney(
  value: Record<string, unknown>,
  key: string,
): { readonly amountMinor: number; readonly currency: string } | undefined {
  if (value[key] === undefined) return undefined;
  const money = requiredObject(value, key);
  if (Object.keys(money).some((field) => field !== "amountMinor" && field !== "currency"))
    throw new Error(`Unknown Worklet protocol ${key} field`);
  if (!Number.isSafeInteger(money["amountMinor"]) || Number(money["amountMinor"]) < 0)
    throw new Error(`Worklet protocol ${key}.amountMinor must be a nonnegative integer`);
  if (typeof money["currency"] !== "string" || !/^[A-Z]{3}$/u.test(money["currency"]))
    throw new Error(`Worklet protocol ${key}.currency must be an uppercase three-letter code`);
  return { amountMinor: Number(money["amountMinor"]), currency: money["currency"] };
}

function optionalAppliedNumber(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  methods: readonly string[],
): { readonly limit: number } | undefined {
  if (value[key] === undefined) return undefined;
  const applied = requiredObject(value, key);
  if (Object.keys(applied).some((field) => field !== "limit" && field !== "method"))
    throw new Error(`Unknown applied ${key} field`);
  const limit = optionalSafeInteger(applied, "limit", minimum);
  if (limit === undefined) throw new Error(`Applied ${key} limit is required`);
  if (typeof applied["method"] !== "string" || !methods.includes(applied["method"]))
    throw new Error(`Invalid applied ${key} method`);
  return { limit };
}

function optionalAppliedMoney(
  value: Record<string, unknown>,
  key: string,
  methods: readonly string[],
): { readonly amountMinor: number; readonly currency: string } | undefined {
  if (value[key] === undefined) return undefined;
  const applied = requiredObject(value, key);
  if (Object.keys(applied).some((field) => field !== "limit" && field !== "method"))
    throw new Error(`Unknown applied ${key} field`);
  const limit = optionalMoney(applied, "limit");
  if (limit === undefined) throw new Error(`Applied ${key} limit is required`);
  if (typeof applied["method"] !== "string" || !methods.includes(applied["method"]))
    throw new Error(`Invalid applied ${key} method`);
  return limit;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Worklet protocol ${label} must be an object`);
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return object(value[key], key);
}
function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0)
    throw new Error(`Worklet protocol ${key} must be non-empty`);
  return result;
}
function text(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string") throw new Error(`Worklet protocol ${key} must be a string`);
}
function items(value: Record<string, unknown>, key: string, check: (item: unknown) => void): void {
  const values = value[key];
  if (!Array.isArray(values)) throw new Error(`Worklet protocol ${key} must be an array`);
  for (const item of values) check(item);
}
function stringItem(value: unknown): void {
  if (typeof value !== "string") throw new Error("Worklet protocol array item must be a string");
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value, "payload");
  for (const key of keys) text(record, key);
  return record;
}
function resource(value: unknown): void {
  const ref = fields(value, ["uri"]);
  for (const key of ["mediaType", "digest", "name"]) if (ref[key] !== undefined) text(ref, key);
  if (ref["provenance"] !== undefined) requiredObject(ref, "provenance");
  // A catalog selection names an entry path; a Worker's own output may carry a path alone.
  if (ref["artifactId"] !== undefined) text(ref, "artifactId");
  if (ref["artifactId"] !== undefined || ref["path"] !== undefined) {
    text(ref, "path");
    validateArtifactPath(ref["path"] as string);
  }
}
function toolCall(value: unknown): void {
  const call = fields(value, ["id", "capabilityId", "provider", "operation", "effect"]);
  fields(call["binding"], ["kind", "name"]);
  items(call, "actions", stringItem);
  items(call, "resources", (item) => fields(item, ["surfaceAccountId", "scope"]));
  if (call["arguments"] !== undefined) requiredObject(call, "arguments");
}
function result(value: unknown): void {
  const record = fields(value, ["summary"]);
  items(record, "decisions", (item) => fields(item, ["text"]));
  items(record, "changes", (item) => fields(item, ["summary"]));
  items(record, "unresolved", stringItem);
  // A Worker reports each finding's severity, summary, and optional location; the Control Plane
  // assigns its id, so any the Worker sends is ignored. Findings describe only this Task: unknown
  // fields, such as another Task's id, are refused.
  if (!Array.isArray(record["findings"])) throw new Error("Task result findings must be an array");
  recordTaskFindings(record["findings"]);
  items(record, "references", (item) =>
    fields(item, ["provider", "resourceType", "reference", "relationship"]),
  );
  items(record, "artifacts", (value) => {
    const selection = fields(value, ["artifactId"]);
    items(selection, "paths", (path) => {
      stringItem(path);
      validateArtifactPath(path as string);
    });
    const paths = selection["paths"] as string[];
    if (paths.length === 0 || paths.length > 100 || new Set(paths).size !== paths.length)
      throw new Error("Artifact selection requires 1 through 100 unique paths");
    if (Object.keys(selection).some((key) => key !== "artifactId" && key !== "paths"))
      throw new Error("Artifact results require catalog selections");
  });
}

function choice(record: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (typeof record[key] !== "string" || !values.includes(record[key]))
    throw new Error(`Worklet protocol ${key} must be one of ${values.join(", ")}`);
}
function actor(value: unknown): void {
  const record = fields(value, ["id"]);
  choice(record, "kind", ["bot", "user", "unknown"]);
  if (record["displayName"] !== undefined) text(record, "displayName");
}
function authorizationResource(value: unknown): Record<string, unknown> {
  const record = fields(value, ["provider", "surfaceAccountId", "scope"]);
  items(record, "actions", stringItem);
  if (record["reference"] !== undefined) text(record, "reference");
  return record;
}
function workspacePlan(value: unknown): void {
  const plan = object(value, "workspacePlan");
  if (plan["version"] !== 1) throw new Error("Worklet protocol workspacePlan version must be 1");
  choice(plan, "status", ["none", "selected", "selection-required", "unavailable", "workspace"]);
  if (plan["status"] === "selected") {
    choice(plan, "selectedBy", ["default", "origin", "request"]);
    authorizationResource(plan["target"]);
  } else if (plan["status"] === "selection-required") items(plan, "choices", authorizationResource);
  else if (plan["status"] === "unavailable") items(plan, "requested", stringItem);
  else if (plan["status"] === "workspace") {
    text(plan, "workspace");
    text(plan, "branch");
    if (plan["branchPin"] !== undefined) {
      text(plan, "branchPin");
      const pin = plan["branchPin"] as string;
      if (!pin.startsWith("supertag/") || !isValidGitRef(pin))
        throw new Error("workspacePlan branchPin must be a valid Task branch");
    }
    if (plan["branchPinHead"] !== undefined) {
      text(plan, "branchPinHead");
      if (
        plan["branchPin"] === undefined ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(plan["branchPinHead"] as string)
      )
        throw new Error("workspacePlan branchPinHead requires branchPin and a full commit id");
    }
    choice(plan, "delivery", ["patch", "branch", "pull-request"]);
    if (plan["ref"] !== undefined) text(plan, "ref");
    if (plan["setup"] !== undefined) text(plan, "setup");
    if (plan["mcp"] !== undefined) items(plan, "mcp", stringItem);
    if (plan["mounts"] !== undefined) parseWorkspaceMounts(plan["mounts"]);
    if (plan["mcpPin"] !== undefined) mcpDigest(plan["mcpPin"], "workspacePlan mcpPin");
    if (plan["volumes"] !== undefined) items(plan, "volumes", workspaceVolume);
  }
}
/** A Volume as dispatched: a source and a credential name, never a credential value. */
function workspaceVolume(value: unknown): void {
  const volume = fields(value, ["name", "source"]);
  if (volume["credential"] !== undefined) text(volume, "credential");
  if (Object.keys(volume).some((key) => !["name", "source", "credential"].includes(key)))
    throw new Error(
      "Worklet protocol workspacePlan volumes carry only name, source, and credential",
    );
}
function mcpDigest(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error(`Worklet protocol ${label} must be a sha256 digest`);
}
function sessionState(value: unknown): void {
  resource(value);
  fields(value, ["id", "format"]);
}
function taskHistoryEntry(value: unknown): void {
  const entry = fields(value, ["taskId", "sessionId", "tagId", "completedAt"]);
  if (entry["requestText"] !== undefined) text(entry, "requestText");
  result(entry["result"]);
}
