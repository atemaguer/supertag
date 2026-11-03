import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  type HarnessControlCapabilities,
  type HarnessControlCommand,
  validateHarnessControlCapabilities,
  validateHarnessControlCommand,
} from "@supertag/worker-sdk";
import { decodeTaskAttemptEvent, decodeTaskAttemptSpec } from "./attempt-codec.js";
import * as p from "./gen/supertag/worklet/v1/worklet_pb.js";
import type { WorkletClientMessage, WorkletServerMessage } from "./index.js";

export const WORKLET_GRPC_MAX_BYTES = 4 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 3 * 1024 * 1024;
const statuses = ["", "accepted", "running", "completed", "failed", "cancelled", "unknown"];
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected payload object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Unsafe wire integer");
  return Number(value);
}
/** Validates advertised Workspace names; a Worker Host never sends checkout paths. */
export function workspaceNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Worker Host workspaces must be an array of at most 64 names");
  const names = value.map((name) => {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(name))
      throw new Error("Worker Host workspace names must be Workspace names, never paths");
    return name;
  });
  if (new Set(names).size !== names.length)
    throw new Error("Worker Host workspace names must be unique");
  return names;
}

/** Validates advertised placement labels: lowercase, unique, and at most 64. */
export function workerHostLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Worker Host labels must be an array of at most 64 labels");
  const labels = value.map((label) => {
    // Automatic workspace and MCP login labels carry a full name, so they may exceed 63 characters.
    if (
      typeof label !== "string" ||
      !(
        /^[a-z0-9][a-z0-9._:-]{0,62}$/u.test(label) ||
        /^workspace:[a-z0-9][a-z0-9_-]{0,62}$/u.test(label) ||
        /^mcp-login:[a-z0-9][a-z0-9_-]{0,58}$/u.test(label)
      )
    )
      throw new Error("Worker Host labels must be lowercase labels");
    return label;
  });
  if (new Set(labels).size !== labels.length) throw new Error("Worker Host labels must be unique");
  return labels;
}

/** The most Task Attempts one Worker may run at once, at connection and on resize. */
export const MAX_WORKER_CONCURRENCY = 1_000;
/** The most Task Attempts all Workers of one Worker Host may run at once. */
export const MAX_WORKER_HOST_CAPACITY = 10_000;

/** Validate one heartbeat's per-Attempt changed-path reports before wire encoding or use. */
export function changedPathReports(value: unknown): {
  attemptId: string;
  paths: string[];
  truncated: boolean;
}[] {
  if (!Array.isArray(value) || value.length > MAX_WORKER_HOST_CAPACITY)
    throw new Error("Changed paths must be an array of Task Attempt reports");
  const seen = new Set<string>();
  return value.map((entry) => {
    const report = object(entry);
    const attemptId = report["attemptId"];
    const paths = report["paths"];
    const truncated = report["truncated"];
    if (typeof attemptId !== "string" || attemptId.length === 0 || seen.has(attemptId))
      throw new Error("Changed paths require unique Task Attempt IDs");
    seen.add(attemptId);
    if (!Array.isArray(paths) || paths.length > 500 || typeof truncated !== "boolean")
      throw new Error("Changed paths require at most 500 paths and a truncated flag");
    const validPaths = paths.map((path) => {
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.length > 4096 ||
        path.startsWith("/") ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".." || part === ".git")
      )
        throw new Error("Changed paths must be repository-relative paths outside .git");
      return path;
    });
    if (new Set(validPaths).size !== validPaths.length)
      throw new Error("Changed paths must be unique per Task Attempt");
    return { attemptId, paths: validPaths, truncated };
  });
}

/** Task Attempts each Worker runs at once, by Worker ID, as a heartbeat reports them. */
export function workerConcurrencyLimits(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Worker concurrency must be an object of Worker IDs");
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error("Worker concurrency names at most 64 Workers");
  for (const [workerId, limit] of entries)
    if (
      workerId.length === 0 ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_WORKER_CONCURRENCY
    )
      throw new Error(
        `Worker concurrency must be a whole number from 1 through ${MAX_WORKER_CONCURRENCY} per Worker`,
      );
  return Object.fromEntries(entries) as Record<string, number>;
}

export function wireUint32(value: unknown): number {
  const result = number(value);
  if (result > 0xffff_ffff) throw new Error("Worklet uint32 exceeds wire range");
  return result;
}
function uint(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe wire integer");
  return Number(value);
}
function document(value: unknown): p.SchemaDocument {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > DOCUMENT_MAX_BYTES) throw new Error("Worklet schema document exceeds limit");
  return create(p.SchemaDocumentSchema, { version: 1, json });
}
function readDocument(value: p.SchemaDocument | undefined): Record<string, unknown> {
  if (value?.version !== 1 || value.json.length > DOCUMENT_MAX_BYTES)
    throw new Error("Unsupported or oversized Worklet schema document");
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value.json)));
}
function spec(value: unknown): p.AttemptSpec {
  const decoded = decodeTaskAttemptSpec(value);
  const doc = document(decoded);
  return create(p.AttemptSpecSchema, {
    taskId: decoded.taskId,
    attemptId: decoded.attemptId,
    taskAttemptSpec: doc,
    payloadSha256: createHash("sha256").update(doc.json).digest("hex"),
  });
}
function readSpec(value: p.AttemptSpec | undefined) {
  if (!value) throw new Error("Missing Attempt specification");
  const decoded = decodeTaskAttemptSpec(readDocument(value.taskAttemptSpec));
  if (
    decoded.taskId !== value.taskId ||
    decoded.attemptId !== value.attemptId ||
    value.payloadSha256 !==
      createHash("sha256")
        .update(value.taskAttemptSpec?.json ?? new Uint8Array())
        .digest("hex")
  )
    throw new Error("Attempt specification identity or digest mismatch");
  return decoded;
}
function capabilities(value: unknown): p.ControlCapabilities {
  const cap = value as HarnessControlCapabilities;
  validateHarnessControlCapabilities(cap);
  return create(p.ControlCapabilitiesSchema, {
    version: wireUint32(cap.version),
    operations: [...cap.operations],
    ...(cap.inputMode === undefined ? {} : { inputMode: cap.inputMode }),
  });
}
function readCapabilities(value: p.ControlCapabilities) {
  const cap = {
    version: value.version,
    operations: value.operations,
    ...(value.inputMode === undefined ? {} : { inputMode: value.inputMode }),
  } as HarnessControlCapabilities;
  validateHarnessControlCapabilities(cap);
  return cap;
}
function profile(value: unknown): p.Profile {
  const item = object(value);
  const id = text(item["id"]);
  const revision = text(item["revision"]);
  if (!id || !revision) throw new Error("Invalid Worklet profile");
  return create(p.ProfileSchema, { id, revision });
}
function selectionOptions(value: unknown): p.PlacementSelectionOptions {
  const options = object(value);
  const requiresCoordination = options["requiresCoordination"];
  const requiresSurfaceCoordination = options["requiresSurfaceCoordination"];
  const coordinationSlot = options["coordinationSlot"];
  if (requiresCoordination !== undefined && typeof requiresCoordination !== "boolean")
    throw new Error("Invalid Worklet placement coordination option");
  if (requiresSurfaceCoordination !== undefined && typeof requiresSurfaceCoordination !== "boolean")
    throw new Error("Invalid Worklet placement surface coordination option");
  if (coordinationSlot !== undefined && typeof coordinationSlot !== "boolean")
    throw new Error("Invalid Worklet placement coordination slot option");
  const allowedWorkerHostIds = options["allowedWorkerHostIds"];
  if (
    allowedWorkerHostIds !== undefined &&
    (!Array.isArray(allowedWorkerHostIds) ||
      allowedWorkerHostIds.some((id) => typeof id !== "string"))
  )
    throw new Error("Invalid Worklet placement host restriction");
  return create(p.PlacementSelectionOptionsSchema, {
    ...(requiresCoordination === undefined ? {} : { requiresCoordination }),
    ...(requiresSurfaceCoordination === undefined ? {} : { requiresSurfaceCoordination }),
    ...(coordinationSlot === undefined ? {} : { coordinationSlot }),
    ...(options["compatibleProfile"] === undefined
      ? {}
      : { compatibleProfile: profile(options["compatibleProfile"]) }),
    ...(allowedWorkerHostIds === undefined
      ? {}
      : {
          allowedWorkerHostIds: create(p.AllowedWorkerHostIdsSchema, {
            ids: allowedWorkerHostIds,
          }),
        }),
  });
}
function readSelectionOptions(value: p.PlacementSelectionOptions | undefined) {
  if (!value) throw new Error("Missing Worklet placement selection options");
  const result = {
    ...(value.requiresCoordination === undefined
      ? {}
      : { requiresCoordination: value.requiresCoordination }),
    ...(value.requiresSurfaceCoordination === undefined
      ? {}
      : { requiresSurfaceCoordination: value.requiresSurfaceCoordination }),
    ...(value.coordinationSlot === undefined ? {} : { coordinationSlot: value.coordinationSlot }),
    ...(value.compatibleProfile === undefined
      ? {}
      : {
          compatibleProfile: {
            id: value.compatibleProfile.id,
            revision: value.compatibleProfile.revision,
          },
        }),
    ...(value.allowedWorkerHostIds === undefined
      ? {}
      : { allowedWorkerHostIds: value.allowedWorkerHostIds.ids }),
  };
  selectionOptions(result);
  return result;
}
function placement(value: unknown): p.Placement {
  const item = object(value);
  const workerHostId = text(item["workerHostId"]);
  const workletId = text(item["workletId"]);
  const workerId = text(item["workerId"]);
  if (!workerHostId || !workletId || !workerId)
    throw new Error("Invalid Worklet placement identity");
  let reservation: p.PlacementReservation | undefined;
  if (item["reservation"] !== undefined) {
    const source = object(item["reservation"]);
    const id = text(source["id"]);
    const expiresAt = text(source["expiresAt"]);
    if (!id || !Number.isFinite(Date.parse(expiresAt)))
      throw new Error("Invalid Worklet placement reservation");
    reservation = create(p.PlacementReservationSchema, { id, expiresAt });
  }
  return create(p.PlacementSchema, {
    workerHostId,
    workletId,
    workerId,
    workerProfile: profile(item["workerProfile"]),
    ...(reservation === undefined ? {} : { reservation }),
  });
}
function readPlacement(value: p.Placement | undefined) {
  if (!value?.workerProfile) throw new Error("Missing Worklet placement or profile");
  const result = {
    workerHostId: value.workerHostId,
    workletId: value.workletId,
    workerId: value.workerId,
    workerProfile: { id: value.workerProfile.id, revision: value.workerProfile.revision },
    ...(value.reservation === undefined
      ? {}
      : {
          reservation: { id: value.reservation.id, expiresAt: value.reservation.expiresAt },
        }),
  };
  // Apply the same identity and timestamp checks on both encoding and decoding.
  placement(result);
  return result;
}
function receipt(value: Record<string, unknown>): p.AttemptReceipt {
  const status = statuses.indexOf(text(value["status"]));
  if (status < 1) throw new Error("Unknown Attempt receipt status");
  return create(p.AttemptReceiptSchema, {
    taskId: text(value["taskId"]),
    attemptId: text(value["attemptId"]),
    specDigest: text(value["specDigest"]),
    status,
    ...(value["workerId"] === undefined ? {} : { workerId: text(value["workerId"]) }),
    ...(value["lastSequence"] === undefined
      ? {}
      : { lastSequence: BigInt(number(value["lastSequence"])) }),
    ...(value["cancellationRequested"] === undefined
      ? {}
      : { cancellationRequested: value["cancellationRequested"] === true }),
    ...(value["control"] === undefined ? {} : { control: capabilities(value["control"]) }),
  });
}
function readReceipt(value: p.AttemptReceipt) {
  const status = statuses[value.status];
  if (!status) throw new Error("Unknown Attempt receipt status");
  return {
    taskId: value.taskId,
    attemptId: value.attemptId,
    specDigest: value.specDigest,
    status,
    ...(value.workerId === undefined ? {} : { workerId: value.workerId }),
    ...(value.lastSequence === undefined ? {} : { lastSequence: uint(value.lastSequence) }),
    ...(value.cancellationRequested === undefined
      ? {}
      : { cancellationRequested: value.cancellationRequested }),
    ...(value.control === undefined ? {} : { control: readCapabilities(value.control) }),
  };
}
export function encodeHostFrame(message: WorkletClientMessage): p.ConnectRequest {
  let frame: p.ConnectRequest["frame"];
  switch (message.type) {
    case "hello": {
      const d = message.worklet;
      if (
        d.durableProtocolVersion !== 1 ||
        message.protocolVersions.length !== 1 ||
        message.protocolVersions[0] !== 18
      )
        throw new Error("gRPC requires durable Worklet protocol 18");
      for (const worker of d.host.workers)
        if (!Array.isArray(worker.profileCapabilities))
          throw new Error("Worker must declare profileCapabilities");
      frame = {
        case: "hello",
        value: create(p.HelloSchema, {
          protocolVersions: message.protocolVersions.map(wireUint32),
          workletId: d.id,
          workerHostId: d.host.id,
          descriptorVersion: wireUint32(d.protocolVersion),
          durableProtocolVersion: wireUint32(d.durableProtocolVersion),
          ...(d.controlProtocolVersion === undefined
            ? {}
            : { controlProtocolVersion: wireUint32(d.controlProtocolVersion) }),
          workspaces: [...(d.host.workspaces ?? [])],
          labels: [...(d.host.labels ?? [])],
          workers: d.host.workers.map((w) => ({
            id: w.id,
            type: w.type,
            ...(w.maxConcurrency === undefined
              ? {}
              : { maxConcurrency: wireUint32(w.maxConcurrency) }),
            capabilities: w.capabilities.map((cap) => ({
              ...cap,
              version: wireUint32(cap.version),
            })),
            profiles: [...w.profiles],
            contextTypes: w.contextTypes.map((c) => ({
              ...c,
              versions: c.versions.map(wireUint32),
            })),
            profileCapabilities: {
              entries: w.profileCapabilities.map((c) => ({
                ...c,
                models: [...(c.models ?? [])],
                efforts: [...(c.efforts ?? [])],
                capabilities: c.capabilities.map((cap) => ({
                  ...cap,
                  version: wireUint32(cap.version),
                })),
                contextTypes: c.contextTypes.map((t) => ({
                  ...t,
                  versions: t.versions.map(wireUint32),
                })),
              })),
            },
          })),
        }),
      };
      break;
    }
    case "heartbeat":
      frame = {
        case: "heartbeat",
        value: create(p.HeartbeatSchema, {
          at: message.at,
          ...(message.changedPaths === undefined
            ? {}
            : {
                changedPaths: changedPathReports(message.changedPaths).map((report) =>
                  create(p.AttemptChangedPathsSchema, report),
                ),
              }),
          ...(message.hostLabels === undefined
            ? {}
            : { hostLabels: create(p.HostLabelsSchema, { labels: [...message.hostLabels] }) }),
          ...(message.workerConcurrency === undefined
            ? {}
            : {
                workerConcurrency: create(p.WorkerConcurrencySchema, {
                  limits: workerConcurrencyLimits(message.workerConcurrency),
                }),
              }),
          ...(message.diskSpace === undefined
            ? {}
            : {
                diskSpace: create(p.DiskSpaceSchema, {
                  freeBytes: BigInt(message.diskSpace.freeBytes),
                  totalBytes: BigInt(message.diskSpace.totalBytes),
                }),
              }),
        }),
      };
      break;
    case "control_take":
      frame = {
        case: "controlTake",
        value: create(p.ControlTakeSchema, { requestId: message.requestId }),
      };
      break;
    case "durable_reply": {
      let result: p.DurableReply["result"];
      if (message.error !== undefined) result = { case: "error", value: message.error };
      else if (message.resultKind === "placement")
        result = { case: "placement", value: placement(message.result) };
      else if (message.resultKind === "no_placement")
        result = { case: "noPlacement", value: create(p.EmptySchema) };
      else if (message.resultKind === "placement_release") {
        const released = object(message.result)["released"];
        if (released !== true) throw new Error("Invalid Worklet placement release result");
        result = {
          case: "placementRelease",
          value: create(p.PlacementReleaseResultSchema, { released }),
        };
      } else if (message.result === undefined || message.result === null)
        result = { case: "absent", value: create(p.EmptySchema) };
      else {
        const v = object(message.result);
        if (v["specDigest"] !== undefined) result = { case: "receipt", value: receipt(v) };
        else if (v["operations"] !== undefined)
          result = { case: "capabilities", value: capabilities(v) };
        else
          result = {
            case: "control",
            value: create(p.ControlAcknowledgementSchema, {
              id: text(v["id"]),
              taskId: text(v["taskId"]),
              attemptId: text(v["attemptId"]),
              status: text(v["status"]),
              ...(v["reason"] === undefined ? {} : { reason: text(v["reason"]) }),
            }),
          };
      }
      frame = {
        case: "reply",
        value: create(p.DurableReplySchema, { requestId: message.requestId, result }),
      };
      break;
    }
    case "durable_event": {
      const event = decodeTaskAttemptEvent(message.item.event);
      frame = {
        case: "event",
        value: create(p.DurableEventSchema, {
          requestId: message.requestId,
          sequence: BigInt(number(message.item.sequence)),
          taskId: event.taskId,
          attemptId: event.attemptId,
          kind: event.type,
          at: event.at,
          taskAttemptEvent: document(event),
        }),
      };
      break;
    }
    case "durable_end":
      frame = {
        case: "end",
        value: create(p.DurableEndSchema, {
          requestId: message.requestId,
          ...(message.error === undefined ? {} : { error: message.error }),
        }),
      };
      break;
    default:
      throw new Error("Legacy Worklet frames are unavailable over gRPC");
  }
  return create(p.ConnectRequestSchema, { wireVersion: 1, frame });
}
export function decodeHostFrame(
  value: p.ConnectRequest,
  credential: string,
): Record<string, unknown> {
  if (value.wireVersion !== 1) throw new Error("Unsupported Worklet wire version");
  const f = value.frame;
  switch (f.case) {
    case "hello": {
      const d = f.value;
      if (
        d.descriptorVersion !== 1 ||
        d.durableProtocolVersion !== 1 ||
        d.protocolVersions.length !== 1 ||
        d.protocolVersions[0] !== 18 ||
        (d.controlProtocolVersion !== undefined && d.controlProtocolVersion !== 1)
      )
        throw new Error("gRPC requires durable Worklet protocol 18");
      return {
        type: "hello",
        credential,
        protocolVersions: d.protocolVersions,
        worklet: {
          id: d.workletId,
          protocolVersion: d.descriptorVersion,
          durableProtocolVersion: wireUint32(d.durableProtocolVersion),
          ...(d.controlProtocolVersion === undefined
            ? {}
            : { controlProtocolVersion: wireUint32(d.controlProtocolVersion) }),
          host: {
            id: d.workerHostId,
            ...(d.workspaces.length === 0 ? {} : { workspaces: workspaceNames(d.workspaces) }),
            ...(d.labels.length === 0 ? {} : { labels: workerHostLabels(d.labels) }),
            workers: d.workers.map((w) => {
              if (w.profileCapabilities === undefined)
                throw new Error("Worker must declare profileCapabilities");
              return {
                id: w.id,
                type: w.type,
                capabilities: w.capabilities.map((c) => ({ id: c.id, version: c.version })),
                profiles: w.profiles.map((c) => ({ id: c.id, revision: c.revision })),
                contextTypes: w.contextTypes.map((c) => ({ type: c.type, versions: c.versions })),
                ...(w.maxConcurrency === undefined
                  ? {}
                  : { maxConcurrency: wireUint32(w.maxConcurrency) }),
                profileCapabilities: w.profileCapabilities.entries.map((c) => ({
                  ...(c.harness === undefined ? {} : { harness: c.harness }),
                  ...(c.models.length === 0 ? {} : { models: [...c.models] }),
                  ...(c.efforts.length === 0
                    ? {}
                    : { efforts: c.efforts as ("low" | "medium" | "high")[] }),
                  profile: c.profile && { id: c.profile.id, revision: c.profile.revision },
                  capabilities: c.capabilities.map((t) => ({ id: t.id, version: t.version })),
                  contextTypes: c.contextTypes.map((t) => ({
                    type: t.type,
                    versions: t.versions,
                  })),
                })),
              };
            }),
          },
        },
      };
    }
    case "heartbeat":
      return {
        type: "heartbeat",
        at: f.value.at,
        ...(f.value.changedPaths.length === 0
          ? {}
          : { changedPaths: changedPathReports(f.value.changedPaths) }),
        ...(f.value.hostLabels === undefined ? {} : { hostLabels: f.value.hostLabels.labels }),
        ...(f.value.workerConcurrency === undefined
          ? {}
          : { workerConcurrency: workerConcurrencyLimits(f.value.workerConcurrency.limits) }),
        ...(f.value.diskSpace === undefined
          ? {}
          : {
              diskSpace: {
                freeBytes: Number(f.value.diskSpace.freeBytes),
                totalBytes: Number(f.value.diskSpace.totalBytes),
              },
            }),
      };
    case "controlTake":
      return { type: "control_take", requestId: f.value.requestId };
    case "reply": {
      const r = f.value.result;
      let result: unknown;
      switch (r.case) {
        case "receipt":
          result = readReceipt(r.value);
          break;
        case "control":
          result = {
            id: r.value.id,
            taskId: r.value.taskId,
            attemptId: r.value.attemptId,
            status: r.value.status,
            ...(r.value.reason === undefined ? {} : { reason: r.value.reason }),
          };
          break;
        case "capabilities":
          result = readCapabilities(r.value);
          break;
        case "placement":
          result = readPlacement(r.value);
          return {
            type: "durable_reply",
            requestId: f.value.requestId,
            resultKind: "placement",
            result,
          };
        case "noPlacement":
          return {
            type: "durable_reply",
            requestId: f.value.requestId,
            resultKind: "no_placement",
            result: undefined,
          };
        case "placementRelease":
          if (!r.value.released) throw new Error("Invalid Worklet placement release result");
          return {
            type: "durable_reply",
            requestId: f.value.requestId,
            resultKind: "placement_release",
            result: { released: true },
          };
        case "absent":
          break;
        case "error":
          return { type: "durable_reply", requestId: f.value.requestId, error: r.value };
        default:
          throw new Error("Missing reply result");
      }
      return { type: "durable_reply", requestId: f.value.requestId, result };
    }
    case "event": {
      const e = f.value;
      const event = decodeTaskAttemptEvent(readDocument(e.taskAttemptEvent));
      if (
        event.taskId !== e.taskId ||
        event.attemptId !== e.attemptId ||
        event.type !== e.kind ||
        event.at !== e.at
      )
        throw new Error("Attempt event identity mismatch");
      return {
        type: "durable_event",
        requestId: e.requestId,
        item: { sequence: uint(e.sequence), event },
      };
    }
    case "end":
      return {
        type: "durable_end",
        requestId: f.value.requestId,
        ...(f.value.error === undefined ? {} : { error: f.value.error }),
      };
    default:
      throw new Error("Missing or unsupported Worklet frame");
  }
}
export function encodeControlFrame(message: WorkletServerMessage): p.ConnectResponse {
  let frame: p.ConnectResponse["frame"];
  switch (message.type) {
    case "ready":
      if (wireUint32(message.protocolVersion) !== 18)
        throw new Error("gRPC requires Worklet protocol 18");
      frame = {
        case: "ready",
        value: create(p.ReadySchema, {
          protocolVersion: wireUint32(message.protocolVersion),
          heartbeatIntervalMs: wireUint32(message.heartbeatIntervalMs),
          connectionGeneration: BigInt(number(message.connectionGeneration)),
        }),
      };
      break;
    case "heartbeat_ack":
      frame = { case: "heartbeatAck", value: create(p.HeartbeatSchema, { at: message.at }) };
      break;
    case "protocol_error":
      frame = {
        case: "error",
        value: create(p.ProtocolErrorSchema, {
          code: message.code,
          message: message.message,
          supportedProtocolVersions: (message.supportedProtocolVersions ?? []).map(wireUint32),
        }),
      };
      break;
    case "control_take_result":
      frame = {
        case: "controlTakeResult",
        value: create(p.ControlTakeResultSchema, {
          requestId: message.requestId,
          allowed: message.allowed,
        }),
      };
      break;
    case "durable_unsubscribe":
      frame = {
        case: "unsubscribe",
        value: create(p.UnsubscribeSchema, { requestId: message.requestId }),
      };
      break;
    case "durable_request": {
      const m = message;
      switch (m.operation) {
        case "accept":
          frame = {
            case: "accept",
            value: create(p.AcceptSchema, { requestId: m.requestId, spec: spec(m.spec) }),
          };
          break;
        case "inspect":
          frame = {
            case: "inspect",
            value: create(p.InspectSchema, { requestId: m.requestId, attemptId: m.attemptId }),
          };
          break;
        case "cancel":
          frame = {
            case: "cancel",
            value: create(p.CancelSchema, {
              requestId: m.requestId,
              attemptId: m.attemptId,
              ...(m.reason === undefined ? {} : { reason: m.reason }),
            }),
          };
          break;
        case "events":
          frame = {
            case: "events",
            value: create(p.EventsSchema, {
              requestId: m.requestId,
              attemptId: m.attemptId,
              afterSequence: BigInt(number(m.afterSequence ?? 0)),
            }),
          };
          break;
        case "control_capabilities":
          frame = {
            case: "controlCapabilities",
            value: create(p.ControlCapabilitiesRequestSchema, {
              requestId: m.requestId,
              taskId: m.taskId,
              attemptId: m.attemptId,
            }),
          };
          break;
        case "control": {
          const c = validateHarnessControlCommand(m.command);
          let action: p.Control["action"];
          if (c.type === "input")
            action = {
              case: "input",
              value: create(p.InputSchema, {
                text: c.text,
                ...(c.advisory ? { advisory: true } : {}),
                ...(c.requiresInputAuthorization ? { requiresInputAuthorization: true } : {}),
                ...(c.origin ? { peerFrom: c.origin.from } : {}),
              }),
            };
          else if (c.type === "reply")
            action = {
              case: "reply",
              value: create(p.ReplySchema, {
                requestId: c.requestId,
                response: document(c.response),
              }),
            };
          else
            action = {
              case: "interrupt",
              value: create(p.InterruptSchema, {
                ...(c.reason === undefined ? {} : { reason: c.reason }),
              }),
            };
          frame = {
            case: "control",
            value: create(p.ControlSchema, {
              requestId: m.requestId,
              id: c.id,
              taskId: c.taskId,
              attemptId: c.attemptId,
              action,
            }),
          };
          break;
        }
        case "select_placement":
          frame = {
            case: "selectPlacement",
            value: create(p.SelectPlacementSchema, {
              requestId: m.requestId,
              executionRequirements: document(m.requirements),
              contextPlan: document(m.contextPlan),
              options: selectionOptions(m.options),
            }),
          };
          break;
        case "release_placement":
          frame = {
            case: "releasePlacement",
            value: create(p.ReleasePlacementSchema, {
              requestId: m.requestId,
              placement: placement(m.placement),
            }),
          };
          break;
      }
      break;
    }
    default:
      throw new Error("Legacy Worklet frames are unavailable over gRPC");
  }
  return create(p.ConnectResponseSchema, { wireVersion: 1, frame });
}
export function decodeControlFrame(value: p.ConnectResponse): Record<string, unknown> {
  if (value.wireVersion !== 1) throw new Error("Unsupported Worklet wire version");
  const f = value.frame;
  switch (f.case) {
    case "ready":
      if (f.value.protocolVersion !== 18 || f.value.connectionGeneration < 1n)
        throw new Error("Unsupported Worklet protocol or authority generation");
      return {
        type: "ready",
        protocolVersion: f.value.protocolVersion,
        heartbeatIntervalMs: f.value.heartbeatIntervalMs,
        connectionGeneration: uint(f.value.connectionGeneration),
      };
    case "heartbeatAck":
      return { type: "heartbeat_ack", at: f.value.at };
    case "error":
      return {
        type: "protocol_error",
        code: f.value.code,
        message: f.value.message,
        supportedProtocolVersions: f.value.supportedProtocolVersions,
      };
    case "unsubscribe":
      return { type: "durable_unsubscribe", requestId: f.value.requestId };
    case "accept":
      return {
        type: "durable_request",
        operation: "accept",
        requestId: f.value.requestId,
        spec: readSpec(f.value.spec),
      };
    case "inspect":
      return {
        type: "durable_request",
        operation: "inspect",
        requestId: f.value.requestId,
        attemptId: f.value.attemptId,
      };
    case "cancel":
      return {
        type: "durable_request",
        operation: "cancel",
        requestId: f.value.requestId,
        attemptId: f.value.attemptId,
        ...(f.value.reason === undefined ? {} : { reason: f.value.reason }),
      };
    case "events":
      return {
        type: "durable_request",
        operation: "events",
        requestId: f.value.requestId,
        attemptId: f.value.attemptId,
        afterSequence: uint(f.value.afterSequence),
      };
    case "controlCapabilities":
      return {
        type: "durable_request",
        operation: "control_capabilities",
        requestId: f.value.requestId,
        taskId: f.value.taskId,
        attemptId: f.value.attemptId,
      };
    case "controlTakeResult":
      return {
        type: "control_take_result",
        requestId: f.value.requestId,
        allowed: f.value.allowed,
      };
    case "control": {
      const c = f.value;
      const base = { id: c.id, taskId: c.taskId, attemptId: c.attemptId };
      let command: HarnessControlCommand;
      if (c.action.case === "input")
        command = {
          ...base,
          type: "input",
          text: c.action.value.text,
          ...(c.action.value.advisory ? { advisory: true } : {}),
          ...(c.action.value.requiresInputAuthorization
            ? { requiresInputAuthorization: true }
            : {}),
          ...(c.action.value.peerFrom === undefined
            ? {}
            : { origin: { kind: "peer" as const, from: c.action.value.peerFrom } }),
        };
      else if (c.action.case === "reply")
        command = {
          ...base,
          type: "reply",
          requestId: c.action.value.requestId,
          response: readDocument(c.action.value.response) as Extract<
            HarnessControlCommand,
            { type: "reply" }
          >["response"],
        };
      else if (c.action.case === "interrupt")
        command = {
          ...base,
          type: "interrupt",
          ...(c.action.value.reason === undefined ? {} : { reason: c.action.value.reason }),
        };
      else throw new Error("Missing control action");
      validateHarnessControlCommand(command);
      return {
        type: "durable_request",
        operation: "control",
        requestId: c.requestId,
        attemptId: c.attemptId,
        command,
      };
    }
    case "selectPlacement":
      return {
        type: "durable_request",
        operation: "select_placement",
        requestId: f.value.requestId,
        requirements: readDocument(f.value.executionRequirements),
        contextPlan: readDocument(f.value.contextPlan),
        options: readSelectionOptions(f.value.options),
      };
    case "releasePlacement":
      return {
        type: "durable_request",
        operation: "release_placement",
        requestId: f.value.requestId,
        placement: readPlacement(f.value.placement),
      };
    default:
      throw new Error("Missing or unsupported control frame");
  }
}
