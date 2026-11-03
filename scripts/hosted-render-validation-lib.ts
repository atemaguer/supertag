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

export function artifactSelection(task: JsonRecord): {
  artifactId: string;
  paths: string[];
} {
  const status = record(task["status"], "Task status");
  const outcome = record(status["outcome"], "Task outcome");
  const taskResult = record(outcome["taskResult"], "Task result");
  const first = record(array(taskResult["artifacts"], "Task artifacts")[0], "Task artifact");
  return {
    artifactId: text(first["artifactId"], "artifactId"),
    paths: array(first["paths"], "artifact paths").map((item) => text(item, "artifact path")),
  };
}

export function assertExactArtifactAdmission(
  value: unknown,
  expected: { artifactId: string; path: string; digest: string; sizeBytes: number },
): JsonRecord {
  const admitted = array(value, "admitted input artifacts");
  if (admitted.length !== 1)
    throw new Error(`Expected one admitted input artifact, received ${admitted.length}`);
  const entry = record(admitted[0], "admitted input artifact");
  for (const field of ["artifactId", "path", "digest"] as const)
    if (entry[field] !== expected[field])
      throw new Error(`Admitted input artifact ${field} does not match the selected artifact`);
  if (entry["sizeBytes"] !== expected.sizeBytes)
    throw new Error("Admitted input artifact sizeBytes does not match the selected artifact");
  return entry;
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

export function outputText(task: JsonRecord): string {
  const status = record(task["status"], "Task status");
  const outcome = record(status["outcome"], "Task outcome");
  for (const candidate of [outcome["text"], outcome["output"], outcome["message"]])
    if (typeof candidate === "string") return candidate;
  const taskResult = outcome["taskResult"];
  if (typeof taskResult === "object" && taskResult !== null && !Array.isArray(taskResult)) {
    const nested = taskResult as JsonRecord;
    for (const candidate of [nested["text"], nested["output"], nested["message"]])
      if (typeof candidate === "string") return candidate;
  }
  return JSON.stringify(outcome);
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
