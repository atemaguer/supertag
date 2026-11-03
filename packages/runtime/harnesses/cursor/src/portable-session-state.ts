import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILES = ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"] as const;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES = 15 * 1024 * 1024;

export interface PortableCursorSessionState {
  readonly version: 1;
  readonly agentId: string;
  readonly files: readonly { readonly name: (typeof FILES)[number]; readonly text: string }[];
}

function validateFile(name: string, text: string): void {
  if (!(FILES as readonly string[]).includes(name) || Buffer.byteLength(text) > MAX_FILE_BYTES)
    throw new Error("Invalid Cursor Session file");
  for (const line of text.split("\n")) {
    if (line.trim()) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("Invalid Cursor Session JSONL");
      }
      if (
        name === "agents.ndjson" &&
        (record === null || typeof record !== "object" || Array.isArray(record))
      )
        throw new Error("Invalid Cursor Session agent record");
    }
  }
}

function agentRecords(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Fixed filenames and Codex-equivalent byte caps keep state portable and path-safe. */
export function validatePortableCursorSessionState(value: unknown): PortableCursorSessionState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid portable Cursor Session state");
  const state = value as Record<string, unknown>;
  if (
    state["version"] !== 1 ||
    typeof state["agentId"] !== "string" ||
    !/^agent-[\w-]{1,100}$/u.test(state["agentId"]) ||
    !Array.isArray(state["files"]) ||
    state["files"].length !== FILES.length
  )
    throw new Error("Invalid portable Cursor Session state");
  let total = 0;
  const seen = new Set<string>();
  for (const entry of state["files"]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid Cursor Session file");
    const file = entry as Record<string, unknown>;
    if (typeof file["name"] !== "string" || typeof file["text"] !== "string")
      throw new Error("Invalid Cursor Session file");
    validateFile(file["name"], file["text"]);
    if (seen.has(file["name"])) throw new Error("Duplicate Cursor Session file");
    seen.add(file["name"]);
    total += Buffer.byteLength(file["text"]);
  }
  if (total > MAX_TOTAL_BYTES || Buffer.byteLength(JSON.stringify(state)) > MAX_ENCODED_BYTES)
    throw new Error("Cursor Session state exceeds size limit");
  const agents = (state["files"] as { name: string; text: string }[]).find(
    (file) => file.name === "agents.ndjson",
  );
  if (
    !agentRecords(agents?.text ?? "").some(
      (record) => record !== null && record["agentId"] === state["agentId"],
    )
  )
    throw new Error("Cursor Session state does not contain its agent");
  return structuredClone(value) as PortableCursorSessionState;
}

export async function capturePortableCursorSessionState(
  directory: string,
  agentId: string,
  sensitiveValues: readonly string[],
): Promise<PortableCursorSessionState> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Cursor Session store");
  const files = [];
  for (const name of FILES) {
    const path = join(directory, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > MAX_FILE_BYTES)
        throw new Error("Unsafe Cursor Session file");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (sensitiveValues.some((value) => value && text.includes(value)))
      throw new Error("Cursor Session contains sensitive data");
    files.push({ name, text });
  }
  return validatePortableCursorSessionState({ version: 1, agentId, files });
}

/**
 * Restores the store for a later Attempt and points its agent at that Attempt's workspace.
 * @cursor/sdk 1.0.37 scopes local agent lookups to `local.cwd`: Agent.resume reports
 * AgentNotFoundError when the stored LocalAgentDocument.cwd differs, and each Attempt can
 * run in a new workspace path. https://cursor.com/docs/sdk/typescript.md#resuming-agents
 */
export async function restorePortableCursorSessionState(
  state: PortableCursorSessionState,
  directory: string,
  workspace: string,
): Promise<void> {
  const portable = validatePortableCursorSessionState(state);
  if (!workspace) throw new Error("Cursor Session restore needs a workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Cursor Session store");
  for (const file of portable.files) {
    const text =
      file.name === "agents.ndjson"
        ? agentRecords(file.text)
            .map((record) =>
              JSON.stringify(
                record["agentId"] === portable.agentId ? { ...record, cwd: workspace } : record,
              ),
            )
            .map((line) => `${line}\n`)
            .join("")
        : file.text;
    await writeFile(join(directory, file.name), text, { flag: "wx", mode: 0o600 });
  }
}
