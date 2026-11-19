import { useSyncExternalStore } from "react";
import { describe } from "../model/errors";
import type { Gateway, Message } from "../model/gateway";
import { stored, storedValue } from "./conversation-cache";

/**
 * Messages sent here that the Gateway has not yet accepted. Each shows in its conversation
 * at once, and stays, also on disk, until the Gateway accepts it. A retry, including one
 * after a restart, reuses its operation ID, so the Gateway accepts it at most once.
 */
export interface Outgoing {
  tagId: string;
  text: string;
  operationId: string;
  createdAtMs: number;
  /** Why the last attempt failed. */
  error?: string | undefined;
  /** An attempt is in flight. */
  sending?: boolean;
}

const queues = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();
const loaded = new Set<string>();
const noEntries: Outgoing[] = [];

function entries(gateway: Gateway) {
  return queues.get(gateway.scope) ?? noEntries;
}

function update(gateway: Gateway, next: Outgoing[]) {
  queues.set(gateway.scope, next);
  for (const listener of listeners) listener();
  const persisted = next.map(({ sending: _, ...entry }) => entry);
  void gateway.writeCache("outbox", stored(persisted)).catch(() => {});
}

function change(gateway: Gateway, operationId: string, patch: Partial<Outgoing>) {
  update(
    gateway,
    entries(gateway).map((entry) =>
      entry.operationId === operationId ? { ...entry, ...patch } : entry,
    ),
  );
}

export function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Queues a message and sends it. Resolves to the Gateway's receipt, or to nothing when it
 * failed; the message then stays queued with its error, for `retry`.
 */
export function send(gateway: Gateway, tagId: string, text: string): Promise<Message | undefined> {
  const entry: Outgoing = {
    tagId,
    text,
    operationId: newOperationId(),
    createdAtMs: Date.now(),
  };
  update(gateway, [...entries(gateway), entry]);
  return deliver(gateway, entry.operationId);
}

/** Sends a queued message again, with its operation ID. */
export function retry(gateway: Gateway, operationId: string) {
  return deliver(gateway, operationId);
}

/** Removes a message that was never accepted. */
export function discard(gateway: Gateway, operationId: string) {
  update(
    gateway,
    entries(gateway).filter((entry) => entry.operationId !== operationId),
  );
}

async function deliver(gateway: Gateway, operationId: string): Promise<Message | undefined> {
  const entry = entries(gateway).find((queued) => queued.operationId === operationId);
  if (!entry || entry.sending) return undefined;
  change(gateway, operationId, { sending: true, error: undefined });
  try {
    const message = await gateway.send(entry.tagId, entry.text, operationId);
    discard(gateway, operationId);
    return message;
  } catch (error) {
    change(gateway, operationId, { sending: false, error: describe(error) });
    return undefined;
  }
}

/**
 * Restores the messages a previous run left unsent on this connection's Gateway and sends
 * them again, once per connection scope.
 */
export async function resumeOutbox(gateway: Gateway) {
  if (loaded.has(gateway.scope)) return;
  loaded.add(gateway.scope);
  let restored: Outgoing[] = [];
  try {
    restored = parseOutbox(storedValue(await gateway.readCache("outbox")));
  } catch {
    // Nothing to restore.
  }
  const known = new Set(entries(gateway).map(({ operationId }) => operationId));
  const added = restored.filter(({ operationId }) => !known.has(operationId));
  if (!added.length) return;
  update(gateway, [...added, ...entries(gateway)]);
  for (const entry of added) await deliver(gateway, entry.operationId);
}

/** The Tag's queued messages, oldest first. */
export function useOutbox(gateway: Gateway, tagId: string): Outgoing[] {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries(gateway),
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
