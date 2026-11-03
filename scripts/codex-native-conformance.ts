import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { ModalExecutionEnvironmentProvider } from "../packages/runtime/environments/modal/src/index.js";
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
    backend: { type: "string" },
    output: { type: "string" },
    "image-id": { type: "string" },
    "auth-file": { type: "string" },
    resume: { type: "boolean" },
    split: { type: "boolean" },
    "base-url": { type: "string" },
    "environment-id": { type: "string" },
  },
});
if (!values.live) throw new Error("Pass --live to authorize bounded Luna model execution");
const backend = values.backend ?? "local";
if (!["local", "modal", "shared"].includes(backend))
  throw new Error("Choose local, modal, or shared");
if (backend === "modal" && !values["image-id"])
  throw new Error("Modal requires an explicit Codex image");
const sharedAdminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (backend === "shared" && (!values["base-url"] || !sharedAdminToken))
  throw new Error("Shared execution requires --base-url and SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN");
const directory = resolve(values.output ?? `.supertag/native-conformance/${Date.now()}`);
const source = join(directory, "source");
await mkdir(source, { recursive: true });
await writeFile(
  join(source, "overlap.py"),
  "def overlaps(a,b):\n    return a[0] <= b[1] and b[0] <= a[1]\n",
);
const provider =
  backend === "modal"
    ? new ModalExecutionEnvironmentProvider({
        appName: "supertag-conformance",
        imageId: values["image-id"] as string,
        sandboxTimeoutMs: 180000,
        cpu: 1,
        memoryMiB: 1024,
      })
    : backend === "shared"
      ? new SharedExecutionEnvironmentProvider({
          baseUrl: values["base-url"] as string,
          adminToken: sharedAdminToken as string,
          environmentId: values["environment-id"] ?? "docker-codex-split",
          requestTimeoutMs: 30_000,
          guarantees: {
            filesystemIsolation: "sandbox",
            networkPolicy: "none",
            processTreeTermination: true,
            scopedHttp: false,
          },
        })
      : new LocalExecutionEnvironmentProvider();
const artifacts = new FileArtifactStore(join(directory, "artifacts")),
  sessionStates = new FileSessionStateStore(join(directory, "sessionStates"));
const marker = randomUUID();
const split = values.split === true || backend !== "local";
const makeWorker = () =>
  createCodexWorker({
    workspace: source,
    executionMode: "app-server",
    model: "gpt-5.6-luna",
    maxNativeAgents: 0,
    timeoutMs: 120000,
    executionEnvironment: provider,
    ...(split ? { harnessRuntime: new LocalHarnessRuntimeProvider() } : {}),
    artifactStore: artifacts,
    sessionStateStore: sessionStates,
    profileId: "native-conformance",
    outputs: [
      { path: "overlap.py", name: "overlap.py" },
      { path: "result.json", name: "result.json" },
    ],
    ...(backend === "modal" || backend === "shared" ? { sandboxMode: "external" as const } : {}),
    ...(values["auth-file"] ? { authFile: resolve(values["auth-file"]) } : {}),
  });
const reports: unknown[] = [];
async function execute(phase: "initial" | "resumed", sessionState?: SessionStateRef) {
  const worker = makeWorker();
  const base = repositoryAttempt(`native-${phase}`);
  const workerProfile = { id: "native-conformance", revision: "1" };
  const spec = {
    ...base,
    workerProfile,
    authorization: {
      ...base.authorization,
      tag: { ...base.authorization.tag },
      ...(backend === "shared"
        ? {
            runtimeActions: [...(base.authorization.runtimeActions ?? []), "web:search"],
          }
        : {}),
    },
  };
  const prompt =
    phase === "initial"
      ? `First say you are starting, before using any tools. Fix overlap.py for scheduling intervals. Use python3 (not python). Keep commands minimal. You will receive an updated adjacency requirement while working; follow it. Do not spawn helpers. Remember this continuity marker: ${marker}. Write result.json with marker and phase=initial. Do not finish before testing the adjacent-interval rule. Keep the task small.`
      : `Resume the previous work. The sandbox is fresh and source files reset. Fix overlap.py using the adjacency rule established in our previous turn, and write result.json with the exact continuity marker from that turn and phase=resumed. The marker is intentionally not repeated. Do not spawn helpers.`;
  const attempt = {
    ...spec,
    session: { id: "native-conformance-session", ...(sessionState ? { sessionState } : {}) },
    input: { ...spec.input, messages: [{ id: phase, role: "requester" as const, text: prompt }] },
  };
  const events: TaskAttemptEvent[] = [];
  let steered = phase !== "initial";
  try {
    for await (const event of worker.execute(attempt)) {
      events.push(event);
      if (!steered && event.type === "output.delta") {
        const ack = await worker.control?.({
          id: "adjacency-update",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          type: "input",
          text: "Updated requirement: adjacent intervals do NOT overlap. Verify overlaps((0,10),(10,20)) is false in either order. Use this rule for the implementation.",
        });
        if (ack?.status !== "accepted")
          throw new Error(`Steering not accepted: ${JSON.stringify(ack)}`);
        steered = true;
      }
    }
  } finally {
    await writeFile(join(directory, `${phase}-events.json`), JSON.stringify(events, null, 2));
  }
  if (events.at(-1)?.type !== "execution.completed")
    throw new Error(`Native execution failed: ${JSON.stringify(events.at(-1))}`);
  if (!steered) throw new Error("No active turn was steered");
  const exported = events.filter((e) => e.type === "artifact.created");
  for (const event of exported)
    if (event.type === "artifact.created")
      await writeFile(
        join(directory, `${phase}-${event.artifact.name}`),
        await artifacts.get(event.artifact),
      );
  const verify = await promisify(execFile)("python3", [
    "-c",
    "import runpy,json,sys;f=runpy.run_path(sys.argv[1])['overlaps'];assert not f((0,10),(10,20));assert not f((10,20),(0,10));assert f((0,10),(5,15));d=json.load(open(sys.argv[2]));assert d['marker']==sys.argv[3];assert d['phase']==sys.argv[4];print('VERIFIED')",
    join(directory, `${phase}-overlap.py`),
    join(directory, `${phase}-result.json`),
    marker,
    phase,
  ]);
  const children = new Set(
    events.flatMap((e) => (e.type === "agent.updated" && e.agent.parentId ? [e.agent.id] : [])),
  );
  if (children.size !== 0)
    throw new Error(`Codex native subagents are disabled, observed ${children.size}`);
  const cp = events.findLast((e) => e.type === "session.updated");
  if (cp?.type !== "session.updated") throw new Error("Missing portable sessionState");
  reports.push({
    phase,
    helpers: children.size,
    steered,
    verification: verify.stdout.trim(),
    usage: events.findLast((e) => e.type === "usage.updated"),
    sessionState: cp.sessionState,
    manifest: events.find((event) => event.type === "runtime-inputs.resolved"),
  });
  return cp.sessionState;
}
const sessionState = await execute("initial");
if (values.resume) await execute("resumed", sessionState);
const report = { backend, split, model: "gpt-5.6-luna", reports };
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
