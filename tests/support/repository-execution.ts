import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  emptyTagContextPlan,
  type TagAuthorizationSnapshot,
} from "../../packages/core/src/index.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type EnvironmentPlan,
  type ExecutionEnvironment,
  type Harness,
  LocalExecutionEnvironmentProvider,
  type TaskAttemptSpec,
} from "../../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "./file-artifact-store.js";

const git = async (cwd: string, ...args: string[]) =>
  (
    await promisify(execFile)("git", args, {
      cwd,
      timeout: 5000,
      env: { PATH: process.env["PATH"], HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
    })
  ).stdout.trim();

function emptyEnvironmentPlan(): EnvironmentPlan {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  };
}
/** Explicit test-fixture source materialization, not a claim of a built-in Git resolver. */
export async function repositoryExecutionFixture(directory: string) {
  const source = join(directory, "source"),
    seed = join(directory, "pinned");
  await mkdir(source, { recursive: true });
  await git(source, "init");
  await writeFile(
    join(source, "overlap.cjs"),
    "module.exports=(a,b)=>a.start<=b.end&&b.start<=a.end;\n",
  );
  await git(source, "add", "overlap.cjs");
  await git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Pinned baseline",
  );
  const revision = await git(source, "rev-parse", "HEAD");
  await writeFile(
    join(source, "later.txt"),
    "A newer commit must not enter the requested revision\n",
  );
  await git(source, "add", "later.txt");
  await git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Newer source",
  );
  await writeFile(join(source, "overlap.cjs"), "uncommitted operator changes\n");
  await git(directory, "clone", "--no-hardlinks", "--no-local", source, seed);
  await git(seed, "checkout", "--detach", revision);
  return { source, seed, revision };
}

export async function runRepositoryExecution(directory: string) {
  const fixture = await repositoryExecutionFixture(directory);
  const artifacts = new FileArtifactStore(join(directory, "artifacts"));
  const roots: string[] = [];
  const run = async (
    environment: ExecutionEnvironment,
    command: string,
    args: string[],
    cwd = environment.resolvePath("repo"),
  ) => {
    const child = await environment.spawn({ command, args, cwd, timeoutMs: 5000 });
    const result = await child.wait();
    if (result.exitCode !== 0) throw new Error(result.stderr || `Process failed: ${command}`);
    return result.stdout.trim();
  };
  const plan = (): EnvironmentPlan => ({
    files: [],
    mounts: [
      {
        source: {
          uri: pathToFileURL(fixture.seed).href,
          provenance: { revision: fixture.revision },
        },
        destination: "repo",
        readOnly: false,
      },
    ],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  });
  const writer: Harness = {
    id: "repository-test",
    async describe() {
      return {
        sessions: { resume: false, export: false, scope: "none" as const },
        id: this.id,
        version: "1",
        inputKinds: [],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
      };
    },
    async plan() {
      return {
        runtime: emptyEnvironmentPlan(),
        execution: plan(),
        outputs: [
          { path: "repo/change.patch", name: "change.patch" },
          { path: "repo/evidence.json", name: "evidence.json" },
        ],
      };
    },
    async start(_plan, environments) {
      const environment = environments.execution;
      roots.push(environment.rootDirectory);
      return {
        async *run() {
          const head = await run(environment, "git", ["rev-parse", "HEAD"]);
          if (head !== fixture.revision) throw new Error("Materialized wrong revision");
          await run(environment, process.execPath, [
            "-e",
            "const fs=require('node:fs');if(fs.existsSync('later.txt'))throw new Error('Newer source leaked');fs.writeFileSync('overlap.cjs','module.exports=(a,b)=>a.start<b.end&&b.start<a.end;\\n');",
          ]);
          const patch = await run(environment, "git", ["diff", "--", "overlap.cjs"]);
          const paths = await run(environment, "git", ["diff", "--name-only"]);
          if (paths !== "overlap.cjs") throw new Error("Unexpected edit scope");
          await run(environment, process.execPath, [
            "-e",
            "const fs=require('node:fs');fs.writeFileSync('change.patch',process.argv[1]+'\\n');fs.writeFileSync('evidence.json',process.argv[2]);",
            patch,
            JSON.stringify({ revision: head, changedPaths: [paths] }),
          ]);
          yield { type: "output.message", text: "Pinned source changed and patch exported" };
        },
        async close() {},
      };
    },
  };
  const profile = {
    ref: { id: "repository", revision: "1" },
    workerType: "repository-test",
    harness: { provider: writer.id },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
  const execute = (id: string, harness: Harness) =>
    collectTaskAttemptEvents(
      createWorker({
        id,
        profiles: [profile],
        harnesses: [harness],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: new FileArtifactStore(join(directory, "artifacts")),
      }).execute(repositoryAttempt(id)),
    );
  const events = await execute("producer", writer);
  if (events.at(-1)?.type !== "execution.completed") throw new Error(JSON.stringify(events));
  const refs = events
    .filter((event) => event.type === "artifact.created")
    .map((event) => event.artifact);
  const patch = refs.find((ref) => ref.name === "change.patch"),
    evidence = refs.find((ref) => ref.name === "evidence.json");
  if (!patch || !evidence) throw new Error("Missing immutable output artifacts");
  const producerRemovedBeforeReview = await access(roots[0] ?? "").then(
    () => false,
    () => true,
  );
  if (!producerRemovedBeforeReview)
    throw new Error("Producer execution environment was not disposed");
  const reviewer: Harness = {
    ...writer,
    async plan() {
      const execution = plan();
      return {
        runtime: emptyEnvironmentPlan(),
        execution: {
          ...execution,
          mounts: [
            ...execution.mounts,
            { source: patch, destination: "change.patch", readOnly: true },
            { source: evidence, destination: "evidence.json", readOnly: true },
          ],
        },
        outputs: [{ path: "repo/verification.json", name: "verification.json" }],
      };
    },
    async start(_plan, environments) {
      const environment = environments.execution;
      roots.push(environment.rootDirectory);
      return {
        async *run() {
          await run(environment, "git", ["apply", "--check", "../change.patch"]);
          await run(environment, "git", ["apply", "../change.patch"]);
          const result = await run(environment, process.execPath, [
            "-e",
            `const fs=require('node:fs'),overlap=require('./overlap.cjs');const evidence=JSON.parse(fs.readFileSync('../evidence.json','utf8'));if(evidence.revision!==${JSON.stringify(fixture.revision)})throw new Error('Wrong evidence');const checks=[!overlap({start:0,end:10},{start:10,end:20}),overlap({start:0,end:10},{start:5,end:15})];if(!checks.every(Boolean))throw new Error('Independent checks failed');const result={passed:true,revision:evidence.revision,checks:checks.length};fs.writeFileSync('verification.json',JSON.stringify(result));process.stdout.write(JSON.stringify(result));`,
          ]);
          yield { type: "output.message", text: result };
        },
        async close() {},
      };
    },
  };
  const reviewEvents = await execute("reviewer", reviewer);
  if (reviewEvents.at(-1)?.type !== "execution.completed")
    throw new Error(JSON.stringify(reviewEvents));
  const verification = reviewEvents.find((event) => event.type === "artifact.created")?.artifact;
  if (!verification) throw new Error("Independent verification not exported");
  const outcome = JSON.parse(Buffer.from(await artifacts.get(verification)).toString("utf8"));
  return {
    ...fixture,
    roots,
    producerRemovedBeforeReview,
    patch,
    evidence,
    verification,
    outcome,
    originalWorkingTree: await readFile(join(fixture.source, "overlap.cjs"), "utf8"),
  };
}

export function repositoryAttempt(id: string): TaskAttemptSpec {
  const at = new Date().toISOString();
  const workerProfile = { id: "repository", revision: "1" };
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt: at,
    tag: { id: "tag", name: "Repository" },
    origin: {
      tagRouteId: "route",
      surfaceAccountId: "account",
      provider: "github",
      scope: "repo:test",
    },
    requester: { id: "user", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: ["files:write", "commands:execute"],
  };
  return {
    execution: {},
    version: 2,
    taskId: id,
    attemptId: `${id}-attempt`,
    tag: { id: "tag", name: "Repository" },
    workerProfile,
    authorization,
    contextPlan: emptyTagContextPlan(at),
    workspacePlan: { version: 1, status: "none" },
    input: {
      origin: {
        surface: "github",
        accountId: "account",
        scope: "repo:test",
        sessionKey: id,
        occurredAt: at,
      },
      messages: [],
    },
  };
}
