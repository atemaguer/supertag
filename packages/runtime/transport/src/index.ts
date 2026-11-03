import { statfs } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import {
  isLoopbackAddress,
  type TagContextPlan,
  type TaskExecutionRequirements,
} from "@supertag/core";
import type {
  DurableWorklet,
  ExecutionSelectionOptions,
  HarnessControlAcknowledgement,
  HarnessControlCapabilities,
  HarnessControlCommand,
  HarnessControlOptions,
  SchedulableWorklet,
  TaskAttemptEvent,
  TaskAttemptSpec,
  WorkerDescriptor,
  WorkerHostStatus,
  WorkerProfileRef,
  Worklet,
  WorkletDescriptor,
  WorkletExecutionPlacement,
} from "@supertag/worker-sdk";
import {
  descriptorSupportsCoordination,
  descriptorSupportsExecution,
  descriptorSupportsRequiredContext,
  descriptorSupportsSurfaceCoordination,
  executionPreferenceScore,
  selectDescriptorExecution,
  validateHarnessControlCommand,
  WorkletAdmissionRejectedError,
  workerSlots,
} from "@supertag/worker-sdk";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { createGrpcWorkletSocket, validateGrpcWorkletOptions } from "./grpc.js";
import {
  changedPathReports,
  MAX_WORKER_CONCURRENCY,
  MAX_WORKER_HOST_CAPACITY,
  workerConcurrencyLimits,
  workerHostLabels,
  workspaceNames,
} from "./grpc-codec.js";
import { listenSocketMessages, type MessageSocket, sendSocketMessage } from "./message-socket.js";

export { startWorkletGrpcServer, type WorkletGrpcServerOptions } from "./grpc.js";
export { GrpcSessionStateStore } from "./session-client.js";

import { DurableControlPlaneProtocol, DurableHostProtocol } from "./durable-protocol.js";

/** The only version implemented by this transport. */
export const SUPPORTED_WORKLET_PROTOCOL_VERSIONS = [18] as const;
export type WorkletProtocolVersion = (typeof SUPPORTED_WORKLET_PROTOCOL_VERSIONS)[number];

/** Latest implemented version. Version 18 adds authority checks at the native input take boundary. */
export const WORKLET_PROTOCOL_VERSION = 18 as const;

const DEFAULT_PATH = "/worklets";
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Durable acknowledgements are short requests, independent of how long an Attempt runs. */
const DEFAULT_DURABLE_ACK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RECONNECT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_AUTHENTICATIONS = 64;
const MAX_DESCRIPTOR_TEXT_LENGTH = 200;
const MAX_WORKERS_PER_HOST = 256;
const MAX_PROFILES_PER_WORKER = 256;
const MAX_DESCRIPTOR_ITEMS = 256;

export type WorkletClientMessage =
  | { readonly type: "control_take"; readonly requestId: string }
  | {
      readonly type: "durable_reply";
      readonly requestId: string;
      readonly result?: unknown;
      /** Disambiguates placement replies whose result can be explicitly absent. */
      readonly resultKind?: "placement" | "no_placement" | "placement_release";
      readonly error?: string;
    }
  | {
      readonly type: "durable_event";
      readonly requestId: string;
      readonly item: { readonly sequence: number; readonly event: TaskAttemptEvent };
    }
  | { readonly type: "durable_end"; readonly requestId: string; readonly error?: string }
  | {
      readonly type: "hello";
      readonly protocolVersions: readonly number[];
      /** Worker Host enrollment credential. */
      readonly credential: string;
      readonly worklet: WorkletDescriptor;
    }
  | {
      readonly type: "heartbeat";
      readonly at: string;
      /** The host's labels, only when they changed since hello or the last heartbeat. */
      readonly hostLabels?: readonly string[];
      /**
       * Task Attempts each Worker runs at once, by Worker ID, only when they changed since hello
       * or the last heartbeat.
       */
      readonly workerConcurrency?: Readonly<Record<string, number>>;
      readonly diskSpace?: { readonly freeBytes: number; readonly totalBytes: number };
      /** Current changed paths for readable Task Attempt worktrees on this host. */
      readonly changedPaths?: readonly {
        readonly attemptId: string;
        readonly paths: readonly string[];
        readonly truncated: boolean;
      }[];
    };

export type WorkletServerMessage =
  | { readonly type: "control_take_result"; readonly requestId: string; readonly allowed: boolean }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "accept";
      readonly spec: TaskAttemptSpec;
    }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "inspect" | "cancel" | "events";
      readonly attemptId: string;
      readonly reason?: string;
      readonly afterSequence?: number;
    }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "control";
      readonly attemptId: string;
      readonly command: HarnessControlCommand;
    }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "control_capabilities";
      readonly taskId: string;
      readonly attemptId: string;
    }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "select_placement";
      readonly requirements: TaskExecutionRequirements;
      readonly contextPlan: TagContextPlan;
      readonly options: ExecutionSelectionOptions;
    }
  | {
      readonly type: "durable_request";
      readonly requestId: string;
      readonly operation: "release_placement";
      readonly placement: WorkletExecutionPlacement;
    }
  | { readonly type: "durable_unsubscribe"; readonly requestId: string }
  | {
      readonly type: "ready";
      readonly protocolVersion: number;
      readonly heartbeatIntervalMs: number;
      /** Monotonic authority generation allocated for this Worker Host connection. */
      readonly connectionGeneration?: number;
    }
  | { readonly type: "heartbeat_ack"; readonly at: string }
  | {
      readonly type: "protocol_error";
      readonly code: string;
      readonly message: string;
      readonly supportedProtocolVersions?: readonly number[];
    };

export interface WorkletAuthenticationRequest {
  /** Secret presented by the Worklet. The transport never persists it. */
  readonly credential: string;
  readonly worklet: WorkletDescriptor;
  readonly protocolVersion: WorkletProtocolVersion;
}

export interface WorkletAuthenticationResult {
  /**
   * Persisted, monotonically increasing generation for the declared Worker Host.
   * A generation must never be reused by a later connection.
   */
  readonly connectionGeneration: number;
  /** Durable desired drain state restored when this Worker Host reconnects. */
  readonly draining?: boolean;
}

export interface AuthenticatedWorkletSession {
  readonly workerHostId: string;
  readonly workletId: string;
  readonly connectionGeneration: number;
  readonly protocolVersion: WorkletProtocolVersion;
}

export interface WorkletConnectionObservation extends AuthenticatedWorkletSession {
  readonly changedPaths?: readonly {
    readonly attemptId: string;
    readonly paths: readonly string[];
    readonly truncated: boolean;
  }[];
  readonly descriptor: WorkletDescriptor;
  readonly observedAt: string;
  readonly lastHeartbeatAt: string;
  readonly connected: boolean;
  readonly draining: boolean;
  readonly activeAttempts: number;
  readonly capacity: number;
  readonly availableSlots: number;
}

export interface RemoteWorkletServerOptions {
  readonly server: Server;
  /** Authenticates the declared Worker Host and atomically allocates its next generation. */
  readonly authenticateWorklet: (
    request: WorkletAuthenticationRequest,
  ) => WorkletAuthenticationResult | undefined | Promise<WorkletAuthenticationResult | undefined>;
  readonly path?: string;
  readonly id?: string;
  readonly authTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly durableAcknowledgementTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  /** Maximum open sockets that have not completed authoritative admission. */
  readonly maxPendingAuthentications?: number;
  readonly onError?: (error: unknown) => void;
  readonly onWorkletConnected?: (
    worklet: WorkletDescriptor,
    session: AuthenticatedWorkletSession,
  ) => void;
  readonly onWorkletDisconnected?: (
    worklet: WorkletDescriptor,
    session: AuthenticatedWorkletSession,
  ) => void;
  /** Emits generation-fenced state on connect, heartbeat, drain changes, and disconnect. */
  /**
   * Persists or validates generation-fenced state. Returning false means this session has lost
   * authority and must be disconnected before it can receive work. An authoritative draining
   * value reconciles a lifecycle change that raced with authentication.
   */
  readonly onWorkletObserved?: (observation: WorkletConnectionObservation) => unknown;
}

interface ServerConnection {
  readonly socket: MessageSocket;
  readonly remoteAddress: string | undefined;
  descriptor?: WorkletDescriptor;
  protocolVersion?: WorkletProtocolVersion;
  connectionGeneration?: number;
  authenticating: boolean;
  admitted: boolean;
  lastSeenAt: number;
  draining: boolean;
  lastTransitionAt: string;
}

interface KnownWorklet {
  descriptor: WorkletDescriptor;
  lastSeenAt: number;
  connected: boolean;
  draining: boolean;
  lastTransitionAt: string;
}

/** Control Plane proxy for one authenticated, outbound-connected Worklet. */
export class RemoteWorkletServer implements SchedulableWorklet {
  readonly #httpServer: Server;
  readonly #authenticateWorklet: RemoteWorkletServerOptions["authenticateWorklet"];
  readonly #path: string;
  readonly #fallbackId: string;
  readonly #authTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #maxPendingAuthentications: number;
  readonly #webSocketServer: WebSocketServer;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onWorkletConnected: RemoteWorkletServerOptions["onWorkletConnected"];
  readonly #onWorkletDisconnected: RemoteWorkletServerOptions["onWorkletDisconnected"];
  readonly #onWorkletObserved: RemoteWorkletServerOptions["onWorkletObserved"];
  readonly #connections = new Set<ServerConnection>();
  readonly #activeConnections = new Map<string, ServerConnection>();
  readonly #latestConnectionGenerations = new Map<string, number>();
  readonly #observationTails = new Map<string, Promise<void>>();
  readonly #inboundTasks = new Set<Promise<void>>();
  readonly #knownWorklets = new Map<string, KnownWorklet>();
  readonly #durable: DurableControlPlaneProtocol;
  readonly #durableRoutes = new Map<string, string>();
  readonly #durableReservations = new Map<
    string,
    { socket: MessageSocket; workerId: string | undefined }
  >();
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #started = false;

  constructor(options: RemoteWorkletServerOptions) {
    if (typeof options.authenticateWorklet !== "function")
      throw new Error("authenticateWorklet is required");
    this.#httpServer = options.server;
    this.#authenticateWorklet = options.authenticateWorklet;
    this.#path = normalizePath(options.path ?? DEFAULT_PATH);
    this.#fallbackId = options.id ?? "remote";
    this.#authTimeoutMs = positiveDuration(
      options.authTimeoutMs,
      DEFAULT_AUTH_TIMEOUT_MS,
      "authTimeoutMs",
    );
    this.#heartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.#heartbeatTimeoutMs = positiveDuration(
      options.heartbeatTimeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
      "heartbeatTimeoutMs",
    );
    const acknowledgementTimeoutMs = positiveDuration(
      options.durableAcknowledgementTimeoutMs,
      DEFAULT_DURABLE_ACK_TIMEOUT_MS,
      "durableAcknowledgementTimeoutMs",
    );
    this.#maxPendingAuthentications = positiveInteger(
      options.maxPendingAuthentications,
      DEFAULT_MAX_PENDING_AUTHENTICATIONS,
      "maxPendingAuthentications",
    );
    this.#durable = new DurableControlPlaneProtocol(
      Math.min(acknowledgementTimeoutMs, DEFAULT_DURABLE_ACK_TIMEOUT_MS),
    );
    if (this.#heartbeatTimeoutMs <= this.#heartbeatIntervalMs) {
      throw new Error("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
    }
    this.#onError = options.onError;
    this.#onWorkletConnected = options.onWorkletConnected;
    this.#onWorkletDisconnected = options.onWorkletDisconnected;
    this.#onWorkletObserved = options.onWorkletObserved;
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: positiveInteger(
        options.maxPayloadBytes,
        DEFAULT_MAX_PAYLOAD_BYTES,
        "maxPayloadBytes",
      ),
    });
  }

  get id(): string {
    return this.workletRegistration?.id ?? this.#fallbackId;
  }

  /** True only for this live, authenticated generation's actual transport peer. */
  isHostConnectionLoopback(workerHostId: string, generation: number): boolean {
    const connection = this.#activeConnections.get(workerHostId);
    return (
      this.#started &&
      connection?.admitted === true &&
      connection.socket.readyState === WebSocket.OPEN &&
      connection.connectionGeneration === generation &&
      this.#isCurrentConnection(connection) &&
      isLoopbackAddress(connection.remoteAddress)
    );
  }

  get isWorkletConnected(): boolean {
    return this.#connectedConnections().length > 0;
  }

  get isConnected(): boolean {
    return this.isWorkletConnected;
  }

  get workletRegistration(): WorkletDescriptor | undefined {
    return this.workletRegistrations[0];
  }

  get workletRegistrations(): readonly WorkletDescriptor[] {
    return this.#connectedConnections().flatMap((connection) =>
      connection.descriptor === undefined ? [] : [connection.descriptor],
    );
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#httpServer.on("upgrade", this.#handleUpgrade);
    this.#webSocketServer.on("connection", this.#handleConnection);
    this.#heartbeatTimer = setInterval(
      this.#evictUnresponsiveConnections,
      this.#heartbeatIntervalMs,
    );
    this.#heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#httpServer.off("upgrade", this.#handleUpgrade);
    this.#webSocketServer.off("connection", this.#handleConnection);
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    for (const connection of this.#connections)
      connection.socket.close(1001, "Control Plane shutting down");
    await new Promise<void>((resolve) => this.#webSocketServer.close(() => resolve()));
    await Promise.allSettled(this.#inboundTasks);
    await this.flushObservations();
  }

  async describe(): Promise<WorkletDescriptor> {
    const descriptors = this.#readyConnections().flatMap((connection) =>
      connection.descriptor === undefined ? [] : [connection.descriptor],
    );
    if (descriptors.length === 0) throw new Error("No remote Worklet is connected");
    if (descriptors.length === 1 && descriptors[0] !== undefined) return descriptors[0];
    return {
      id: this.#fallbackId,
      protocolVersion: 1,
      host: {
        id: this.#fallbackId,
        workers: descriptors.flatMap((descriptor) =>
          descriptor.host.workers.map((worker) => ({
            ...worker,
            id: `${descriptor.host.id}/${worker.id}`,
          })),
        ),
      },
    };
  }

  async selectExecution(
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions = {},
  ): Promise<WorkerProfileRef | undefined> {
    return (await this.#selectPlacement(requirements, contextPlan, options, false))?.workerProfile;
  }

  async selectPlacement(
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions = {},
  ): Promise<WorkletExecutionPlacement | undefined> {
    return this.#selectPlacement(requirements, contextPlan, options, true);
  }

  async releasePlacement(placement: WorkletExecutionPlacement): Promise<void> {
    if (!placement.reservation) return;
    const connection = this.#activeConnections.get(placement.workerHostId);
    if (!connection || connection.descriptor?.id !== placement.workletId) return;
    await this.#durable.releasePlacement(connection.socket, placement);
  }

  async #selectPlacement(
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions,
    reserve: boolean,
  ): Promise<WorkletExecutionPlacement | undefined> {
    const candidates = this.#readyConnections()
      .filter(connectionUsesDurableProtocol)
      .filter(
        (connection) =>
          options.allowedWorkerHostIds === undefined ||
          options.allowedWorkerHostIds.includes(connection.descriptor?.host.id ?? ""),
      )
      .flatMap((connection) => {
        const active = (workerId: string) => this.#activeWorkerAttempts(connection, workerId);
        return (connection.descriptor?.host.workers ?? []).flatMap((worker) => {
          const profile = selectDescriptorExecution(
            [worker],
            requirements,
            contextPlan,
            options,
            active,
          );
          return profile
            ? [
                {
                  profile,
                  worker,
                  connection,
                  score: executionPreferenceScore(worker, profile, requirements),
                },
              ]
            : [];
        });
      });
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        this.#activeAttempts(a.connection.socket) / this.#capacity(a.connection) -
          this.#activeAttempts(b.connection.socket) / this.#capacity(b.connection) ||
        (a.connection.descriptor?.id ?? "").localeCompare(b.connection.descriptor?.id ?? "") ||
        a.worker.id.localeCompare(b.worker.id) ||
        a.profile.id.localeCompare(b.profile.id) ||
        a.profile.revision.localeCompare(b.profile.revision),
    );
    const probedHosts = new Set<string>();
    for (const selected of candidates) {
      if (!selected.connection.descriptor) continue;
      const hostId = selected.connection.descriptor.host.id;
      if (probedHosts.has(hostId)) continue;
      probedHosts.add(hostId);
      if (reserve) {
        const local = await this.#durable.selectPlacement(
          selected.connection.socket,
          requirements,
          contextPlan,
          { ...options, allowedWorkerHostIds: [hostId] },
        );
        if (
          local &&
          this.#isCurrentConnection(selected.connection) &&
          validReservedPlacement(
            selected.connection.descriptor,
            local,
            requirements,
            contextPlan,
            options,
          )
        )
          return local;
        if (local?.reservation)
          await this.#durable
            .releasePlacement(selected.connection.socket, local)
            .catch((error: unknown) => this.#reportError(error));
        continue;
      }
      return {
        workerHostId: hostId,
        workletId: selected.connection.descriptor.id,
        workerId: selected.worker.id,
        workerProfile: selected.profile,
      };
    }
    return undefined;
  }

  async canExecute(profile: WorkerProfileRef, contextPlan: TagContextPlan): Promise<boolean> {
    return this.#selectConnection(profile, contextPlan) !== undefined;
  }

  async listWorkerHosts(): Promise<readonly WorkerHostStatus[]> {
    return [...this.#knownWorklets.values()]
      .map((worklet) => this.#workerHostStatus(worklet))
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  }

  async setHostDraining(workerHostId: string, draining: boolean): Promise<boolean> {
    const known = this.#knownWorklets.get(workerHostId);
    const connections = [...this.#connections].filter(
      (connection) => connection.descriptor?.host.id === workerHostId,
    );
    if (known === undefined && connections.length === 0) return false;
    if (known !== undefined && known.draining !== draining) {
      known.draining = draining;
      known.lastTransitionAt = new Date().toISOString();
    }
    const transitionAt = known?.lastTransitionAt ?? new Date().toISOString();
    for (const connection of connections) {
      connection.draining = draining;
      connection.lastTransitionAt = transitionAt;
      if (connection.admitted && this.#isCurrentConnection(connection))
        this.#observe(connection, true);
    }
    return true;
  }

  /** Immediately fences and disconnects the current generation for a revoked Worker Host. */
  disconnectHost(workerHostId: string, reason = "Worker Host credential revoked"): boolean {
    const connection = this.#activeConnections.get(workerHostId);
    if (connection === undefined) return false;
    connection.socket.close(4008, Buffer.from(reason).subarray(0, 100).toString());
    return true;
  }

  /** Waits until all ordered observation callbacks have settled. */
  async flushObservations(): Promise<void> {
    await Promise.all(this.#observationTails.values());
  }

  async supportsDurableExecution(
    profile: WorkerProfileRef,
    contextPlan: TagContextPlan,
  ): Promise<boolean> {
    return this.#supportsDurableExecution(profile, contextPlan);
  }

  #supportsDurableExecution(profile: WorkerProfileRef, contextPlan: TagContextPlan): boolean {
    return this.#connectedConnections().some(
      (connection) =>
        connectionUsesDurableProtocol(connection) &&
        connection.descriptor?.host.workers.some(
          (worker) =>
            worker.profiles.some(
              (candidate) => candidate.id === profile.id && candidate.revision === profile.revision,
            ) && descriptorSupportsRequiredContext(worker, contextPlan, profile),
        ),
    );
  }

  async accept(spec: TaskAttemptSpec): Promise<Awaited<ReturnType<DurableWorklet["accept"]>>> {
    if (!spec.execution) throw new Error("Task Attempt execution requirements are required");
    const previous = this.#durableRoutes.get(spec.attemptId);
    const connection =
      previous === undefined
        ? this.#selectConnection(
            spec.workerProfile,
            spec.contextPlan,
            spec.coordination !== undefined || spec.authorization.version === 4,
            spec.coordination?.scope === "surface",
            spec.execution,
            spec.placement?.workerHostId === undefined
              ? spec.placement?.allowedWorkerHostIds
              : [spec.placement.workerHostId],
            spec.placement?.coordinationSlot === true,
          )
        : this.#connectedConnections().find((entry) => entry.descriptor?.host.id === previous);
    if (!connection?.descriptor || !connectionUsesDurableProtocol(connection)) {
      if (previous !== undefined)
        throw new Error("Durable Attempt host unavailable; inspect before retrying");
      throw new WorkletAdmissionRejectedError(
        "No durable Worklet available for this Attempt; inspect before retrying",
      );
    }
    if (previous === undefined) {
      const worker = this.#availableWorker(
        connection,
        spec.workerProfile,
        spec.contextPlan,
        spec.coordination !== undefined || spec.authorization.version === 4,
        spec.coordination?.scope === "surface",
        spec.execution,
        spec.placement?.workerId,
        spec.placement?.coordinationSlot === true,
      );
      if (!worker) throw new WorkletAdmissionRejectedError("Durable Worker profile is at capacity");
      this.#durableRoutes.set(spec.attemptId, connection.descriptor.host.id);
      this.#durableReservations.set(spec.attemptId, {
        socket: connection.socket,
        workerId: worker.id,
      });
      this.#observe(connection, true);
    }
    // Retain routing on an uncertain ACK: replaying on another host could duplicate work.
    const receipt = await this.#durable.accept(connection.socket, spec);
    this.#reconcileDurableReservation(connection, receipt);
    return {
      ...receipt,
      // Identity comes from this authenticated route, never the aggregate descriptor
      // or optional identity fields supplied by a remote receipt.
      workerHostId: connection.descriptor.host.id,
      workletId: connection.descriptor.id,
      ...(connection.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: connection.connectionGeneration }),
    };
  }

  async controlCapabilities(
    taskId: string,
    attemptId: string,
  ): Promise<HarnessControlCapabilities | undefined> {
    if (!this.#durableRoutes.has(attemptId)) await this.inspect(attemptId);
    const connection = this.#connectedConnections().find(
      (entry) => entry.descriptor?.host.id === this.#durableRoutes.get(attemptId),
    );
    if (connection?.descriptor?.controlProtocolVersion !== 1) return undefined;
    return this.#durable.controlCapabilities(connection.socket, taskId, attemptId);
  }
  async control(
    command: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    command = validateHarnessControlCommand(command);
    const identity = { id: command.id, taskId: command.taskId, attemptId: command.attemptId };
    try {
      if (!this.#durableRoutes.has(command.attemptId)) await this.inspect(command.attemptId);
      const connection = this.#connectedConnections().find(
        (entry) => entry.descriptor?.host.id === this.#durableRoutes.get(command.attemptId),
      );
      if (!connection)
        return {
          ...identity,
          status: "unknown",
          reason: "Attempt host unavailable; do not redispatch",
        };
      if (connection.descriptor?.controlProtocolVersion !== 1)
        return { ...identity, status: "rejected", reason: "Worklet control unsupported" };
      return await this.#durable.control(connection.socket, command, options);
    } catch {
      return {
        ...identity,
        status: "unknown",
        reason: "Control outcome could not be confirmed; do not redispatch",
      };
    }
  }

  async inspect(attemptId: string): Promise<Awaited<ReturnType<DurableWorklet["inspect"]>>> {
    const known = this.#durableRoutes.get(attemptId);
    const candidates = this.#connectedConnections().filter(
      (entry) =>
        connectionUsesDurableProtocol(entry) &&
        (known === undefined || entry.descriptor?.host.id === known),
    );
    const results = await Promise.all(
      candidates.map(async (connection) => ({
        connection,
        result: await this.#durable.inspect(connection.socket, attemptId),
      })),
    );
    const matches = results.filter(({ result }) => result !== undefined);
    if (matches.length > 1)
      throw new Error("Conflicting durable Attempt receipts across Worker Hosts");
    const found = matches[0];
    if (!found?.result) {
      if (results[0]) {
        this.#durableRoutes.delete(attemptId);
        this.#durableReservations.delete(attemptId);
        return results[0].result;
      }
      throw new Error("Durable Attempt host unavailable; outcome unknown");
    }
    if (!found.connection.descriptor) throw new Error("Durable host descriptor missing");
    this.#durableRoutes.set(attemptId, found.connection.descriptor.host.id);
    this.#reconcileDurableReservation(found.connection, found.result);
    return {
      ...found.result,
      workerHostId: found.connection.descriptor.host.id,
      workletId: found.connection.descriptor.id,
      ...(found.connection.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: found.connection.connectionGeneration }),
    };
  }

  async inspectOnHost(
    attemptId: string,
    workerHostId: string,
    workletId: string,
  ): Promise<Awaited<ReturnType<DurableWorklet["inspect"]>>> {
    const connection = this.#connectedConnections().find(
      (entry) =>
        connectionUsesDurableProtocol(entry) &&
        entry.descriptor?.host.id === workerHostId &&
        entry.descriptor.id === workletId,
    );
    if (!connection) throw new Error("Selected durable Worklet unavailable; outcome unknown");
    const result = await this.#durable.inspect(connection.socket, attemptId);
    if (!result) {
      this.#durableRoutes.delete(attemptId);
      this.#durableReservations.delete(attemptId);
      this.#observe(connection, true);
      return undefined;
    }
    this.#durableRoutes.set(attemptId, workerHostId);
    this.#reconcileDurableReservation(connection, result);
    return {
      ...result,
      workerHostId,
      workletId,
      ...(connection.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: connection.connectionGeneration }),
    };
  }

  #reconcileDurableReservation(
    connection: ServerConnection,
    receipt: Awaited<ReturnType<DurableWorklet["accept"]>>,
  ) {
    if (
      receipt.workerId !== undefined &&
      !connection.descriptor?.host.workers.some((worker) => worker.id === receipt.workerId)
    )
      throw new Error("Durable receipt references an unadvertised Worker");
    if (["completed", "failed", "cancelled"].includes(receipt.status)) {
      this.#durableReservations.delete(receipt.attemptId);
    } else {
      // Unknown is unfinished cleanup, not free capacity. An older receipt may not
      // identify its Worker; charge one slot to every possible Worker until resolved.
      this.#durableReservations.set(receipt.attemptId, {
        socket: connection.socket,
        workerId: receipt.workerId ?? this.#durableReservations.get(receipt.attemptId)?.workerId,
      });
    }
    this.#observe(connection, true);
  }

  async *events(
    attemptId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): ReturnType<DurableWorklet["events"]> {
    if (!this.#durableRoutes.has(attemptId)) await this.inspect(attemptId);
    const connection = this.#connectedConnections().find(
      (entry) =>
        entry.descriptor?.host.id === this.#durableRoutes.get(attemptId) &&
        connectionUsesDurableProtocol(entry),
    );
    if (!connection)
      throw new Error("Durable Attempt host unavailable; inspect and resume after reconnect");
    yield* this.#durable.events(connection.socket, attemptId, afterSequence, signal);
    await this.inspect(attemptId);
  }

  async cancel(
    attemptId: string,
    reason?: string,
  ): Promise<Awaited<ReturnType<DurableWorklet["cancel"]>>> {
    if (!this.#durableRoutes.has(attemptId)) await this.inspect(attemptId);
    const connection = this.#connectedConnections().find(
      (entry) =>
        entry.descriptor?.host.id === this.#durableRoutes.get(attemptId) &&
        connectionUsesDurableProtocol(entry),
    );
    if (!connection) throw new Error("Durable Attempt host unavailable; cancellation unconfirmed");
    const result = (await this.#durable.cancel(connection.socket, attemptId, reason)) as Awaited<
      ReturnType<DurableWorklet["cancel"]>
    >;
    // Cancellation acknowledgement is not cleanup acknowledgement. Observe the journal
    // to release capacity only after the durable backend reports terminal cleanup.
    void (async () => {
      for await (const _event of this.#durable.events(connection.socket, attemptId)) {
        /* drain */
      }
      await this.inspect(attemptId);
    })().catch((error) => this.#reportError(error));
    return result;
  }

  /** Aborting this convenience execution requests cancellation; events() only stops observation. */
  async *execute(spec: TaskAttemptSpec, signal?: AbortSignal): AsyncIterable<TaskAttemptEvent> {
    signal?.throwIfAborted();
    await this.accept(spec);
    const abort = () => {
      void this.cancel(spec.attemptId, "Task Attempt observer aborted").catch((error) =>
        this.#reportError(error),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      for await (const item of this.events(spec.attemptId, 0, signal)) yield item.event;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  readonly #handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!this.#started) return;
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "http://control-plane.local").pathname;
    } catch {
      return;
    }
    if (pathname !== this.#path) return;
    if (
      [...this.#connections].filter((connection) => !connection.admitted).length >=
      this.#maxPendingAuthentications
    ) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.#webSocketServer.emit("connection", webSocket, request);
    });
  };

  /** Attach a transport adapter to the existing authentication and authority owner. */
  attachConnection(socket: MessageSocket, remoteAddress?: string): void {
    if (
      !this.#started ||
      [...this.#connections].filter((c) => !c.admitted).length >= this.#maxPendingAuthentications
    ) {
      socket.close(1013, "Worklet admission unavailable");
      return;
    }
    this.#addConnection(socket, remoteAddress);
  }

  readonly #handleConnection = (socket: MessageSocket, request: IncomingMessage) => {
    this.#addConnection(socket, request.socket.remoteAddress);
  };

  #addConnection(socket: MessageSocket, remoteAddress: string | undefined): void {
    const connection: ServerConnection = {
      socket,
      remoteAddress,
      authenticating: false,
      admitted: false,
      lastSeenAt: Date.now(),
      draining: false,
      lastTransitionAt: new Date().toISOString(),
    };
    this.#connections.add(connection);
    const authTimeout = setTimeout(() => {
      if (!connection.admitted) socket.close(4001, "Authentication timed out");
    }, this.#authTimeoutMs);
    authTimeout.unref();
    listenSocketMessages(socket, parseObjectMessage, (message) => {
      const task = this.#receiveMessage(connection, message);
      this.#inboundTasks.add(task);
      void task.finally(() => this.#inboundTasks.delete(task));
    });
    socket.on("error", (error) => this.#reportError(error));
    socket.on("close", () => {
      clearTimeout(authTimeout);
      const wasCurrent = this.#isCurrentConnection(connection);
      if (wasCurrent && connection.descriptor !== undefined)
        this.#activeConnections.delete(connection.descriptor.host.id);
      this.#durable.disconnected(socket);
      this.#connections.delete(connection);
      if (connection.descriptor !== undefined && connection.connectionGeneration !== undefined) {
        const known = this.#knownWorklets.get(connection.descriptor.host.id);
        if (wasCurrent && known !== undefined) {
          known.connected = false;
          known.lastTransitionAt = new Date().toISOString();
        }
        if (connection.admitted)
          this.#callLifecycleCallback(
            this.#onWorkletDisconnected,
            connection.descriptor,
            this.#session(connection),
          );
        this.#observe(connection, false);
      }
    });
  }

  async #receiveMessage(
    connection: ServerConnection,
    message: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!connection.admitted || connection.descriptor === undefined) {
        if (connection.authenticating) {
          connection.socket.close(4001, "Authentication already in progress");
          return;
        }
        connection.authenticating = true;
        try {
          await this.#authenticate(connection, message);
        } finally {
          connection.authenticating = false;
        }
        return;
      }
      if (!this.#isCurrentConnection(connection)) {
        connection.socket.close(4007, "Worker Host connection superseded");
        return;
      }
      connection.lastSeenAt = Date.now();
      const known = this.#knownWorklets.get(connection.descriptor.host.id);
      if (known !== undefined) known.lastSeenAt = connection.lastSeenAt;
      this.#handleAuthenticatedMessage(connection, message);
    } catch (error) {
      this.#reportError(error);
      sendProtocolError(connection.socket, "invalid_message", errorMessage(error));
    }
  }

  #handleAuthenticatedMessage(
    connection: ServerConnection,
    message: Record<string, unknown>,
  ): void {
    if (this.#durable.receive(connection.socket, message)) return;
    switch (message["type"]) {
      case "heartbeat": {
        const changedPaths =
          message["changedPaths"] === undefined
            ? undefined
            : changedPathReports(message["changedPaths"]);
        if (message["hostLabels"] !== undefined) this.#relabel(connection, message["hostLabels"]);
        if (message["workerConcurrency"] !== undefined)
          this.#resize(connection, message["workerConcurrency"]);
        if (message["diskSpace"] !== undefined && connection.descriptor !== undefined) {
          const diskSpace = validDiskSpace(message["diskSpace"]);
          connection.descriptor = {
            ...connection.descriptor,
            host: { ...connection.descriptor.host, diskSpace },
          };
          const known = this.#knownWorklets.get(connection.descriptor.host.id);
          if (known !== undefined && this.#isCurrentConnection(connection))
            this.#knownWorklets.set(connection.descriptor.host.id, {
              ...known,
              descriptor: connection.descriptor,
            });
        }
        sendJson(connection.socket, { type: "heartbeat_ack", at: new Date().toISOString() });
        this.#observe(connection, true, changedPaths);
        return;
      }
      default:
        throw new Error("Unsupported authenticated Worklet message");
    }
  }

  async #authenticate(
    connection: ServerConnection,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message["type"] !== "hello") {
      connection.socket.close(4001, "First message must authenticate");
      return;
    }
    const offeredVersions = requiredProtocolVersions(message, "protocolVersions");
    if (offeredVersions.length !== 1 || offeredVersions[0] !== WORKLET_PROTOCOL_VERSION) {
      sendJson(connection.socket, {
        type: "protocol_error",
        code: "unsupported_protocol",
        message: `No compatible Worklet protocol version; Control Plane supports ${SUPPORTED_WORKLET_PROTOCOL_VERSIONS.join(", ")}`,
        supportedProtocolVersions: SUPPORTED_WORKLET_PROTOCOL_VERSIONS,
      });
      connection.socket.close(4002, "Unsupported protocol version");
      return;
    }
    const selectedVersion = WORKLET_PROTOCOL_VERSION;
    if ("pairingToken" in message) {
      sendProtocolError(
        connection.socket,
        "invalid_message",
        "pairingToken is not supported; use credential with Worklet protocol 18",
      );
      connection.socket.close(4003, "Unsupported authentication field");
      return;
    }
    const credential = requiredString(message, "credential");
    const descriptor = workletDescriptorFromMessage(message);
    if (descriptor.durableProtocolVersion !== 1) {
      sendProtocolError(
        connection.socket,
        "unsupported_protocol",
        "Worklet protocol 18 requires durableProtocolVersion: 1",
      );
      connection.socket.close(4002, "Durable execution required");
      return;
    }
    let authentication: WorkletAuthenticationResult | undefined;
    try {
      authentication = await this.#authenticateWorklet({
        credential,
        worklet: descriptor,
        protocolVersion: selectedVersion,
      });
    } catch (error) {
      this.#reportError(error);
    }
    if (authentication === undefined) {
      connection.socket.close(4003, "Authentication failed");
      return;
    }
    let generation: number;
    try {
      generation = connectionGeneration(authentication.connectionGeneration);
    } catch (error) {
      this.#reportError(error);
      connection.socket.close(4003, "Authentication failed");
      return;
    }
    const latest = this.#latestConnectionGenerations.get(descriptor.host.id) ?? 0;
    if (connection.socket.readyState !== WebSocket.OPEN) {
      this.#observeReleasedClaim(
        descriptor,
        selectedVersion,
        generation,
        authentication.draining ?? false,
        connection.lastSeenAt,
      );
      return;
    }
    if (generation <= latest) {
      connection.socket.close(4007, "Stale Worker Host connection generation");
      return;
    }
    const previousConnection = this.#activeConnections.get(descriptor.host.id);
    connection.descriptor = descriptor;
    connection.protocolVersion = selectedVersion;
    connection.connectionGeneration = generation;
    connection.draining =
      authentication.draining ?? this.#knownWorklets.get(descriptor.host.id)?.draining ?? false;
    connection.lastTransitionAt = new Date().toISOString();
    this.#latestConnectionGenerations.set(descriptor.host.id, generation);
    this.#activeConnections.set(descriptor.host.id, connection);
    // A new transport connection does not prove the old execution stopped.
    for (const [attemptId, reservation] of this.#durableReservations) {
      if (this.#durableRoutes.get(attemptId) !== descriptor.host.id) continue;
      this.#durableReservations.set(attemptId, {
        socket: connection.socket,
        workerId: descriptor.host.workers.some((worker) => worker.id === reservation.workerId)
          ? reservation.workerId
          : undefined,
      });
    }
    if (previousConnection !== undefined && previousConnection !== connection)
      previousConnection.socket.close(4007, "Worker Host connection superseded");
    let authority: unknown;
    const initialObservation = this.#observation(connection, true);
    try {
      authority = await this.#queueObservation(initialObservation);
    } catch {
      if (connection.socket.readyState === WebSocket.OPEN)
        connection.socket.close(1011, "Worker Host authority validation unavailable");
      return;
    }
    if (authority === false) {
      if (connection.socket.readyState === WebSocket.OPEN)
        connection.socket.close(4007, "Worker Host connection generation lost authority");
      return;
    }
    this.#applyAuthoritativeObservation(connection, authority);
    if (connection.draining !== initialObservation.draining) {
      try {
        authority = await this.#queueObservation(this.#observation(connection, true));
      } catch {
        if (connection.socket.readyState === WebSocket.OPEN)
          connection.socket.close(1011, "Worker Host authority validation unavailable");
        return;
      }
      if (authority === false) {
        if (connection.socket.readyState === WebSocket.OPEN)
          connection.socket.close(4007, "Worker Host connection generation lost authority");
        return;
      }
      this.#applyAuthoritativeObservation(connection, authority);
    }
    if (connection.socket.readyState !== WebSocket.OPEN || !this.#isCurrentConnection(connection))
      return;
    connection.admitted = true;
    this.#knownWorklets.set(descriptor.host.id, {
      descriptor,
      lastSeenAt: connection.lastSeenAt,
      connected: true,
      draining: connection.draining,
      lastTransitionAt: connection.lastTransitionAt,
    });
    sendJson(connection.socket, {
      type: "ready",
      protocolVersion: selectedVersion,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      connectionGeneration: generation,
    });
    this.#callLifecycleCallback(this.#onWorkletConnected, descriptor, this.#session(connection));
  }

  #readyConnections(): ServerConnection[] {
    return this.#connectedConnections().filter((connection) => !connection.draining);
  }

  #connectedConnections(): ServerConnection[] {
    return [...this.#connections].filter(
      (connection) =>
        connection.admitted &&
        connection.descriptor !== undefined &&
        connection.socket.readyState === WebSocket.OPEN &&
        this.#isCurrentConnection(connection),
    );
  }

  #isCurrentConnection(connection: ServerConnection): boolean {
    return (
      connection.descriptor !== undefined &&
      connection.connectionGeneration !== undefined &&
      this.#activeConnections.get(connection.descriptor.host.id) === connection &&
      this.#latestConnectionGenerations.get(connection.descriptor.host.id) ===
        connection.connectionGeneration
    );
  }

  #selectConnection(
    profile: WorkerProfileRef,
    contextPlan: TagContextPlan,
    requiresCoordination = false,
    requiresSurfaceCoordination = false,
    execution: TaskExecutionRequirements = {},
    allowedWorkerHostIds?: readonly string[],
    coordinationSlot = false,
  ): ServerConnection | undefined {
    return this.#readyConnections()
      .filter(
        (connection) =>
          allowedWorkerHostIds === undefined ||
          allowedWorkerHostIds.includes(connection.descriptor?.host.id ?? ""),
      )
      .filter(connectionUsesDurableProtocol)
      .filter(
        (connection) =>
          this.#availableWorker(
            connection,
            profile,
            contextPlan,
            requiresCoordination,
            requiresSurfaceCoordination,
            execution,
            undefined,
            coordinationSlot,
          ) !== undefined,
      )
      .filter(
        (connection) =>
          this.#activeAttempts(connection.socket) < this.#capacity(connection, coordinationSlot),
      )
      .sort((left, right) => {
        const load =
          this.#activeAttempts(left.socket) / this.#capacity(left) -
          this.#activeAttempts(right.socket) / this.#capacity(right);
        return load === 0
          ? (left.descriptor?.id ?? "").localeCompare(right.descriptor?.id ?? "")
          : load;
      })[0];
  }

  #availableWorker(
    connection: ServerConnection,
    profile: WorkerProfileRef,
    contextPlan: TagContextPlan,
    requiresCoordination: boolean,
    requiresSurfaceCoordination = false,
    execution: TaskExecutionRequirements = {},
    selectedWorkerId?: string,
    coordinationSlot = false,
  ): WorkerDescriptor | undefined {
    const active = (workerId: string) => this.#activeWorkerAttempts(connection, workerId);
    return connection.descriptor?.host.workers
      .filter(
        (worker) =>
          (selectedWorkerId === undefined || worker.id === selectedWorkerId) &&
          worker.profiles.some(
            (candidate) => candidate.id === profile.id && candidate.revision === profile.revision,
          ) &&
          descriptorSupportsExecution(worker, profile, execution) &&
          descriptorSupportsRequiredContext(worker, contextPlan, profile) &&
          (!requiresCoordination ||
            (requiresSurfaceCoordination
              ? descriptorSupportsSurfaceCoordination(worker, profile)
              : descriptorSupportsCoordination(worker, profile))) &&
          active(worker.id) < workerSlots(worker, coordinationSlot),
      )
      .sort(
        (left, right) =>
          active(left.id) / (left.maxConcurrency ?? 1) -
            active(right.id) / (right.maxConcurrency ?? 1) || left.id.localeCompare(right.id),
      )[0];
  }

  #activeWorkerAttempts(connection: ServerConnection, workerId: string): number {
    return [...this.#durableReservations.values()].filter(
      (job) =>
        job.socket === connection.socket &&
        (job.workerId === undefined || job.workerId === workerId),
    ).length;
  }

  #availableSlots(connection: ServerConnection): number {
    return (
      connection.descriptor?.host.workers.reduce(
        (total, worker) =>
          total +
          Math.max(
            0,
            (worker.maxConcurrency ?? 1) - this.#activeWorkerAttempts(connection, worker.id),
          ),
        0,
      ) ?? 0
    );
  }

  #activeAttempts(socket: MessageSocket): number {
    return [...this.#durableReservations.values()].filter((job) => job.socket === socket).length;
  }

  #capacity(connection: Pick<ServerConnection, "descriptor">, coordinationSlot = false): number {
    return Math.max(
      1,
      connection.descriptor?.host.workers.reduce(
        (total, worker) => total + workerSlots(worker, coordinationSlot),
        0,
      ) ?? 1,
    );
  }

  #workerHostStatus(worklet: KnownWorklet): WorkerHostStatus {
    const connection = [...this.#connections].find(
      (candidate) =>
        candidate.descriptor?.host.id === worklet.descriptor.host.id &&
        this.#isCurrentConnection(candidate),
    );
    const activeAttempts = connection === undefined ? 0 : this.#activeAttempts(connection.socket);
    const capacity =
      connection === undefined
        ? this.#descriptorCapacity(worklet.descriptor)
        : this.#capacity(connection);
    const availableSlots = connection === undefined ? 0 : this.#availableSlots(connection);
    const ready = worklet.connected && !worklet.draining && availableSlots > 0;
    return {
      descriptor: worklet.descriptor.host,
      workletId: worklet.descriptor.id,
      conditions: [
        {
          type: "Connected",
          status: worklet.connected,
          reason: worklet.connected ? "SocketOpen" : "SocketClosed",
          lastTransitionAt: worklet.lastTransitionAt,
        },
        {
          type: "Ready",
          status: ready,
          reason: ready
            ? "CapacityAvailable"
            : worklet.draining
              ? "Draining"
              : worklet.connected
                ? "AtCapacity"
                : "Unreachable",
          lastTransitionAt: worklet.lastTransitionAt,
        },
        {
          type: "Draining",
          status: worklet.draining,
          reason: worklet.draining ? "OperatorRequested" : "AcceptingTasks",
          lastTransitionAt: worklet.lastTransitionAt,
        },
        {
          type: "Unreachable",
          status: !worklet.connected,
          reason: worklet.connected ? "HeartbeatObserved" : "ConnectionLost",
          lastTransitionAt: worklet.lastTransitionAt,
        },
      ],
      lastHeartbeatAt: new Date(worklet.lastSeenAt).toISOString(),
      activeAttempts,
      capacity,
      availableSlots: ready ? availableSlots : 0,
    };
  }

  #descriptorCapacity(descriptor: WorkletDescriptor): number {
    return Math.max(
      1,
      descriptor.host.workers.reduce((total, worker) => total + (worker.maxConcurrency ?? 1), 0),
    );
  }

  #session(connection: ServerConnection): AuthenticatedWorkletSession {
    if (
      connection.descriptor === undefined ||
      connection.protocolVersion === undefined ||
      connection.connectionGeneration === undefined
    )
      throw new Error("Worklet connection has not authenticated");
    return {
      workerHostId: connection.descriptor.host.id,
      workletId: connection.descriptor.id,
      connectionGeneration: connection.connectionGeneration,
      protocolVersion: connection.protocolVersion,
    };
  }

  /** Applies host labels a heartbeat reports, so placement follows them without a reconnect. */
  #relabel(connection: ServerConnection, value: unknown): void {
    const descriptor = connection.descriptor;
    if (descriptor === undefined) return;
    const labels = workerHostLabels(value);
    const relabelled = { ...descriptor, host: { ...descriptor.host, labels } };
    connection.descriptor = relabelled;
    const known = this.#knownWorklets.get(descriptor.host.id);
    if (known !== undefined && this.#isCurrentConnection(connection))
      this.#knownWorklets.set(descriptor.host.id, { ...known, descriptor: relabelled });
  }

  /**
   * Applies the per-Worker concurrency a heartbeat reports, so placement and the stored capacity
   * follow a host whose limit changed without a reconnect. A lower limit starts nothing new on a
   * Worker until its running Task Attempts fit under it; running ones continue. A resize keeps
   * the per-Worker and per-host limits a connection enforces, and one past them changes nothing.
   */
  #resize(connection: ServerConnection, value: unknown): void {
    const descriptor = connection.descriptor;
    if (descriptor === undefined) return;
    const limits = workerConcurrencyLimits(value);
    const workers = descriptor.host.workers.map((worker) => {
      const limit = limits[worker.id];
      return limit === undefined ? worker : { ...worker, maxConcurrency: limit };
    });
    if (
      workers.reduce((total, worker) => total + (worker.maxConcurrency ?? 1), 0) >
      MAX_WORKER_HOST_CAPACITY
    )
      throw new Error(`Worker Host capacity must not exceed ${MAX_WORKER_HOST_CAPACITY}`);
    const resized = { ...descriptor, host: { ...descriptor.host, workers } };
    connection.descriptor = resized;
    const known = this.#knownWorklets.get(descriptor.host.id);
    if (known !== undefined && this.#isCurrentConnection(connection))
      this.#knownWorklets.set(descriptor.host.id, { ...known, descriptor: resized });
  }

  #observe(
    connection: ServerConnection,
    connected: boolean,
    changedPaths?: WorkletConnectionObservation["changedPaths"],
  ): void {
    if (
      this.#onWorkletObserved === undefined ||
      connection.descriptor === undefined ||
      connection.protocolVersion === undefined ||
      connection.connectionGeneration === undefined
    )
      return;
    void this.#queueObservation({
      ...this.#observation(connection, connected),
      ...(changedPaths === undefined ? {} : { changedPaths }),
    }).then(
      (authority) => {
        this.#applyAuthoritativeObservation(connection, authority);
        if (
          authority === false &&
          connection.socket.readyState === WebSocket.OPEN &&
          this.#isCurrentConnection(connection)
        )
          connection.socket.close(4007, "Worker Host connection generation lost authority");
      },
      () => {
        if (
          connection.socket.readyState === WebSocket.OPEN &&
          this.#isCurrentConnection(connection)
        )
          connection.socket.close(1011, "Worker Host authority validation unavailable");
      },
    );
  }

  #observation(connection: ServerConnection, connected: boolean): WorkletConnectionObservation {
    const descriptor = connection.descriptor;
    if (descriptor === undefined) throw new Error("Worklet connection has not authenticated");
    const capacity = this.#capacity(connection);
    const activeAttempts = this.#activeAttempts(connection.socket);
    return {
      ...this.#session(connection),
      descriptor,
      observedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date(connection.lastSeenAt).toISOString(),
      connected,
      draining: connection.draining,
      activeAttempts,
      capacity,
      availableSlots: connected && !connection.draining ? this.#availableSlots(connection) : 0,
    };
  }

  #applyAuthoritativeObservation(connection: ServerConnection, authority: unknown): void {
    if (
      isObject(authority) &&
      typeof authority["draining"] === "boolean" &&
      connection.draining !== authority["draining"]
    ) {
      connection.draining = authority["draining"];
      connection.lastTransitionAt = new Date().toISOString();
    }
  }

  #observeReleasedClaim(
    descriptor: WorkletDescriptor,
    protocolVersion: WorkletProtocolVersion,
    connectionGeneration: number,
    draining: boolean,
    lastSeenAt: number,
  ): void {
    if (this.#onWorkletObserved === undefined) return;
    const capacity = this.#descriptorCapacity(descriptor);
    void this.#queueObservation({
      descriptor,
      workerHostId: descriptor.host.id,
      workletId: descriptor.id,
      connectionGeneration,
      protocolVersion,
      observedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date(lastSeenAt).toISOString(),
      connected: false,
      draining,
      activeAttempts: 0,
      capacity,
      availableSlots: 0,
    }).catch(() => undefined);
  }

  #queueObservation(observation: WorkletConnectionObservation): Promise<unknown> {
    const workerHostId = observation.workerHostId;
    const previous = this.#observationTails.get(workerHostId) ?? Promise.resolve();
    const operation = previous
      .catch((error) => this.#reportError(error))
      .then(() => this.#onWorkletObserved?.(observation));
    const tail = operation.then(
      () => undefined,
      (error) => this.#reportError(error),
    );
    this.#observationTails.set(workerHostId, tail);
    void tail.finally(() => {
      if (this.#observationTails.get(workerHostId) === tail)
        this.#observationTails.delete(workerHostId);
    });
    return operation;
  }

  #callLifecycleCallback(
    callback: RemoteWorkletServerOptions["onWorkletConnected"],
    descriptor: WorkletDescriptor,
    session: AuthenticatedWorkletSession,
  ): void {
    try {
      callback?.(descriptor, session);
    } catch (error) {
      this.#reportError(error);
    }
  }

  readonly #evictUnresponsiveConnections = () => {
    const cutoff = Date.now() - this.#heartbeatTimeoutMs;
    for (const connection of this.#connections) {
      if (connection.lastSeenAt < cutoff) connection.socket.close(4005, "Heartbeat timed out");
    }
  };

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Observability callbacks cannot take down the persistent transport.
    }
  }
}

export interface WorkletConnectionOptions {
  /** Current free space on the Worker Host scratch filesystem. */
  readonly diskSpace?: () => Promise<{ readonly freeBytes: number; readonly totalBytes: number }>;
  /** Current paths changed by running local Task Attempts; probed after the liveness heartbeat. */
  readonly changedPaths?: () => Promise<
    readonly {
      readonly attemptId: string;
      readonly paths: readonly string[];
      readonly truncated: boolean;
    }[]
  >;
  readonly transport?: "websocket" | "grpc";
  readonly tlsCa?: string;
  readonly maxPendingFrames?: number;
  readonly maxPendingBytes?: number;
  readonly url: string;
  /** Per-Worker-Host enrollment credential. */
  readonly credential: string;
  readonly worklet: Worklet;
  readonly durableWorklet?: DurableWorklet;
  readonly reconnectIntervalMs?: number;
  /** Defaults to protocol 18; an explicit value must be exactly `[18]`. */
  readonly protocolVersions?: readonly number[];
  readonly onError?: (error: unknown) => void;
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
}

/** Persistent outbound connection from a Worklet to the Control Plane. */
export class WorkletConnection {
  readonly #transportOptions: WorkletConnectionOptions;
  readonly #supportsControl: boolean;
  readonly #supportsDurableExecution: boolean;
  readonly #url: string;
  readonly #credential: string;
  readonly #worklet: Worklet;
  readonly #durable: DurableHostProtocol;
  readonly #reconnectIntervalMs: number;
  readonly #protocolVersions: readonly number[];
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onConnected: (() => void) | undefined;
  readonly #onDisconnected: (() => void) | undefined;
  /** Sends one heartbeat of the current session now; unset while disconnected. */
  #beat: (() => void) | undefined;
  #running = false;
  #connected = false;
  // Extension promises cannot be cancelled; retain the guard across reconnects.
  #labelProbePending = false;
  #changedPathsProbePending = false;
  #negotiatedProtocolVersion: number | undefined;
  #connectionGeneration: number | undefined;
  #socket: MessageSocket | undefined;
  #loop: Promise<void> | undefined;
  #firstReady: Promise<void> | undefined;
  #resolveFirstReady: (() => void) | undefined;
  #rejectFirstReady: ((error: Error) => void) | undefined;
  #wakeReconnect: (() => void) | undefined;

  constructor(options: WorkletConnectionOptions) {
    // An explicit WebSocket URL selects WebSocket; HTTP(S) origins use gRPC.
    // This selects once, before connecting. Failures never cause cross-transport redispatch.
    options = {
      ...options,
      transport:
        options.transport ??
        (["ws:", "wss:"].includes(new URL(options.url).protocol) ? "websocket" : "grpc"),
    };
    this.#transportOptions = options;
    if (options.transport === "grpc") validateGrpcWorkletOptions(options);
    if (options.transport === "grpc" && !options.durableWorklet)
      throw new Error("gRPC requires a durableWorklet");
    requireNonEmpty(options.url, "url");
    const credential = options.credential;
    if (credential === undefined) throw new Error("credential is required");
    requireNonEmpty(credential, "credential");
    this.#url = options.url;
    this.#credential = credential;
    this.#worklet = options.worklet;
    this.#supportsControl =
      !!options.durableWorklet?.control && !!options.durableWorklet?.controlCapabilities;
    this.#supportsDurableExecution = options.durableWorklet !== undefined;
    this.#durable = new DurableHostProtocol(options.durableWorklet ?? options.worklet);
    this.#reconnectIntervalMs = positiveDuration(
      options.reconnectIntervalMs,
      DEFAULT_RECONNECT_INTERVAL_MS,
      "reconnectIntervalMs",
    );
    this.#protocolVersions = protocolVersions(options.protocolVersions);
    if (
      this.#protocolVersions.length !== 1 ||
      this.#protocolVersions[0] !== WORKLET_PROTOCOL_VERSION
    )
      throw new Error("Only Worklet protocol 18 is supported");
    this.#onError = options.onError;
    this.#onConnected = options.onConnected;
    this.#onDisconnected = options.onDisconnected;
  }

  get isConnected(): boolean {
    return this.#connected;
  }

  get negotiatedProtocolVersion(): number | undefined {
    return this.#negotiatedProtocolVersion;
  }

  get connectionGeneration(): number | undefined {
    return this.#connectionGeneration;
  }

  async start(): Promise<void> {
    if (this.#running) return await this.#firstReady;
    this.#running = true;
    this.#firstReady = new Promise<void>((resolve, reject) => {
      this.#resolveFirstReady = resolve;
      this.#rejectFirstReady = reject;
    });
    this.#loop = this.#runConnectionLoop();
    await this.#firstReady;
  }

  /**
   * Sends a heartbeat now instead of at the next interval, carrying host labels or Worker
   * concurrency that changed. Does nothing while disconnected; the next hello describes them.
   */
  heartbeat(): void {
    this.#beat?.();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#rejectFirstReady?.(new Error("Remote Worklet client stopped before connecting"));
    this.#resolveFirstReady = undefined;
    this.#rejectFirstReady = undefined;
    this.#wakeReconnect?.();
    this.#socket?.close(1000, "Worklet shutting down");
    await this.#loop;
    this.#loop = undefined;
    this.#firstReady = undefined;
  }

  async #runConnectionLoop(): Promise<void> {
    while (this.#running) {
      try {
        await this.#runSession();
      } catch (error) {
        this.#reportError(error);
      }
      if (this.#running) await this.#waitBeforeReconnect();
    }
  }

  async #runSession(): Promise<void> {
    const {
      controlProtocolVersion: _control,
      durableProtocolVersion: _durable,
      ...baseDescriptor
    } = await this.#worklet.describe();
    const descriptor = {
      ...baseDescriptor,
      ...(this.#supportsDurableExecution ? { durableProtocolVersion: 1 as const } : {}),
      ...(this.#supportsControl ? { controlProtocolVersion: 1 as const } : {}),
    };
    await new Promise<void>((resolve) => {
      const socket: MessageSocket =
        this.#transportOptions.transport === "grpc"
          ? createGrpcWorkletSocket({ ...this.#transportOptions, credential: this.#credential })
          : new WebSocket(this.#url);
      this.#socket = socket;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let cancelProbes: (() => void) | undefined;
      let settled = false;
      let registered = false;
      const endSession = () => {
        if (settled) return;
        settled = true;
        this.#durable.disconnected(socket);
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
        cancelProbes?.();
        this.#beat = undefined;
        const wasConnected = this.#connected;
        this.#connected = false;
        this.#negotiatedProtocolVersion = undefined;
        this.#connectionGeneration = undefined;
        if (this.#socket === socket) this.#socket = undefined;
        if (wasConnected) this.#onDisconnected?.();
        resolve();
      };

      socket.on("open", () => {
        sendJson(socket, {
          type: "hello",
          protocolVersions: this.#protocolVersions,
          credential: this.#credential,
          worklet: descriptor,
        });
      });
      listenSocketMessages(socket, parseObjectMessage, (message) => {
        try {
          if (message["type"] === "ready") {
            if (
              !this.#protocolVersions.includes(requiredPositiveNumber(message, "protocolVersion"))
            ) {
              throw new Error("Control Plane selected an unsupported Worklet protocol version");
            }
            this.#negotiatedProtocolVersion = requiredPositiveNumber(message, "protocolVersion");
            this.#connectionGeneration = optionalConnectionGeneration(
              message["connectionGeneration"],
            );
            registered = true;
            this.#connected = true;
            this.#resolveFirstReady?.();
            this.#resolveFirstReady = undefined;
            this.#rejectFirstReady = undefined;
            this.#onConnected?.();
            let sentLabels = JSON.stringify(descriptor.host.labels ?? []);
            let sentConcurrency = concurrencyKey(
              Object.fromEntries(
                descriptor.host.workers.map((worker) => [worker.id, worker.maxConcurrency ?? 1]),
              ),
            );
            let active = true;
            let labelProbeTimer: NodeJS.Timeout | undefined;
            let concurrencyPending = false;
            cancelProbes = () => {
              active = false;
              clearTimeout(labelProbeTimer);
              concurrencyPending = false;
            };
            const beat = () => {
              // Liveness must never wait for host label or Worker probes. A slow external
              // credential check can otherwise make the Control Plane expire this connection.
              if (socket.readyState !== WebSocket.OPEN) return;
              sendJson(socket, { type: "heartbeat", at: new Date().toISOString() });
              if (!this.#changedPathsProbePending && this.#transportOptions.changedPaths) {
                this.#changedPathsProbePending = true;
                void Promise.resolve()
                  .then(() => this.#transportOptions.changedPaths?.())
                  .then((changedPaths) => {
                    if (active && socket.readyState === WebSocket.OPEN && changedPaths?.length)
                      sendJson(socket, {
                        type: "heartbeat",
                        at: new Date().toISOString(),
                        changedPaths,
                      });
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    this.#changedPathsProbePending = false;
                  });
              }
              {
                const diskSpace = this.#transportOptions.diskSpace ?? defaultDiskSpace;
                void diskSpace()
                  .then((diskSpace) => {
                    if (active && socket.readyState === WebSocket.OPEN)
                      sendJson(socket, {
                        type: "heartbeat",
                        at: new Date().toISOString(),
                        diskSpace: validDiskSpace(diskSpace),
                      });
                  })
                  .catch(() => undefined);
              }
              if (!this.#labelProbePending && this.#worklet.hostLabels) {
                this.#labelProbePending = true;
                // Expire the observation, but keep one probe in flight until it settles.
                let expired = false;
                labelProbeTimer = setTimeout(() => {
                  expired = true;
                }, 5000);
                labelProbeTimer.unref();
                void Promise.resolve()
                  .then(() => this.#worklet.hostLabels?.())
                  .then((labels) => {
                    if (
                      !active ||
                      expired ||
                      socket.readyState !== WebSocket.OPEN ||
                      labels === undefined
                    )
                      return;
                    const key = JSON.stringify(labels);
                    if (key !== sentLabels) {
                      sendJson(socket, {
                        type: "heartbeat",
                        at: new Date().toISOString(),
                        hostLabels: labels,
                      });
                      sentLabels = key;
                    }
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    clearTimeout(labelProbeTimer);
                    this.#labelProbePending = false;
                  });
              }
              if (!concurrencyPending && this.#worklet.workerConcurrency) {
                concurrencyPending = true;
                void Promise.resolve()
                  .then(() => this.#worklet.workerConcurrency?.())
                  .then((concurrency) => {
                    if (
                      !active ||
                      socket.readyState !== WebSocket.OPEN ||
                      concurrency === undefined
                    )
                      return;
                    const key = concurrencyKey(concurrency);
                    if (key !== sentConcurrency) {
                      sendJson(socket, {
                        type: "heartbeat",
                        at: new Date().toISOString(),
                        workerConcurrency: concurrency,
                      });
                      sentConcurrency = key;
                    }
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    if (active) concurrencyPending = false;
                  });
              }
            };
            this.#beat = beat;
            heartbeatTimer = setInterval(
              beat,
              requiredPositiveNumber(message, "heartbeatIntervalMs"),
            );
            heartbeatTimer.unref();
            return;
          }
          if (
            message["type"] === "durable_request" ||
            message["type"] === "durable_unsubscribe" ||
            message["type"] === "control_take_result"
          ) {
            if (!registered) throw new Error("Worklet protocol 18 registration is required");
            if (
              !this.#supportsDurableExecution &&
              message["operation"] !== "select_placement" &&
              message["operation"] !== "release_placement"
            )
              throw new Error("Durable requests require a durableWorklet");
            void this.#durable
              .receive(socket, message)
              .catch((error: unknown) => this.#reportError(error));
            return;
          }
          if (message["type"] === "job" || message["type"] === "cancel")
            throw new Error("Worklet protocol 18 requires durable execution requests");
          if (message["type"] === "protocol_error") {
            this.#reportError(new Error(requiredString(message, "message")));
          }
        } catch (error) {
          this.#reportError(error);
          socket.close(4006, "Invalid Control Plane message");
        }
      });
      socket.on("error", (error) => this.#reportError(error));
      socket.on("close", (code, reason) => {
        if (isPermanentRegistrationFailure(code)) {
          const error = new Error(
            reason.toString() || `Control Plane rejected Worklet registration (${code})`,
          );
          this.#running = false;
          if (!registered) {
            this.#rejectFirstReady?.(error);
            this.#resolveFirstReady = undefined;
            this.#rejectFirstReady = undefined;
          }
          this.#reportError(error);
        }
        endSession();
      });
    });
  }

  async #waitBeforeReconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#wakeReconnect = undefined;
        resolve();
      }, this.#reconnectIntervalMs);
      this.#wakeReconnect = () => {
        clearTimeout(timeout);
        this.#wakeReconnect = undefined;
        resolve();
      };
    });
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Observability callbacks cannot terminate the reconnect loop.
    }
  }
}

/** Connects a Worklet outbound and returns its persistent connection handle. */
export async function connectWorklet(
  options: WorkletConnectionOptions,
): Promise<WorkletConnection> {
  const connection = new WorkletConnection(options);
  await connection.start();
  return connection;
}

function connectionUsesDurableProtocol(connection: {
  readonly protocolVersion?: number | undefined;
  readonly descriptor?: { readonly durableProtocolVersion?: 1 } | undefined;
}): boolean {
  return connection.protocolVersion === 18 && connection.descriptor?.durableProtocolVersion === 1;
}

function validateCapabilitySupport(capabilities: unknown[], contextTypes: unknown[]) {
  if (capabilities.length > MAX_DESCRIPTOR_ITEMS || contextTypes.length > MAX_DESCRIPTOR_ITEMS)
    throw new Error(`Worker capability and context arrays must not exceed ${MAX_DESCRIPTOR_ITEMS}`);
  const capabilityKeys = new Set<string>();
  for (const capability of capabilities) {
    if (!isObject(capability)) throw new Error("Worker capability must be an object");
    const id = boundedDescriptorString(capability, "id");
    if (!Number.isSafeInteger(capability["version"]) || Number(capability["version"]) <= 0)
      throw new Error("Worker capability version must be a positive safe integer");
    const key = `${id}@${String(capability["version"])}`;
    if (capabilityKeys.has(key)) throw new Error("Worker capabilities must be unique");
    capabilityKeys.add(key);
  }
  const contextKeys = new Set<string>();
  for (const support of contextTypes) {
    if (!isObject(support)) throw new Error("Worker context type support must be an object");
    const type = boundedDescriptorString(support, "type");
    if (
      !Array.isArray(support["versions"]) ||
      support["versions"].length === 0 ||
      support["versions"].length > MAX_DESCRIPTOR_ITEMS ||
      !support["versions"].every((version) => Number.isSafeInteger(version) && Number(version) > 0)
    )
      throw new Error("Worker context type versions must be positive safe integers");
    if (new Set(support["versions"]).size !== support["versions"].length)
      throw new Error("Worker context type versions must be unique");
    if (contextKeys.has(type)) throw new Error("Worker context type support must be unique");
    contextKeys.add(type);
  }
}

function workletDescriptorFromMessage(message: Record<string, unknown>): WorkletDescriptor {
  const worklet = requiredObject(message, "worklet");
  boundedDescriptorString(worklet, "id");
  if (worklet["durableProtocolVersion"] !== undefined && worklet["durableProtocolVersion"] !== 1)
    throw new Error("Unsupported Worklet durable protocol");
  if (worklet["controlProtocolVersion"] !== undefined && worklet["controlProtocolVersion"] !== 1)
    throw new Error("Unsupported Worklet control protocol");
  if (worklet["protocolVersion"] !== 1)
    throw new Error("Worklet descriptor protocolVersion must be 1");
  const host = requiredObject(worklet, "host");
  boundedDescriptorString(host, "id");
  if (host["workspaces"] !== undefined) workspaceNames(host["workspaces"]);
  if (host["labels"] !== undefined) workerHostLabels(host["labels"]);
  if (
    !Array.isArray(host["workers"]) ||
    host["workers"].length === 0 ||
    host["workers"].length > MAX_WORKERS_PER_HOST
  )
    throw new Error(`Worker Host descriptor must advertise 1-${MAX_WORKERS_PER_HOST} Workers`);
  const workerIds = new Set<string>();
  let hostCapacity = 0;
  for (const value of host["workers"]) {
    if (!isObject(value)) throw new Error("Worker Host descriptor worker must be an object");
    const workerId = boundedDescriptorString(value, "id");
    if (workerIds.has(workerId))
      throw new Error("Worker Host descriptor Worker IDs must be unique");
    workerIds.add(workerId);
    boundedDescriptorString(value, "type");
    if (
      !Array.isArray(value["capabilities"]) ||
      !Array.isArray(value["profiles"]) ||
      !Array.isArray(value["contextTypes"])
    )
      throw new Error("Worker descriptor capabilities, profiles, and contextTypes must be arrays");
    if (value["profiles"].length === 0 || value["profiles"].length > MAX_PROFILES_PER_WORKER)
      throw new Error(`Worker descriptor must advertise 1-${MAX_PROFILES_PER_WORKER} profiles`);
    const profileKeys = new Set<string>();
    for (const profileValue of value["profiles"]) {
      if (!isObject(profileValue)) throw new Error("Worker profile must be an object");
      const id = boundedDescriptorString(profileValue, "id");
      const revision = boundedDescriptorString(profileValue, "revision");
      const key = JSON.stringify([id, revision]);
      if (profileKeys.has(key)) throw new Error("Worker profiles must be unique");
      profileKeys.add(key);
    }
    const maxConcurrency = value["maxConcurrency"] ?? 1;
    if (
      !Number.isSafeInteger(maxConcurrency) ||
      Number(maxConcurrency) < 1 ||
      Number(maxConcurrency) > MAX_WORKER_CONCURRENCY
    )
      throw new Error(
        `Worker maxConcurrency must be an integer from 1 through ${MAX_WORKER_CONCURRENCY}`,
      );
    hostCapacity += Number(maxConcurrency);
    if (hostCapacity > MAX_WORKER_HOST_CAPACITY)
      throw new Error(`Worker Host capacity must not exceed ${MAX_WORKER_HOST_CAPACITY}`);
    {
      if (
        !Array.isArray(value["profileCapabilities"]) ||
        value["profileCapabilities"].length > MAX_PROFILES_PER_WORKER
      )
        throw new Error("Worker profileCapabilities must be a bounded array");
      const seen = new Set<string>();
      for (const support of value["profileCapabilities"]) {
        if (!isObject(support))
          throw new Error("Worker profile capability support must be an object");
        const profile = requiredObject(support, "profile");
        const id = boundedDescriptorString(profile, "id");
        const revision = boundedDescriptorString(profile, "revision");
        const key = JSON.stringify([id, revision]);
        if (seen.has(key) || !profileKeys.has(key))
          throw new Error(
            "Worker profile capability support must uniquely reference an advertised profile",
          );
        seen.add(key);
        if (!Array.isArray(support["capabilities"]) || !Array.isArray(support["contextTypes"]))
          throw new Error("Worker profile capabilities and contextTypes must be arrays");
        if (support["harness"] !== undefined) boundedDescriptorString(support, "harness");
        if (support["models"] !== undefined) {
          const models = support["models"];
          if (
            !Array.isArray(models) ||
            models.length > 32 ||
            new Set(models).size !== models.length ||
            models.some(
              (model) =>
                typeof model !== "string" ||
                model.length === 0 ||
                model.length > 200 ||
                /\p{Cc}/u.test(model),
            )
          )
            throw new Error("Worker profile models must be a bounded list of distinct names");
        }
        if (support["efforts"] !== undefined) {
          const efforts = support["efforts"];
          if (
            !Array.isArray(efforts) ||
            new Set(efforts).size !== efforts.length ||
            efforts.some((effort) => !["low", "medium", "high"].includes(effort))
          )
            throw new Error("Worker profile efforts must list distinct low, medium, or high");
        }
        validateCapabilitySupport(support["capabilities"], support["contextTypes"]);
      }
    }
    validateCapabilitySupport(value["capabilities"], value["contextTypes"]);
  }
  return worklet as unknown as WorkletDescriptor;
}

function parseObjectMessage(raw: RawData): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.toString());
  if (!isObject(value)) throw new Error("Worklet protocol message must be a JSON object");
  return value;
}

function validDiskSpace(value: unknown): {
  readonly freeBytes: number;
  readonly totalBytes: number;
} {
  if (!isObject(value)) throw new Error("Worker Host disk space must be an object");
  const freeBytes = value["freeBytes"];
  const totalBytes = value["totalBytes"];
  if (
    typeof freeBytes !== "number" ||
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(freeBytes) ||
    !Number.isSafeInteger(totalBytes) ||
    freeBytes < 0 ||
    totalBytes <= 0 ||
    freeBytes > totalBytes
  )
    throw new Error("Worker Host disk space must contain valid free and total byte counts");
  return { freeBytes, totalBytes };
}

async function defaultDiskSpace(): Promise<{
  readonly freeBytes: number;
  readonly totalBytes: number;
}> {
  const volume = await statfs(tmpdir());
  return { freeBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize };
}

function requiredObject(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object[key];
  if (!isObject(value)) throw new Error(`Worklet protocol ${key} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Worklet protocol ${key} must be non-empty`);
  }
  return value;
}

function boundedDescriptorString(object: Record<string, unknown>, key: string): string {
  const value = requiredString(object, key);
  if (value.length > MAX_DESCRIPTOR_TEXT_LENGTH || /\p{Cc}/u.test(value))
    throw new Error(
      `Worklet descriptor ${key} must be at most ${MAX_DESCRIPTOR_TEXT_LENGTH} characters without control characters`,
    );
  return value;
}

function requiredPositiveNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Worklet protocol ${key} must be a positive number`);
  }
  return value;
}

function connectionGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error("Worklet connection generation must be a positive safe integer");
  return Number(value);
}

function optionalConnectionGeneration(value: unknown): number | undefined {
  return value === undefined ? undefined : connectionGeneration(value);
}

function requiredProtocolVersions(object: Record<string, unknown>, key: string): readonly number[] {
  const value = object[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((version) => !Number.isInteger(version) || version < 1)
  ) {
    throw new Error(`Worklet protocol ${key} must contain 1 through 32 positive integer versions`);
  }
  return [...(value as number[])];
}

function protocolVersions(value: readonly number[] | undefined): readonly number[] {
  return requiredProtocolVersions(
    { protocolVersions: value ?? SUPPORTED_WORKLET_PROTOCOL_VERSIONS },
    "protocolVersions",
  );
}

function validReservedPlacement(
  descriptor: WorkletDescriptor,
  placement: WorkletExecutionPlacement,
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions,
): boolean {
  if (
    placement.workerHostId !== descriptor.host.id ||
    placement.workletId !== descriptor.id ||
    !placement.reservation ||
    placement.reservation.id.length === 0 ||
    !Number.isFinite(Date.parse(placement.reservation.expiresAt)) ||
    Date.parse(placement.reservation.expiresAt) <= Date.now()
  )
    return false;
  const worker = descriptor.host.workers.find((candidate) => candidate.id === placement.workerId);
  if (
    !worker?.profiles.some(
      (profile) =>
        profile.id === placement.workerProfile.id &&
        profile.revision === placement.workerProfile.revision,
    ) ||
    !descriptorSupportsExecution(worker, placement.workerProfile, requirements) ||
    !descriptorSupportsRequiredContext(worker, contextPlan, placement.workerProfile) ||
    (options.requiresCoordination &&
      !descriptorSupportsCoordination(worker, placement.workerProfile)) ||
    (options.requiresSurfaceCoordination &&
      !descriptorSupportsSurfaceCoordination(worker, placement.workerProfile)) ||
    (options.compatibleProfile !== undefined &&
      (placement.workerProfile.id !== options.compatibleProfile.id ||
        placement.workerProfile.revision !== options.compatibleProfile.revision)) ||
    (options.allowedWorkerHostIds !== undefined &&
      !options.allowedWorkerHostIds.includes(placement.workerHostId))
  )
    return false;
  return true;
}

function sendJson(
  socket: MessageSocket,
  message: WorkletClientMessage | WorkletServerMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Worklet protocol socket is not open");
  sendSocketMessage(socket, message);
}

function sendProtocolError(socket: MessageSocket, code: string, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  sendJson(socket, {
    type: "protocol_error",
    code,
    message,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0)
    throw new Error(`${name} must be a positive number`);
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = positiveDuration(value, fallback, name);
  if (!Number.isInteger(resolved)) throw new Error(`${name} must be an integer`);
  return resolved;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}

function isPermanentRegistrationFailure(code: number): boolean {
  return code === 4002 || code === 4003 || code === 4004 || code === 4007 || code === 4008;
}

export {
  type RpcLifecycleEvent,
  type RpcMethodSnapshot,
  type RpcQueueTelemetry,
  RpcTelemetry,
  type RpcTelemetrySnapshot,
} from "@supertag/worker-sdk";
export { GrpcArtifactCatalogClient, GrpcArtifactHostClient } from "./artifact-client.js";
export * from "./artifact-codec.js";
export { GrpcCoordinationClient } from "./coordination-client.js";
export * from "./coordination-codec.js";
export { GrpcExecutionAuthorityClient } from "./execution-authority-client.js";
export type { TagMailboxClientOptions, TagMessageHandlerContext } from "./mailbox-client.js";
export { TagMailboxClient, TagMailboxClientError } from "./mailbox-client.js";
export * from "./session-codec.js";

/** Compares per-Worker concurrency regardless of key order. */
function concurrencyKey(limits: Readonly<Record<string, number>>): string {
  return JSON.stringify(Object.entries(limits).toSorted(([a], [b]) => a.localeCompare(b)));
}
