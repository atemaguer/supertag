import type { EnvironmentPlan, ExecutionEnvironment } from "@supertag/worker-sdk";

const MAX_FILES = 16;
// Long Codex Attempts routinely write rollouts beyond 2 MiB. Bound each transcript like the
// Claude Code harness does and keep the encoded archive inside the 16 MiB Session state store.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES = 15 * 1024 * 1024;

export interface PortableCodexSessionState {
  readonly version: 1;
  readonly threadId: string;
  readonly workspace: string;
  readonly transcripts: readonly { readonly path: string; readonly text: string }[];
}

/** Fixed, path-free reasons the enumeration script may report. */
const LISTING_REASONS = [
  "unsafe Codex home",
  "session depth exceeded",
  "unsafe session directory",
  "session scan limit exceeded",
  "session symlink",
  "invalid session file",
  "session file exceeds size limit",
  "session size limit exceeded",
  "session file limit exceeded",
] as const;

// Only the attempt-owned sessions tree is inspected. Never enumerate CODEX_HOME itself.
// Failures print one fixed reason (never a path) so operators can see why archiving failed.
const LIST_SESSIONS = `
const fs=require('node:fs'),path=require('node:path');
const [root,maxFiles,maxFile,maxTotal]=[process.argv[1],...process.argv.slice(2).map(Number)];
const files=[];let entries=0,total=0;
function fail(reason){const e=Error(reason);e.reason=reason;throw e;}
function walk(dir,depth){if(depth>5)fail('session depth exceeded');
const stat=fs.lstatSync(dir);if(stat.isSymbolicLink()||!stat.isDirectory())fail('unsafe session directory');
for(const name of fs.readdirSync(dir)){if(++entries>1024)fail('session scan limit exceeded');
const full=path.join(dir,name),s=fs.lstatSync(full);if(s.isSymbolicLink())fail('session symlink');
if(s.isDirectory())walk(full,depth+1);else if(name.endsWith('.jsonl')){
if(!s.isFile())fail('invalid session file');if(s.size>maxFile)fail('session file exceeds size limit');
total+=s.size;if(total>maxTotal)fail('session size limit exceeded');
if(files.length>=maxFiles)fail('session file limit exceeded');
files.push(path.relative(root,full).split(path.sep).join('/'));}}}
try{const home=path.dirname(root);if(fs.existsSync(home)){const s=fs.lstatSync(home);if(s.isSymbolicLink()||!s.isDirectory())fail('unsafe Codex home');}
if(fs.existsSync(root))walk(root,0);process.stdout.write(JSON.stringify(files));}
catch(error){process.stderr.write(JSON.stringify({reason:error.reason??('unreadable session tree'+(typeof error.code==='string'&&/^E[A-Z]+$/.test(error.code)?' ('+error.code+')':''))}));process.exit(2);}`;

function listingFailure(stderr: string): string {
  try {
    const reason: unknown = JSON.parse(stderr)?.reason;
    if (
      typeof reason === "string" &&
      ((LISTING_REASONS as readonly string[]).includes(reason) ||
        /^unreadable session tree(?: \(E[A-Z]+\))?$/u.test(reason))
    )
      return reason;
  } catch {
    // Unstructured output can contain paths; never surface it.
  }
  return "listing failed";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function validPath(path: string): boolean {
  return (
    path.length <= 300 &&
    /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.jsonl$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}
function metadata(text: string): { id: string; parent?: string } {
  const lines = text.trimEnd().split("\n");
  if (lines.length === 0) throw new Error("Empty Codex transcript");
  // Validate every JSONL record, not only the header, before promising resumability.
  const records = lines.map((line) => record(JSON.parse(line)));
  const first = records[0];
  const payload = record(first?.["payload"]);
  const id = payload?.["id"];
  if (
    first?.["type"] !== "session_meta" ||
    typeof id !== "string" ||
    !id ||
    id.length > 200 ||
    records.some((item) => item === undefined)
  )
    throw new Error("Invalid Codex transcript");
  const spawn = record(record(record(payload?.["source"])?.["subagent"])?.["thread_spawn"]);
  const parent = spawn?.["parent_thread_id"];
  if (parent !== undefined && (typeof parent !== "string" || !parent))
    throw new Error("Invalid Codex lineage");
  return { id, ...(typeof parent === "string" ? { parent } : {}) };
}

export function validatePortableCodexSessionState(value: unknown): PortableCodexSessionState {
  const item = record(value);
  if (
    item?.["version"] !== 1 ||
    typeof item["threadId"] !== "string" ||
    !item["threadId"] ||
    typeof item["workspace"] !== "string" ||
    !item["workspace"] ||
    !Array.isArray(item["transcripts"]) ||
    item["transcripts"].length === 0 ||
    item["transcripts"].length > MAX_FILES
  )
    throw new Error("Invalid portable Codex Session state");
  let total = 0;
  const paths = new Set<string>();
  const ids = new Map<string, string | undefined>();
  for (const entry of item["transcripts"]) {
    const file = record(entry);
    if (
      typeof file?.["path"] !== "string" ||
      !validPath(file["path"]) ||
      typeof file["text"] !== "string" ||
      paths.has(file["path"])
    )
      throw new Error("Invalid Session transcript path");
    paths.add(file["path"]);
    const size = Buffer.byteLength(file["text"]);
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_BYTES)
      throw new Error("Codex Session state exceeds size limit");
    const meta = metadata(file["text"]);
    if (ids.has(meta.id)) throw new Error("Duplicate Codex thread");
    ids.set(meta.id, meta.parent);
  }
  if (Buffer.byteLength(JSON.stringify(item["transcripts"])) > MAX_ENCODED_BYTES)
    throw new Error("Codex Session state exceeds size limit");
  const selected = new Set([item["threadId"]]);
  if (!ids.has(item["threadId"])) throw new Error("Missing root Codex transcript");
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, parent] of ids)
      if (parent && selected.has(parent) && !selected.has(id)) {
        selected.add(id);
        changed = true;
      }
  }
  if (selected.size !== ids.size) throw new Error("Unrelated Codex transcript");
  return JSON.parse(JSON.stringify(value)) as PortableCodexSessionState;
}

export async function capturePortableCodexSessionState(
  environment: ExecutionEnvironment,
  threadId: string,
  workspace: string,
): Promise<PortableCodexSessionState | undefined> {
  if (!environment.readBytes) throw new Error("Portable Codex Session state requires binary reads");
  const process = await environment.spawn({
    command: "node",
    args: [
      "-e",
      LIST_SESSIONS,
      environment.resolvePath(".codex/sessions"),
      String(MAX_FILES),
      String(MAX_FILE_BYTES),
      String(MAX_BYTES),
    ],
    timeoutMs: 10000,
  });
  const result = await process.wait();
  if (result.exitCode !== 0)
    throw new Error(
      `Could not enumerate Codex Session transcripts: ${listingFailure(result.stderr)}`,
    );
  const paths: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(paths) || paths.length > MAX_FILES)
    throw new Error("Invalid Codex session listing");
  const candidates: { path: string; text: string; id: string; parent?: string }[] = [];
  let total = 0;
  for (const path of paths) {
    if (typeof path !== "string" || !validPath(path)) throw new Error("Unsafe Codex session path");
    const bytes = await environment.readBytes(`.codex/sessions/${path}`);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE_BYTES || total > MAX_BYTES)
      throw new Error("Codex Session state exceeds size limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    candidates.push({ path, text, ...metadata(text) });
  }
  if (!candidates.some((file) => file.id === threadId)) return undefined;
  const selected = new Set([threadId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of candidates)
      if (file.parent && selected.has(file.parent) && !selected.has(file.id)) {
        selected.add(file.id);
        changed = true;
      }
  }
  return validatePortableCodexSessionState({
    version: 1,
    threadId,
    workspace,
    transcripts: candidates
      .filter((file) => selected.has(file.id))
      .map(({ path, text }) => ({ path, text })),
  });
}

export async function restorePortableCodexSessionState(
  value: PortableCodexSessionState,
  environment: ExecutionEnvironment,
  workspace: string,
  network: EnvironmentPlan["network"],
): Promise<void> {
  const sessionState = validatePortableCodexSessionState(value);
  if (!workspace) throw new Error("Missing restored workspace");
  const files = sessionState.transcripts.map((file) => ({
    path: `.codex/sessions/${file.path}`,
    mode: 0o600,
    content: `${file.text
      .trimEnd()
      .split("\n")
      .map((line) => {
        const event = JSON.parse(line);
        // Do not rewrite user/tool text: only native execution context metadata.
        if (
          (event.type === "session_meta" || event.type === "turn_context") &&
          event.payload?.cwd === sessionState.workspace
        )
          event.payload.cwd = workspace;
        return JSON.stringify(event);
      })
      .join("\n")}\n`,
  }));
  await environment.prepare({
    files,
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network,
  });
}
