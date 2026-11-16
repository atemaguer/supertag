import { useSyncExternalStore } from "react";
import type { ControlPlane, Message } from "../control-plane";
import { stored, storedValue } from "./conversation-cache";
import { describe } from "./polling";

/**
 * Messages sent here that the Control Plane has not yet accepted. Each shows in its conversation
 * at once, and stays, also on disk, until the Control Plane accepts it. A retry, including one
 * after a restart, reuses its operation ID, so the Control Plane accepts it at most once.
 */
export interface Outgoing {
  tagId: string;
  text: string;
  operationId: string;
  createdAtMs: number;
  /** Why the last attempt failed. */
  error?: string;
  /** An attempt is in flight. */
  sending?: boolean;
}

const queues = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();
const loaded = new Set<string>();
const noEntries: Outgoing[] = [];

function entries(controlPlane: ControlPlane) {
  return queues.get(controlPlane.scope) ?? noEntries;
}

function update(controlPlane: ControlPlane, next: Outgoing[]) {
  queues.set(controlPlane.scope, next);
  for (const listener of listeners) listener();
  const persisted = next.map(({ sending: _, ...entry }) => entry);
  void controlPlane.writeCache("outbox", stored(persisted)).catch(() => {});
}

function change(controlPlane: ControlPlane, operationId: string, patch: Partial<Outgoing>) {
  update(
    controlPlane,
    entries(controlPlane).map((entry) =>
      entry.operationId === operationId ? { ...entry, ...patch } : entry,
    ),
  );
}

export function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Queues a message and sends it. Resolves to the Control Plane's receipt, or to nothing when it
 * failed; the message then stays queued with its error, for `retry`.
 */
export function send(
  controlPlane: ControlPlane,
  tagId: string,
  text: string,
): Promise<Message | undefined> {
  const entry: Outgoing = {
    tagId,
    text,
    operationId: newOperationId(),
    createdAtMs: Date.now(),
  };
  update(controlPlane, [...entries(controlPlane), entry]);
  return deliver(controlPlane, entry.operationId);
}

/** Sends a queued message again, with its operation ID. */
export function retry(controlPlane: ControlPlane, operationId: string) {
  return deliver(controlPlane, operationId);
}

/** Removes a message that was never accepted. */
export function discard(controlPlane: ControlPlane, operationId: string) {
  update(
    controlPlane,
    entries(controlPlane).filter((entry) => entry.operationId !== operationId),
  );
}

async function deliver(
  controlPlane: ControlPlane,
  operationId: string,
): Promise<Message | undefined> {
  const entry = entries(controlPlane).find((queued) => queued.operationId === operationId);
  if (!entry || entry.sending) return undefined;
  change(controlPlane, operationId, { sending: true, error: undefined });
  try {
    const message = await controlPlane.send(entry.tagId, entry.text, operationId);
    discard(controlPlane, operationId);
    return message;
  } catch (error) {
    change(controlPlane, operationId, { sending: false, error: describe(error) });
    return undefined;
  }
}

/**
 * Restores the messages a previous run left unsent on this connection's Control Plane and sends
 * them again, once per connection scope.
 */
export async function resumeOutbox(controlPlane: ControlPlane) {
  if (loaded.has(controlPlane.scope)) return;
  loaded.add(controlPlane.scope);
  let restored: Outgoing[] = [];
  try {
    restored = parseOutbox(storedValue(await controlPlane.readCache("outbox")));
  } catch {
    // Nothing to restore.
  }
  const known = new Set(entries(controlPlane).map(({ operationId }) => operationId));
  const added = restored.filter(({ operationId }) => !known.has(operationId));
  if (!added.length) return;
  update(controlPlane, [...added, ...entries(controlPlane)]);
  for (const entry of added) await deliver(controlPlane, entry.operationId);
}

/** The Tag's queued messages, oldest first. */
export function useOutbox(controlPlane: ControlPlane, tagId: string): Outgoing[] {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries(controlPlane),
  );
  return all.filter((entry) => entry.tagId === tagId);
}

function parseOutbox(value: unknown): Outgoing[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Outgoing =>
      entry &&
      typeof entry.tagId === "string" &&
      typeof entry.text === "string" &&
      typeof entry.operationId === "string" &&
      typeof entry.createdAtMs === "number",
  );
}

/** Forgets every queued message in memory. For tests. */
export function clearOutbox() {
  queues.clear();
  loaded.clear();
}
