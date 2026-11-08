import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown, label = "value"): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

export function array(value: unknown, label = "value"): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function text(value: unknown, label = "value"): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function integer(value: unknown, label = "value"): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${label} must be an integer`);
  return value;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readCredential(path: string): Promise<string> {
  const raw = (await readFile(path, "utf8")).trim();
  if (!raw) throw new Error(`Credential file is empty: ${path}`);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const token = (parsed as JsonRecord)["token"];
      if (typeof token === "string" && token.length > 0) return token;
    }
  } catch {
    // A plain token file is the preferred operator format.
  }
  return raw;
}

export function taskAttempt(task: JsonRecord): {
  id: string;
  number: number;
  phase: string;
  workerHostId: string;
  workerId: string;
  profile: { id: string; revision: string };
} {
  const status = record(task["status"], "Task status");
  const attempt = record(status["attempt"], "Task attempt");
  const profile = record(attempt["workerProfile"], "Worker profile");
  return {
    id: text(attempt["id"], "attempt id"),
    number: integer(attempt["number"], "attempt number"),
    phase: text(attempt["phase"], "attempt phase"),
    workerHostId: text(attempt["workerHostId"], "attempt Worker Host"),
    workerId: text(attempt["workerId"], "attempt Worker"),
    profile: {
      id: text(profile["id"], "profile id"),
      revision: text(profile["revision"], "profile revision"),
    },
  };
}

export function hasExactLine(value: string, expected: string): boolean {
  return value.split(/\r?\n/u).some((line) => line.trim() === expected);
}

export function isToolCallStarted(event: JsonRecord): boolean {
  return event["type"] === "tool.call.started" || event["type"] === "execution.tool.call.started";
}

export function nativeSessionEvidence(statesBody: JsonRecord): {
  count: number;
  nativeIds: string[];
  stateIds: string[];
} {
  const states = array(statesBody["states"], "Session states").map((state) =>
    record(state, "Session state"),
  );
  return {
    count: states.length,
    nativeIds: [...new Set(states.map((state) => text(state["nativeId"], "native id")))],
    stateIds: states.map((state) => text(state["id"], "session state id")),
  };
}

export function assertNoSecrets(value: unknown, secrets: readonly string[], label: string): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets)
    if (secret && serialized.includes(secret)) throw new Error(`${label} contains protected input`);
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
