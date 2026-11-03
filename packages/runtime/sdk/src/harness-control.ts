import { createHash } from "node:crypto";
import type { JsonRecord } from "@supertag/core";

/** Technical native-session identity; it does not create an resource or grant access. */
export interface HarnessSessionReference {
  readonly harnessId: string;
  readonly id: string;
}
export type HarnessControlOperation = "input" | "reply" | "interrupt";
export interface HarnessControlCapabilities {
  readonly version: 1;
  readonly operations: readonly HarnessControlOperation[];
  readonly inputMode?: "queue" | "steer";
}
interface HarnessControlIdentity {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
}
/** JSON-only commands scoped to one live Attempt. This is not a durable delivery protocol. */
export type HarnessControlCommand = HarnessControlIdentity &
  (
    | {
        readonly type: "input";
        readonly text: string;
        /**
         * Information the Task may weigh rather than an instruction it must act on, such as Team
         * coordination. A harness answers uncertain acceptance with `unknown` and never fails the
         * Attempt or discards its result over it.
         */
        readonly advisory?: boolean;
        /** Refuse delivery without a fresh authority check at the native input boundary. */
        readonly requiresInputAuthorization?: boolean;
        /** Stored sender identity supplied by the Control Plane, never inferred from text. */
        readonly origin?: { readonly kind: "peer"; readonly from: string };
      }
    | { readonly type: "reply"; readonly requestId: string; readonly response: JsonRecord }
    | { readonly type: "interrupt"; readonly reason?: string }
  );
export interface HarnessControlAcknowledgement extends HarnessControlIdentity {
  /** accepted means the adapter accepted this action, not that execution completed. */
  readonly status: "accepted" | "rejected" | "unknown";
  readonly reason?: string;
}
/** Ephemeral authority; never persisted in a command or recovered for replay. */
export interface HarnessControlOptions {
  readonly authorizeInput?: () => Promise<boolean>;
}

export interface HarnessExecutionControl {
  readonly capabilities: HarnessControlCapabilities;
  readonly taskId: string;
  readonly attemptId: string;
  readonly session?: HarnessSessionReference;
  send(
    command: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement>;
  /** Revokes control; Harness.close remains responsible for process/resource cleanup. */
  close(): Promise<void>;
}
export interface LocalHarnessExecutionControlOptions {
  readonly taskId: string;
  readonly attemptId: string;
  readonly capabilities: HarnessControlCapabilities;
  readonly session?: HarnessSessionReference;
  /** Must enforce admitted permissions before accepting native permission/question replies. */
  readonly dispatch: (
    command: HarnessControlCommand,
    signal: AbortSignal,
    authorizeInput?: () => Promise<boolean>,
  ) => Promise<{ readonly status: "accepted" | "rejected" | "unknown"; readonly reason?: string }>;
  /** Dispatch calls authorizeInput immediately before native input, after any internal queue. */
  readonly authorizeInputAtTake?: boolean;
  readonly maximumCommands?: number;
  readonly commandTimeoutMs?: number;
}
const OPERATIONS = ["input", "reply", "interrupt"] as const;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export function validateHarnessControlCapabilities(value: HarnessControlCapabilities): void {
  if (
    (value?.inputMode !== undefined &&
      (!value.operations?.includes("input") || !["queue", "steer"].includes(value.inputMode))) ||
    value?.version !== 1 ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > OPERATIONS.length ||
    value.operations.some((operation) => !OPERATIONS.includes(operation)) ||
    new Set(value.operations).size !== value.operations.length
  )
    throw new Error("Invalid Harness control capabilities");
}

/**
 * Bounded, in-memory adapter convenience. IDs are idempotent for this instance only.
 * Native requests must be registered before replies; this never grants permissions.
 * An ambiguous dispatch is never retried. Advisory input uncertainty is isolated to that item;
 * other ambiguous actions close control to avoid overlapping native actions.
 */
export class LocalHarnessExecutionControl implements HarnessExecutionControl {
  readonly taskId: string;
  readonly attemptId: string;
  readonly capabilities: HarnessControlCapabilities;
  readonly session?: HarnessSessionReference;
  readonly #dispatch: LocalHarnessExecutionControlOptions["dispatch"];
  readonly #authorizeInputAtTake: boolean;
  readonly #maximumCommands: number;
  readonly #timeout: number;
  readonly #commands = new Map<
    string,
    { fingerprint: string; result: Promise<HarnessControlAcknowledgement> }
  >();
  readonly #requests = new Map<string, "pending" | "reserved" | "resolved">();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #closing = new AbortController();

  constructor(options: LocalHarnessExecutionControlOptions) {
    this.taskId = identifier(options.taskId, "taskId");
    this.attemptId = identifier(options.attemptId, "attemptId");
    validateHarnessControlCapabilities(options.capabilities);
    this.capabilities = Object.freeze({
      version: 1,
      operations: Object.freeze([...options.capabilities.operations]),
      ...(options.capabilities.inputMode ? { inputMode: options.capabilities.inputMode } : {}),
    });
    if (options.session)
      this.session = Object.freeze({
        harnessId: identifier(options.session.harnessId, "harnessId"),
        id: identifier(options.session.id, "sessionId"),
      });
    this.#maximumCommands = boundedInteger(
      options.maximumCommands ?? 1024,
      1,
      10000,
      "maximumCommands",
    );
    // Leave room for DurableWorklet's five-second receipt deadline and journal commit.
    this.#timeout = boundedInteger(options.commandTimeoutMs ?? 4000, 1, 60000, "commandTimeoutMs");
    if (typeof options.dispatch !== "function")
      throw new Error("Harness control dispatch is required");
    this.#dispatch = options.dispatch;
    this.#authorizeInputAtTake = options.authorizeInputAtTake === true;
    Object.freeze(this);
  }

  registerRequest(requestId: string): void {
    if (this.#closed) throw new Error("Harness control is closed");
    identifier(requestId, "requestId");
    const previous = this.#requests.get(requestId);
    if (previous === "pending") return;
    if (previous !== undefined) throw new Error("Harness request is already answered or in flight");
    if (this.#requests.size >= this.#maximumCommands)
      throw new Error("Harness request history is full");
    this.#requests.set(requestId, "pending");
  }

  /** Retracts a request that the native session no longer accepts. */
  unregisterRequest(requestId: string): void {
    identifier(requestId, "requestId");
    if (this.#requests.has(requestId)) this.#requests.set(requestId, "resolved");
  }

  async send(
    value: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    const command = validateHarnessControlCommand(value);
    if (command.taskId !== this.taskId || command.attemptId !== this.attemptId)
      throw new Error("Harness control Attempt scope mismatch");
    const fingerprint = createHash("sha256").update(canonical(command)).digest("hex");
    const previous = this.#commands.get(command.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Harness control command ID conflict");
      return { ...(await previous.result) };
    }
    if (this.#closed) throw new Error("Harness control is closed");
    if (this.#commands.size >= this.#maximumCommands)
      throw new Error("Harness control command history is full");
    // Queue time consumes the same budget as dispatch. Expired queued commands must never
    // reach the native session after their caller has given up waiting for a receipt.
    const deadline = Date.now() + this.#timeout;
    const result = this.#tail.then(() => this.#deliver(command, deadline, options));
    this.#commands.set(command.id, { fingerprint, result });
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return { ...(await result) };
  }

  async #deliver(
    command: HarnessControlCommand,
    deadline: number,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    const ack = (
      status: HarnessControlAcknowledgement["status"],
      reason?: string,
    ): HarnessControlAcknowledgement => ({
      id: command.id,
      taskId: this.taskId,
      attemptId: this.attemptId,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    if (this.#closed) return ack("rejected", "Harness control is closed");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return ack("rejected", "Harness control expired while queued");
    if (!this.capabilities.operations.includes(command.type))
      return ack("rejected", "Harness control operation is unsupported");
    if (
      command.type === "input" &&
      command.requiresInputAuthorization &&
      (!this.#authorizeInputAtTake || !options?.authorizeInput)
    )
      return ack("rejected", "Input authority cannot be checked at take");
    if (command.type === "reply") {
      if (this.#requests.get(command.requestId) !== "pending")
        return ack("rejected", "Harness request is unknown, resolved, or already in flight");
      this.#requests.set(command.requestId, "reserved");
    }
    const controller = new AbortController();
    // Whether the take-time authority check allowed this input. Until it does, aborting the
    // controller guarantees the native session never takes the input, so a timeout or close is
    // a definite rejection rather than an uncertain answer.
    let authorized = false;
    const guarded = command.type === "input" && command.requiresInputAuthorization === true;
    const interruption = (reason: string) =>
      guarded && !authorized
        ? { status: "rejected" as const, reason: `${reason} before input authority was confirmed` }
        : { status: "unknown" as const, reason };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onClose!: () => void;
    const interrupted = new Promise<{ status: "rejected" | "unknown"; reason: string }>(
      (resolve) => {
        onClose = () => {
          controller.abort();
          resolve(interruption("Harness control closed during dispatch"));
        };
        this.#closing.signal.addEventListener("abort", onClose, { once: true });
        timeout = setTimeout(
          () => {
            controller.abort();
            resolve(interruption("Harness control acknowledgement timed out"));
          },
          // Teammate input releases the queue within a second, take-time check included.
          command.type === "input" && command.advisory
            ? Math.min(remaining, Math.max(1, this.#timeout / 4), 1000)
            : remaining,
        );
      },
    );
    let outcome: { status: "accepted" | "rejected" | "unknown"; reason?: string };
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted || Date.now() >= deadline)
            return {
              status: "rejected" as const,
              reason: "Harness control was revoked before delivery",
            };
          if (command.type === "reply" && this.#requests.get(command.requestId) !== "reserved")
            return { status: "rejected" as const, reason: "Harness request is no longer pending" };
          let checked = false;
          const authorize = options?.authorizeInput;
          return this.#dispatch(
            command,
            controller.signal,
            authorize &&
              (async () => {
                if (checked || controller.signal.aborted) return false;
                checked = true;
                let revoke!: () => void;
                const revoked = new Promise<boolean>((resolve) => {
                  revoke = () => resolve(false);
                  controller.signal.addEventListener("abort", revoke, { once: true });
                });
                try {
                  authorized =
                    (await Promise.race([authorize(), revoked])) === true &&
                    !controller.signal.aborted;
                  return authorized;
                } catch {
                  return false;
                } finally {
                  controller.signal.removeEventListener("abort", revoke);
                }
              }),
          );
        }),
        interrupted,
      ]);
      if (
        !outcome ||
        !["accepted", "rejected", "unknown"].includes(outcome.status) ||
        (outcome.reason !== undefined &&
          (typeof outcome.reason !== "string" || outcome.reason.length > 2000))
      )
        outcome = {
          status: "unknown",
          reason: "Harness control returned an invalid acknowledgement",
        };
    } catch {
      // Provider exceptions can contain credentials; expose only a bounded neutral receipt.
      outcome = {
        status: "unknown",
        reason: "Harness control dispatch failed without a confirmed acknowledgement",
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      this.#closing.signal.removeEventListener("abort", onClose);
    }
    if (command.type === "reply") {
      if (this.#requests.get(command.requestId) === "reserved")
        this.#requests.set(
          command.requestId,
          outcome.status === "rejected" ? "pending" : "resolved",
        );
    }
    if (outcome.status === "unknown") {
      // Withdraw input still queued in the adapter before releasing subsequent commands. The
      // receipt stays unknown and cached even if an already-taken input acknowledges later.
      controller.abort();
      if (command.type !== "input" || !command.advisory) await this.close();
    }
    return ack(outcome.status, outcome.reason);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closing.abort();
    this.#requests.clear();
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`Invalid Harness control ${label}`);
  return value;
}
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid Harness control ${label}`);
  return value;
}
/** Validates bounds and JSON shape, returning an immutable copy safe for dispatch. */
export function validateHarnessControlCommand(value: HarnessControlCommand): HarnessControlCommand {
  validateJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Harness control command must be a JSON object");
  identifier(value.id, "id");
  identifier(value.taskId, "taskId");
  identifier(value.attemptId, "attemptId");
  const keys = ["id", "taskId", "attemptId", "type"];
  if (value.type === "input") {
    keys.push("text", "advisory", "requiresInputAuthorization", "origin");
    if (
      value.requiresInputAuthorization !== undefined &&
      typeof value.requiresInputAuthorization !== "boolean"
    )
      throw new Error("Invalid input authorization requirement");
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 16000)
      throw new Error("Invalid Harness control input text");
    if (value.advisory !== undefined && typeof value.advisory !== "boolean")
      throw new Error("Invalid Harness control input advisory flag");
    if (value.origin !== undefined) {
      if (
        !value.advisory ||
        !value.origin ||
        value.origin.kind !== "peer" ||
        Object.keys(value.origin).some((key) => key !== "kind" && key !== "from")
      )
        throw new Error("Invalid Harness control input origin");
      identifier(value.origin.from, "origin.from");
    }
  } else if (value.type === "reply") {
    keys.push("requestId", "response");
    identifier(value.requestId, "requestId");
    if (!value.response || typeof value.response !== "object" || Array.isArray(value.response))
      throw new Error("Harness reply response must be a JSON object");
  } else if (value.type === "interrupt") {
    keys.push("reason");
    if (
      value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 2000)
    )
      throw new Error("Invalid Harness interrupt reason");
  } else throw new Error("Invalid Harness control operation");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unexpected Harness control command field");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES)
    throw new Error("Harness control command exceeds 64 KiB");
  return freezeJson(JSON.parse(encoded)) as HarnessControlCommand;
}
function validateJson(value: unknown, depth = 0, budget = { remaining: 4096 }): void {
  if (--budget.remaining < 0) throw new Error("Harness control JSON exceeds node limit");
  if (typeof value === "string" && Buffer.byteLength(value) > MAX_PAYLOAD_BYTES)
    throw new Error("Harness control JSON string exceeds 64 KiB");
  if (depth > 16) throw new Error("Harness control JSON nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, depth + 1, budget);
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    for (const [key, entry] of Object.entries(value)) {
      if (Buffer.byteLength(key) > MAX_PAYLOAD_BYTES)
        throw new Error("Harness control JSON key exceeds 64 KiB");
      validateJson(entry, depth + 1, budget);
    }
    return;
  }
  throw new Error("Harness control payload must contain only JSON values");
}
function freezeJson(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
