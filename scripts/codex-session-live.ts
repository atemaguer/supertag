/** Opt-in real CLI subscription probe. Run initial and resume in separate processes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  FileSessionStateStore,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  type SessionStateRef,
  type TaskAttemptEvent,
} from "../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "../tests/support/file-artifact-store.js";
import { repositoryAttempt } from "../tests/support/repository-execution.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    phase: { type: "string" },
    interrupt: { type: "boolean" },
    compact: { type: "boolean" },
    mode: { type: "string" },
    output: { type: "string" },
    "base-url": { type: "string" },
    "environment-id": { type: "string" },
    "resume-ref": { type: "string" },
  },
});
assert(values.live, "Pass --live to authorize real subscription execution");
assert(values.phase === "initial" || values.phase === "resume");
assert(values.mode === "exec" || values.mode === "app-server");
assert(values.output);
// Never accidentally fall back to metered API keys.
delete process.env["OPENAI_API_KEY"];
delete process.env["CODEX_API_KEY"];
const authFile = join(homedir(), ".codex", "auth.json");
const authentication = JSON.parse(await readFile(authFile, "utf8")) as {
  auth_mode?: string;
  OPENAI_API_KEY?: unknown;
  tokens?: unknown;
};
assert(
  !authentication.OPENAI_API_KEY &&
    (authentication.auth_mode === "chatgpt" || authentication.tokens),
  "Live probe requires a subscription sign-in, not API-key authentication",
);
const phase = values.phase,
  mode = values.mode;
const directory = resolve(values.output),
  runtime = join(directory, `runtime-${phase}`),
  source = join(directory, "source");
await mkdir(source, { recursive: true });
await mkdir(runtime, { recursive: true });
const stateStore = new FileSessionStateStore(join(directory, "states"));
const artifacts = new FileArtifactStore(join(directory, "artifacts"));
let ref: SessionStateRef | undefined;
let expected: string;
if (phase === "initial") {
  expected = randomUUID();
  await writeFile(join(directory, "expected.txt"), expected, { mode: 0o600 });
  await writeFile(join(source, "seed.txt"), "Clean initial workspace.\n");
} else {
  expected = await readFile(join(directory, "expected.txt"), "utf8");
  ref = JSON.parse(
    await readFile(join(directory, values["resume-ref"] ?? "initial-ref.json"), "utf8"),
  );
  assert.deepEqual(
    await remainingRuntimeFiles(join(directory, "runtime-initial")),
    [],
    "Original runtime/native files must already be destroyed",
  );
}
const shared = values["base-url"];
const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (shared) assert(adminToken, "Shared execution requires admin token environment variable");
const provider = shared
  ? new SharedExecutionEnvironmentProvider({
      baseUrl: shared,
      adminToken: adminToken ?? "",
      environmentId: values["environment-id"] ?? "session-live",
      guarantees: {
        filesystemIsolation: "sandbox",
        networkPolicy: "none",
        processTreeTermination: true,
        scopedHttp: false,
      },
    })
  : new LocalExecutionEnvironmentProvider({ temporaryDirectory: runtime });
let command: string | undefined;
if (values.compact) {
  assert.equal(mode, "app-server", "Compaction probe requires app-server");
  assert.equal(process.platform, "darwin", "Probe wrapper currently supports macOS");
  assert.equal(process.arch, "arm64", "Probe wrapper currently supports arm64");
  const sdkRequire = createRequire(
    await realpath(
      new URL(
        "../packages/runtime/harnesses/codex/node_modules/@openai/codex-sdk/package.json",
        import.meta.url,
      ),
    ),
  );
  const manifest = sdkRequire.resolve("@openai/codex/package.json");
  const platform = createRequire(manifest).resolve("@openai/codex-darwin-arm64/package.json");
  const binary = join(dirname(platform), "vendor/aarch64-apple-darwin/bin/codex");
  command = join(directory, "codex-compact");
  const wrapper = `#!${process.execPath}
const {spawn}=require('node:child_process'), fs=require('node:fs'), readline=require('node:readline');
const native=spawn(${JSON.stringify(binary)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});
const write=value=>native.stdin.write(JSON.stringify(value)+'\\n');
let waiting, compacting=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='turn/start' && !waiting){waiting=message;compacting=true;write({id:'probe-compact',method:'thread/compact/start',params:{threadId:message.params.threadId}});}
 else write(message);
});
readline.createInterface({input:native.stdout}).on('line',line=>{
 const message=JSON.parse(line);
 if(compacting){
  fs.appendFileSync(${JSON.stringify(join(directory, "compact-notifications.jsonl"))},line+'\\n',{mode:0o600});
  if(message.id==='probe-compact' && message.error){process.stdout.write(JSON.stringify({id:waiting.id,error:message.error})+'\\n');return;}
  if(message.method==='turn/completed'){compacting=false;write(waiting);}
  return;
 }
 process.stdout.write(line+'\\n');
});
process.stdin.on('end',()=>native.stdin.end());
process.on('SIGTERM',()=>native.kill());
native.on('exit',code=>process.exit(code ?? 1));
`;
  await writeFile(command, wrapper, { mode: 0o700 });
}
const worker = createCodexWorker({
  ...(command ? { command } : {}),
  workspace: source,
  executionMode: mode,
  model: "gpt-5.6-luna",
  maxNativeAgents: 0,
  timeoutMs: 150_000,
  executionEnvironment: provider,
  ...(shared
    ? {
        harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: runtime }),
        sandboxMode: "external" as const,
      }
    : {}),
  authFile,
  artifactStore: artifacts,
  sessionStateStore: stateStore,
  profileId: "session-live",
  outputs: [
    { path: "result.json", name: "result.json" },
    { path: "actions.txt", name: "actions.txt" },
  ],
});
const base = repositoryAttempt(`codex-${mode}-${phase}-${randomUUID()}`);
const prompt = values.interrupt
  ? `Remember this fact ${expected}. Say STARTING, then run a shell command that sleeps for 90 seconds before writing result.json. This is an intentional cancellation test; do not finish early or spawn helpers.`
  : phase === "initial"
    ? `This is a bounded session persistence test. Remember the exact private fact ${expected}. Use one shell command to create result.json with {"fact":"${expected}","phase":"initial"} and append exactly one line INITIAL_ACTION to actions.txt. Do not store the fact anywhere else, do not inspect configuration or credentials, do not spawn helpers. Then answer briefly.`
    : 'Continue our previous conversation in this fresh workspace. Use the exact private fact I told you earlier; it is intentionally not repeated. Use one shell command to create result.json with that fact and phase="resume", and append exactly one line RESUME_ACTION to actions.txt. Do not repeat the previous INITIAL_ACTION. Do not search files or inspect configuration or credentials, do not spawn helpers. Then answer briefly.';
const spec = {
  ...base,
  ...(shared
    ? {
        authorization: {
          ...base.authorization,
          runtimeActions: [...(base.authorization.runtimeActions ?? []), "web:search"],
        },
      }
    : {}),
  workerProfile: { id: "session-live", revision: "1" },
  session: { id: "codex-session-live", ...(ref ? { sessionState: ref } : {}) },
  input: { ...base.input, messages: [{ id: phase, role: "requester" as const, text: prompt }] },
};
assert(!spec.session || !("history" in spec.session), "No conversation replay history");
const events: TaskAttemptEvent[] = [];
const abort = new AbortController();
const cancellation = values.interrupt
  ? setTimeout(() => abort.abort(new Error("Live persistence interruption probe")), 20_000)
  : undefined;
try {
  for await (const event of worker.execute(spec, abort.signal)) {
    events.push(event);
    if (event.type === "execution.failed") console.error(JSON.stringify(event));
  }
} finally {
  clearTimeout(cancellation);
  await writeFile(join(directory, `${phase}-events.json`), JSON.stringify(events, null, 2), {
    mode: 0o600,
  });
}
if (values.interrupt) {
  assert.notEqual(events.at(-1)?.type, "execution.completed");
  assert(
    !events.some((event) => event.type === "session.updated"),
    "Interrupted archive must not become a resume candidate",
  );
  const files = await readdir(join(directory, "states"));
  assert(files.length > 0, "Interrupted native state must remain archived");
  const archives = await Promise.all(
    files.map((file) => readFile(join(directory, "states", file), "utf8")),
  );
  assert(
    archives.some((archive) => archive.includes(expected)),
    "Archive must preserve admitted fact",
  );
  assert.deepEqual(await remainingRuntimeFiles(runtime), []);
  const report = {
    mode,
    interrupted: true,
    terminal: events.at(-1)?.type,
    archivedFact: true,
    resumeCandidate: false,
    runtimeDestroyed: true,
    archiveFiles: files.length,
  };
  await writeFile(join(directory, "interrupt-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(0);
}
assert.equal(events.at(-1)?.type, "execution.completed", JSON.stringify(events.at(-1)));
for (const event of events)
  if (event.type === "artifact.created")
    await writeFile(
      join(directory, `${phase}-${event.artifact.name}`),
      await artifacts.get(event.artifact),
    );
const result = JSON.parse(await readFile(join(directory, `${phase}-result.json`), "utf8"));
assert.equal(result.fact, expected);
assert.equal(result.phase, phase);
assert.equal(
  (await readFile(join(directory, `${phase}-actions.txt`), "utf8")).trim(),
  phase === "initial" ? "INITIAL_ACTION" : "RESUME_ACTION",
);
const updated = events.findLast((e) => e.type === "session.updated");
assert(updated?.type === "session.updated");
const saved = await stateStore.load(updated.sessionState);
assert(saved?.data["threadId"]);
if (ref) assert.equal(saved.data["threadId"], (await stateStore.load(ref))?.data["threadId"]);
await writeFile(join(directory, `${phase}-ref.json`), JSON.stringify(updated.sessionState));
assert.deepEqual(
  await remainingRuntimeFiles(runtime),
  [],
  "Runtime and native Codex files must be removed after completion",
);
await assert.rejects(
  access(join(source, "result.json")),
  "Source workspace must not contain the fact",
);
const portable = saved.data["portable"] as { transcripts?: { text: string }[] } | undefined;
const compactionRecords = (portable?.transcripts ?? [])
  .flatMap((transcript) =>
    transcript.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: { type?: string } }),
  )
  .filter(
    (record) => record.type === "compacted" || record.payload?.type === "context_compacted",
  ).length;
const compacted = compactionRecords > 0;
if (values.compact) assert(compacted, "Real native transcript must contain a compaction record");
const report = {
  compacted,
  compactionRecords,
  phase,
  mode,
  shared: Boolean(shared),
  pid: process.pid,
  threadId: saved.data["threadId"],
  nativeStateBytes: JSON.stringify(saved.data).length,
  sourceRuntimeDestroyed: true,
  historyReplay: false,
  factVerified: true,
  actionExactlyOnce: true,
  manifest: events.find((e) => e.type === "runtime-inputs.resolved"),
  usage: events.findLast((e) => e.type === "usage.updated"),
};
await writeFile(join(directory, `${phase}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

async function remainingRuntimeFiles(directory: string) {
  const entries = await readdir(directory);
  const retained = [];
  for (const entry of entries) {
    if (
      entry.startsWith(".supertag-attempt-owners-") &&
      (await readdir(join(directory, entry))).length === 0
    )
      continue;
    retained.push(entry);
  }
  return retained;
}
