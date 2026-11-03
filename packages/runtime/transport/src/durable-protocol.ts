import { createHash, randomUUID } from "node:crypto";
import type { TagContextPlan, TaskExecutionRequirements } from "@supertag/core";
import type {
  DurableWorklet,
  ExecutionSelectionOptions,
  HarnessControlAcknowledgement,
  HarnessControlCapabilities,
  HarnessControlCommand,
  HarnessControlOptions,
  TaskAttemptSpec,
  Worklet,
  WorkletExecutionPlacement,
} from "@supertag/worker-sdk";
import {
  selectWorkletPlacement,
  validateHarnessControlCapabilities,
  validateHarnessControlCommand,
} from "@supertag/worker-sdk";
import {
  redactText,
  sensitiveEnvironmentValues,
  sensitiveFieldValues,
} from "@supertag/worker-sdk/redaction";
import WebSocket from "ws";
import { decodeTaskAttemptEvent, decodeTaskAttemptSpec } from "./attempt-codec.js";
import { type MessageSocket, sendSocketMessage } from "./message-socket.js";

type Inspection = Awaited<ReturnType<DurableWorklet["inspect"]>>;
type Receipt = Awaited<ReturnType<DurableWorklet["accept"]>>;
type Event = ReturnType<DurableWorklet["events"]> extends AsyncIterable<infer T> ? T : never;
interface Reply {
  socket: MessageSocket;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  authorizeInput?: () => Promise<boolean>;
  taking?: boolean;
}
interface Subscription {
  attemptId: string;
  socket: MessageSocket;
  events: Array<{ item: Event; bytes: number }>;
  bufferedBytes: number;
  wake(): void;
  done: boolean;
  error?: Error;
}
function send(socket: MessageSocket, value: unknown) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Durable Worklet disconnected");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Durable message must be an object");
  sendSocketMessage(socket, value as Record<string, unknown>);
}
function validateReceipt(value: unknown, attemptId: string, inspection = false) {
  if (!value || typeof value !== "object") throw new Error("Invalid durable receipt");
  const receipt = value as Record<string, unknown>;
  if (
    receipt["attemptId"] !== attemptId ||
    typeof receipt["taskId"] !== "string" ||
    !receipt["taskId"] ||
    typeof receipt["specDigest"] !== "string" ||
    !receipt["specDigest"] ||
    !["accepted", "running", "completed", "failed", "cancelled", "unknown"].includes(
      String(receipt["status"]),
    )
  )
    throw new Error("Invalid durable receipt identity or status");
  if (
    receipt["workerId"] !== undefined &&
    (typeof receipt["workerId"] !== "string" || !receipt["workerId"])
  )
    throw new Error("Invalid durable receipt Worker");
  if (receipt["control"] !== undefined)
    validateHarnessControlCapabilities(receipt["control"] as HarnessControlCapabilities);
  if (
    inspection &&
    (!Number.isSafeInteger(receipt["lastSequence"]) || Number(receipt["lastSequence"]) < 0)
  )
    throw new Error("Invalid durable receipt cursor");
}
export class DurableControlPlaneProtocol {
  readonly #bufferedBytes = new WeakMap<MessageSocket, number>();
  readonly #requests = new Map<string, Reply>();
  readonly #subscriptions = new Map<string, Subscription>();
  constructor(private readonly timeoutMs: number) {}
  receive(socket: MessageSocket, message: Record<string, unknown>): boolean {
    if (message["type"] === "control_take") {
      const requestId = String(message["requestId"]);
      const request = this.#requests.get(requestId);
      if (!request || request.socket !== socket) return true;
      if (request.taking) return true;
      request.taking = true;
      void Promise.resolve()
        .then(() =>
          this.#requests.get(requestId) === request && socket.readyState === WebSocket.OPEN
            ? request.authorizeInput?.()
            : false,
        )
        .then((allowed) => {
          // The same authenticated connection and outstanding control request must still own it.
          if (this.#requests.get(requestId) === request && socket.readyState === WebSocket.OPEN)
            send(socket, { type: "control_take_result", requestId, allowed: allowed === true });
        })
        .catch(() => {
          // A send can fail after readyState was checked. Refusal or disconnection is fail-closed.
          try {
            if (this.#requests.get(requestId) === request && socket.readyState === WebSocket.OPEN)
              send(socket, { type: "control_take_result", requestId, allowed: false });
          } catch {}
        });
      return true;
    }
    if (message["type"] === "durable_reply") {
      const id = String(message["requestId"]);
      const request = this.#requests.get(id);
      if (!request || request.socket !== socket) return true;
      clearTimeout(request.timer);
      this.#requests.delete(id);
      if (message["error"] !== undefined)
        request.reject(new Error(`Durable Worklet: ${String(message["error"])}`));
      else request.resolve(message["result"]);
      return true;
    }
    if (message["type"] === "durable_event" || message["type"] === "durable_end") {
      const subscription = this.#subscriptions.get(String(message["requestId"]));
      if (!subscription || subscription.socket !== socket || subscription.done) return true;
      if (message["type"] === "durable_end") {
        subscription.done = true;
        if (message["error"] !== undefined)
          subscription.error = new Error(String(message["error"]));
      } else {
        const item = message["item"] as Event;
        if (
          !item ||
          !Number.isSafeInteger(item.sequence) ||
          item.sequence <= 0 ||
          !item.event ||
          item.event.attemptId !== subscription.attemptId
        ) {
          subscription.error = new Error("Invalid durable event sequence");
          subscription.done = true;
        } else {
          try {
            const event = decodeTaskAttemptEvent(item.event);
            const bytes = Buffer.byteLength(JSON.stringify(event));
            const total = this.#bufferedBytes.get(socket) ?? 0;
            if (
              subscription.events.length >= 256 ||
              subscription.bufferedBytes + bytes > 4 * 1024 * 1024 ||
              total + bytes > 8 * 1024 * 1024
            ) {
              subscription.error = new Error(
                "Durable event buffer exhausted; inspect and resume from the last sequence",
              );
              subscription.done = true;
              socket.close(1013, "Durable event buffer exhausted; inspect and resume");
            } else {
              subscription.events.push({ item: { ...item, event }, bytes });
              subscription.bufferedBytes += bytes;
              this.#bufferedBytes.set(socket, total + bytes);
            }
          } catch (error) {
            subscription.error =
              error instanceof Error ? error : new Error("Invalid durable event");
            subscription.done = true;
          }
        }
      }
      subscription.wake();
      return true;
    }
    return false;
  }
  disconnected(socket: MessageSocket) {
    for (const [id, request] of this.#requests)
      if (request.socket === socket) {
        clearTimeout(request.timer);
        this.#requests.delete(id);
        request.reject(
          new Error("Durable Worklet disconnected; acceptance outcome may be unknown"),
        );
      }
    for (const subscription of this.#subscriptions.values())
      if (subscription.socket === socket) {
        subscription.error ??= new Error(
          "Durable Worklet disconnected; resume from the last sequence after inspection",
        );
        subscription.done = true;
        subscription.wake();
      }
  }
  request(
    socket: MessageSocket,
    operation: string,
    input: Record<string, unknown>,
    options?: HarnessControlOptions,
  ): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(requestId);
        reject(new Error("Durable Worklet acknowledgement timed out; outcome may be unknown"));
      }, this.timeoutMs);
      timer.unref();
      this.#requests.set(requestId, {
        socket,
        resolve,
        reject,
        timer,
        ...(options?.authorizeInput ? { authorizeInput: options.authorizeInput } : {}),
      });
      try {
        send(socket, { type: "durable_request", requestId, operation, ...input });
      } catch (error) {
        clearTimeout(timer);
        this.#requests.delete(requestId);
        reject(error);
      }
    });
  }
  async accept(socket: MessageSocket, spec: TaskAttemptSpec): Promise<Receipt> {
    const result = await this.request(socket, "accept", { spec });
    validateReceipt(result, spec.attemptId);
    return result as Receipt;
  }
  async selectPlacement(
    socket: MessageSocket,
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions,
  ): Promise<WorkletExecutionPlacement | undefined> {
    const result = (await this.request(socket, "select_placement", {
      requirements,
      contextPlan,
      options,
    })) as WorkletExecutionPlacement | undefined;
    if (result === undefined) return undefined;
    if (
      typeof result.workerHostId !== "string" ||
      typeof result.workletId !== "string" ||
      typeof result.workerId !== "string" ||
      typeof result.workerProfile?.id !== "string" ||
      typeof result.workerProfile?.revision !== "string" ||
      (result.reservation !== undefined &&
        (typeof result.reservation.id !== "string" ||
          result.reservation.id.length === 0 ||
          typeof result.reservation.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(result.reservation.expiresAt))))
    )
      throw new Error("Invalid Worklet execution placement");
    return result;
  }
  async releasePlacement(
    socket: MessageSocket,
    placement: WorkletExecutionPlacement,
  ): Promise<void> {
    await this.request(socket, "release_placement", { placement });
  }
  async inspect(socket: MessageSocket, attemptId: string): Promise<Inspection> {
    const result = await this.request(socket, "inspect", { attemptId });
    if (result !== undefined) validateReceipt(result, attemptId, true);
    return result as Inspection;
  }
  async control(
    socket: MessageSocket,
    command: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    const result = (await this.request(
      socket,
      "control",
      {
        attemptId: command.attemptId,
        command,
      },
      options,
    )) as HarnessControlAcknowledgement;
    if (
      !result ||
      result.id !== command.id ||
      result.taskId !== command.taskId ||
      result.attemptId !== command.attemptId ||
      !["accepted", "rejected", "unknown"].includes(result.status)
    )
      throw new Error("Invalid control acknowledgement");
    return result;
  }
  async controlCapabilities(
    socket: MessageSocket,
    taskId: string,
    attemptId: string,
  ): Promise<HarnessControlCapabilities | undefined> {
    const result = (await this.request(socket, "control_capabilities", { taskId, attemptId })) as
      | HarnessControlCapabilities
      | undefined;
    if (result) validateHarnessControlCapabilities(result);
    return result ?? undefined;
  }
  cancel(socket: MessageSocket, attemptId: string, reason?: string) {
    return this.request(socket, "cancel", {
      attemptId,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  async *events(
    socket: MessageSocket,
    attemptId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): AsyncIterable<Event> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new Error("Invalid durable event cursor");
    signal?.throwIfAborted();
    const requestId = randomUUID();
    const subscription: Subscription = {
      attemptId,
      socket,
      events: [],
      bufferedBytes: 0,
      wake() {},
      done: false,
    };
    this.#subscriptions.set(requestId, subscription);
    const abort = () => {
      subscription.error = new Error("Durable event observation aborted");
      subscription.done = true;
      subscription.wake();
    };
    signal?.addEventListener("abort", abort, { once: true });
    let sequence = afterSequence;
    try {
      send(socket, {
        type: "durable_request",
        requestId,
        operation: "events",
        attemptId,
        afterSequence,
      });
      while (true) {
        while (subscription.events.length) {
          const buffered = subscription.events.shift();
          if (!buffered) continue;
          subscription.bufferedBytes -= buffered.bytes;
          this.#bufferedBytes.set(socket, (this.#bufferedBytes.get(socket) ?? 0) - buffered.bytes);
          const item = buffered.item;
          if (item.sequence <= sequence) continue;
          if (item.sequence !== sequence + 1)
            throw new Error("Durable event sequence gap; inspect and resume");
          sequence = item.sequence;
          yield item;
        }
        if (subscription.error) throw subscription.error;
        if (subscription.done) return;
        await new Promise<void>((resolve) => {
          subscription.wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#subscriptions.delete(requestId);
      this.#bufferedBytes.set(
        socket,
        (this.#bufferedBytes.get(socket) ?? 0) - subscription.bufferedBytes,
      );
      if (socket.readyState === WebSocket.OPEN)
        send(socket, { type: "durable_unsubscribe", requestId });
    }
  }
}

// Teammate input, the only input that requires a take-time check, releases the harness's
// control queue within one second, check included; a later answer could not be used.
const CONTROL_TAKE_TIMEOUT_MS = 1_000;

export class DurableHostProtocol {
  readonly #takes = new Map<string, { socket: MessageSocket; settle(allowed: boolean): void }>();
  #authorizeInput(socket: MessageSocket, requestId: string): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN || this.#takes.has(requestId))
      return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const expires = performance.now() + CONTROL_TAKE_TIMEOUT_MS;
      const timer = setTimeout(() => settle(false), CONTROL_TAKE_TIMEOUT_MS);
      timer.unref();
      const settle = (allowed: boolean) => {
        clearTimeout(timer);
        this.#takes.delete(requestId);
        resolve(allowed && socket.readyState === WebSocket.OPEN && performance.now() < expires);
      };
      this.#takes.set(requestId, { socket, settle });
      try {
        send(socket, { type: "control_take", requestId });
      } catch {
        settle(false);
      }
    });
  }
  readonly #subscriptions = new Map<string, { socket: MessageSocket; abort: AbortController }>();
  readonly #placementRequests = new WeakMap<MessageSocket, Map<string, PlacementRequest>>();
  readonly #reservationRequests = new WeakMap<MessageSocket, Map<string, Set<string>>>();
  constructor(private readonly worklet: Worklet & Partial<DurableWorklet>) {}
  disconnected(socket: MessageSocket) {
    for (const take of this.#takes.values()) if (take.socket === socket) take.settle(false);
    for (const entry of this.#subscriptions.values())
      if (entry.socket === socket) entry.abort.abort();
    this.#placementRequests.delete(socket);
    this.#reservationRequests.delete(socket);
  }
  async receive(socket: MessageSocket, message: Record<string, unknown>) {
    const requestId = message["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0)
      throw new Error("Durable requestId required");
    if (message["type"] === "control_take_result") {
      const take = this.#takes.get(requestId);
      if (take?.socket === socket) take.settle(message["allowed"] === true);
      return;
    }
    if (message["type"] === "durable_unsubscribe") {
      const entry = this.#subscriptions.get(requestId);
      if (entry?.socket === socket) entry.abort.abort();
      return;
    }
    const operation = message["operation"];
    const attemptId = message["attemptId"];
    try {
      if (
        operation !== "accept" &&
        operation !== "select_placement" &&
        operation !== "release_placement" &&
        (typeof attemptId !== "string" || !attemptId)
      )
        throw new Error("Durable attemptId required");
      let result: unknown;
      if (operation === "select_placement") {
        if (
          !message["requirements"] ||
          typeof message["requirements"] !== "object" ||
          !message["contextPlan"] ||
          typeof message["contextPlan"] !== "object" ||
          !message["options"] ||
          typeof message["options"] !== "object"
        )
          throw new Error("Invalid Worklet placement request");
        result = await this.#placementRequest(
          socket,
          requestId,
          placementFingerprint(message),
          async () =>
            await selectWorkletPlacement(
              this.worklet,
              message["requirements"] as TaskExecutionRequirements,
              message["contextPlan"] as TagContextPlan,
              message["options"] as ExecutionSelectionOptions,
            ),
        );
      } else if (operation === "release_placement") {
        const placement = message["placement"] as WorkletExecutionPlacement | undefined;
        if (
          !placement ||
          typeof placement.workerHostId !== "string" ||
          typeof placement.workletId !== "string" ||
          typeof placement.workerId !== "string" ||
          typeof placement.reservation?.id !== "string" ||
          typeof placement.reservation.expiresAt !== "string"
        )
          throw new Error("Invalid Worklet placement release");
        result = await this.#placementRequest(
          socket,
          requestId,
          placementFingerprint(message),
          async () => {
            await this.worklet.releasePlacement?.(placement);
            this.#invalidateReservation(socket, placement.reservation?.id);
            return { released: true };
          },
        );
      } else if (operation === "accept") {
        if (!this.worklet.accept) throw new Error("Durable Worklet acceptance unsupported");
        result = await this.worklet.accept(decodeTaskAttemptSpec(message["spec"]));
      } else if (operation === "inspect") {
        if (!this.worklet.inspect) throw new Error("Durable Worklet inspection unsupported");
        result = await this.worklet.inspect(attemptId as string);
      } else if (operation === "control") {
        const command = validateHarnessControlCommand(message["command"] as HarnessControlCommand);
        if (command.attemptId !== attemptId) throw new Error("Control Attempt identity mismatch");
        result = this.worklet.control
          ? await this.worklet.control(
              command,
              command.type === "input" && command.requiresInputAuthorization
                ? { authorizeInput: () => this.#authorizeInput(socket, requestId) }
                : undefined,
            )
          : {
              id: command.id,
              taskId: command.taskId,
              attemptId: command.attemptId,
              status: "rejected",
              reason: "Worklet control unsupported",
            };
      } else if (operation === "control_capabilities") {
        if (typeof message["taskId"] !== "string" || !message["taskId"])
          throw new Error("Control taskId required");
        result = await this.worklet.controlCapabilities?.(message["taskId"], attemptId as string);
      } else if (operation === "cancel") {
        if (!this.worklet.cancel) throw new Error("Durable Worklet cancellation unsupported");
        if (message["reason"] !== undefined && typeof message["reason"] !== "string")
          throw new Error("Invalid cancellation reason");
        result = await this.worklet.cancel(
          attemptId as string,
          (message["reason"] as string | undefined) ?? "Cancellation requested",
        );
      } else if (operation === "events") {
        if (!this.worklet.events) throw new Error("Durable Worklet events unsupported");
        const after = message["afterSequence"];
        if (!Number.isSafeInteger(after) || Number(after) < 0)
          throw new Error("Invalid durable event cursor");
        const abort = new AbortController();
        this.#subscriptions.set(requestId, { socket, abort });
        try {
          for await (const item of this.worklet.events(
            attemptId as string,
            Number(after),
            abort.signal,
          )) {
            if (socket.readyState !== WebSocket.OPEN || abort.signal.aborted) return;
            send(socket, { type: "durable_event", requestId, item });
          }
          if (socket.readyState === WebSocket.OPEN)
            send(socket, { type: "durable_end", requestId });
        } finally {
          this.#subscriptions.delete(requestId);
        }
        return;
      } else throw new Error("Unknown durable operation");
      if (socket.readyState === WebSocket.OPEN)
        send(socket, {
          type: "durable_reply",
          requestId,
          result,
          ...(operation === "select_placement"
            ? { resultKind: result === undefined ? "no_placement" : "placement" }
            : operation === "release_placement"
              ? { resultKind: "placement_release" }
              : {}),
        });
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN)
        send(socket, {
          type: operation === "events" ? "durable_end" : "durable_reply",
          requestId,
          error: redactText(error instanceof Error ? error.message : "Durable operation failed", [
            ...sensitiveEnvironmentValues(process.env),
            ...sensitiveFieldValues(message["spec"]),
          ]),
        });
    }
  }

  async #placementRequest<T extends WorkletExecutionPlacement | { released: true } | undefined>(
    socket: MessageSocket,
    requestId: string,
    fingerprint: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (Buffer.byteLength(requestId) > 1_024) throw new Error("Placement requestId exceeds limit");
    let requests = this.#placementRequests.get(socket);
    if (!requests) {
      requests = new Map();
      this.#placementRequests.set(socket, requests);
    }
    const existing = requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Placement requestId reused with different input");
      if (
        !existing.active ||
        (existing.expiresAt !== undefined && existing.expiresAt <= Date.now())
      )
        throw new Error("Placement request is no longer active");
      return (await existing.result) as T;
    }
    // Request IDs are retained for the authenticated connection so an expired or released
    // reservation can never be recreated by replay. Refuse new mutations rather than evicting
    // deduplication evidence under load.
    if (requests.size >= MAX_PLACEMENT_REQUESTS_PER_CONNECTION) {
      socket.close(1013, "Placement replay capacity exhausted; reconnect required");
      throw new Error("Placement request replay capacity exhausted; reconnect before retrying");
    }
    const entry: PlacementRequest = {
      fingerprint,
      active: true,
      result: Promise.resolve().then(execute),
    };
    requests.set(requestId, entry);
    try {
      const result = await entry.result;
      if (isPlacement(result) && result.reservation) {
        const expiresAt = Date.parse(result.reservation.expiresAt);
        if (!Number.isFinite(expiresAt)) {
          entry.active = false;
          throw new Error("Placement reservation has an invalid expiry");
        }
        entry.reservationId = result.reservation.id;
        entry.expiresAt = expiresAt;
        let reservations = this.#reservationRequests.get(socket);
        if (!reservations) {
          reservations = new Map();
          this.#reservationRequests.set(socket, reservations);
        }
        const requestIds = reservations.get(result.reservation.id) ?? new Set<string>();
        requestIds.add(requestId);
        reservations.set(result.reservation.id, requestIds);
      }
      return result as T;
    } catch (error) {
      // Replaying a failed capacity mutation is unsafe: retain its tombstone and return the same
      // rejection instead of allocating a new reservation.
      entry.active = false;
      throw error;
    }
  }

  #invalidateReservation(socket: MessageSocket, reservationId: string | undefined): void {
    if (!reservationId) return;
    const requests = this.#placementRequests.get(socket);
    const reservations = this.#reservationRequests.get(socket);
    for (const requestId of reservations?.get(reservationId) ?? []) {
      const request = requests?.get(requestId);
      if (request) request.active = false;
    }
    reservations?.delete(reservationId);
  }
}

const MAX_PLACEMENT_REQUESTS_PER_CONNECTION = 4_096;

interface PlacementRequest {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
  active: boolean;
  reservationId?: string;
  expiresAt?: number;
}

function isPlacement(value: unknown): value is WorkletExecutionPlacement {
  return !!value && typeof value === "object" && "workerId" in value;
}

function placementFingerprint(message: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  // Match JSON transport semantics: undefined object properties are omitted, while undefined
  // array elements become null. Callers filter object properties below.
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Placement request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object")
    throw new Error("Placement request contains a non-JSON value");
  if (ancestors.has(value)) throw new Error("Placement request contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
