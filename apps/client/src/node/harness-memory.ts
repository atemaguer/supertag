/**
 * A Tag's memory, which its harness keeps, read with the app's own CLI: `supertag get memories` asks
 * the memory endpoint of each Worker Host `supertag up` runs from the local state directory, so
 * the memory never passes through the Control Plane and none of that is ported here. Only the
 * local Gateway's connection has a state directory to ask.
 */
import type { HarnessMemory, HarnessMemoryList } from "../model/gateway";

/** What a client says when it reaches a shared Gateway, which can't read a Tag's memory. */
export const SHARED_GATEWAY_HARNESS_MEMORY =
  "A Tag's memory is read only on the machine whose Worker Host keeps it, and this connection reaches a shared Gateway.";

const UNREADABLE = "This version of the supertag CLI can't list a Tag's memory. Update it.";

/** `supertag ARGS` for one Tag's memory in the local services' `state`. */
export function listHarnessMemoryArgs(state: string, tagId: string): string[] {
  return ["get", "memories", "--tag", tagId, "--state-directory", state];
}

/** `supertag ARGS` to delete one memory, or a proposed change, in the local services' `state`. */
export function deleteHarnessMemoryArgs(state: string, memoryId: string): string[] {
  return ["delete", "memory", memoryId, "--state-directory", state];
}

function text(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw UNREADABLE;
  return value as Record<string, unknown>;
}

/** One memory as the CLI prints it. */
export function harnessMemory(value: unknown): HarnessMemory {
  const memory = record(value);
  const memoryId = text(memory, "memory_id");
  const tagId = text(memory, "tag_id");
  const memoryText = text(memory, "text");
  if (memoryId === undefined || tagId === undefined || memoryText === undefined) throw UNREADABLE;
  const source = record(memory["source"] ?? {});
  const updated = Date.parse(text(memory, "updated_at") ?? "");
  const trust = text(memory, "trust");
  const parsed: HarnessMemory = {
    memoryId,
    tagId,
    harness: text(memory, "harness") ?? "",
    private: memory["shared"] === false,
    kind: text(memory, "kind") ?? "fact",
    title: text(memory, "title") ?? "",
    text: memoryText,
    truncated: memory["truncated"] === true,
    status: text(memory, "status") === "proposed" ? "proposed" : "owned",
    path: text(source, "path") ?? "",
    updatedAtMs: Number.isNaN(updated) ? 0 : updated,
  };
  const hook = text(memory, "hook");
  if (hook) parsed.hook = hook;
  if (trust === "trusted" || trust === "proposed-only") parsed.trust = trust;
  const hostId = text(source, "host_id");
  if (hostId) parsed.hostId = hostId;
  return parsed;
}

/** The CLI's `get memories` output. */
export function parseHarnessMemoryList(output: string): HarnessMemoryList {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw UNREADABLE;
  }
  const listed = record(value);
  const memories = listed["memories"];
  if (!Array.isArray(memories)) throw UNREADABLE;
  const keptOn = listed["kept_on"];
  const list: HarnessMemoryList = {
    memories: memories.map(harnessMemory),
    keptOn: Array.isArray(keptOn)
      ? keptOn.filter((host): host is string => typeof host === "string")
      : [],
  };
  const unavailable = text(listed, "unavailable");
  if (unavailable) list.unavailable = unavailable;
  return list;
}

/** The CLI's `delete memory` output for one memory. */
export function parseHarnessMemory(output: string): HarnessMemory {
  try {
    return harnessMemory(JSON.parse(output));
  } catch (error) {
    throw typeof error === "string" ? error : UNREADABLE;
  }
}
