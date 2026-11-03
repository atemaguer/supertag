import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createWorker,
  DurableLocalWorklet,
  type EnvironmentPlan,
  type ExecutionEnvironmentProvider,
  FileAttemptJournal,
  type Harness,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type TaskAttemptEvent,
  WorkspaceResolverRegistry,
} from "../../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "./file-artifact-store.js";
import { repositoryAttempt } from "./repository-execution.js";

const original = "def overlaps(a, b):\n    return a[0] <= b[1] and b[0] <= a[1]\n";
const checks = `from overlap import overlaps
assert overlaps((0, 10), (5, 15))
assert not overlaps((0, 10), (10, 20))
assert not overlaps((10, 20), (0, 10))
assert not overlaps((0, 5), (6, 10))
assert overlaps((0, 10), (0, 10))
print("VERIFIED: 5 scheduling overlap cases")
`;

function emptyEnvironmentPlan(): EnvironmentPlan {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  };
}

export async function prepareHarnessFixture(directory: string) {
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "overlap.py"), original);
  await writeFile(join(source, "test_overlap.py"), checks);
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", args, {
        cwd: source,
        env: { PATH: process.env["PATH"], HOME: source, GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout.trim();
  await git("init");
  await git("add", ".");
  await git(
    "-c",
    "user.name=SuperTag Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Scheduling fixture",
  );
  return { source, revision: await git("rev-parse", "HEAD") };
}

/** Explicitly invoked live-provider conformance; never part of the default test suite. */
export async function runHarnessConformance(options: {
  directory: string;
  harness: Harness;
  executionEnvironment: ExecutionEnvironmentProvider;
  source: string;
  revision: string;
}) {
  const artifacts = new FileArtifactStore(join(options.directory, "artifacts"));
  const wrapped: Harness = {
    id: options.harness.id,
    describe: () => options.harness.describe(),
    async plan(context) {
      const plan = await options.harness.plan(context);
      return {
        ...plan,
        outputs: [{ path: "workspace/overlap.py", name: "overlap.py", mediaType: "text/x-python" }],
      };
    },
    start: (plan, environment, context) => options.harness.start(plan, environment, context),
  };
  const execute = async (
    id: string,
    harness: Harness,
    executionEnvironment: ExecutionEnvironmentProvider,
    prompt: string,
  ) => {
    const profile = { id, revision: "1" };
    const worker = createWorker({
      id,
      profiles: [
        {
          ref: profile,
          workerType: "conformance",
          harness: { provider: harness.id },
          execution: { provider: executionEnvironment.id, lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harness],
      environments: [executionEnvironment],
      artifactStore: artifacts,
      ...(id === "producer"
        ? {
            workspaceResolvers: new WorkspaceResolverRegistry([
              {
                async resolve() {
                  return {
                    id: "pinned-repository",
                    kind: "workspace" as const,
                    required: true,
                    mountPath: "workspace",
                    readOnly: false,
                    source: {
                      uri: pathToFileURL(options.source).href,
                      provenance: { revision: options.revision },
                    },
                  };
                },
              },
            ]),
          }
        : {}),
    });
    const host = new DurableLocalWorklet(
      new LocalWorklet(id, id, [worker]),
      new FileAttemptJournal(join(options.directory, `${id}-journal`)),
    );
    const task = repositoryAttempt(id);
    const spec = {
      ...task,
      workerProfile: profile,
      authorization: {
        ...task.authorization,
        tag: { ...task.authorization.tag },
      },
      input: {
        ...task.input,
        messages: [{ id: `${id}-request`, role: "requester" as const, text: prompt }],
      },
    };
    const events: TaskAttemptEvent[] = [];
    try {
      await host.accept(spec);
      for await (const item of host.events(spec.attemptId)) events.push(item.event);
      const receipt = await host.inspect(spec.attemptId);
      if (receipt?.status !== "completed") {
        const failure = events.findLast((event) => event.type === "execution.failed");
        throw new Error(
          `${id}: ${receipt?.status}; ${failure?.type === "execution.failed" ? failure.error.message : "no terminal completion"}`,
        );
      }
      return { receipt, events };
    } finally {
      await host.shutdown("Conformance finished");
      await host.close();
    }
  };
  const producer = await execute(
    "producer",
    wrapped,
    options.executionEnvironment,
    "Fix overlap.py so scheduling intervals are half-open: adjacent appointments do not overlap. Edit only overlap.py, then run python3 test_overlap.py from the workspace directory. Do not change tests. Keep your final response brief.",
  );
  const artifact = producer.events.find((event) => event.type === "artifact.created")?.artifact;
  if (!artifact) throw new Error("Producer did not export an artifact");
  const reviewer: Harness = {
    id: "independent-reviewer",
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
        execution: {
          files: [{ path: "workspace/test_overlap.py", content: checks }],
          mounts: [{ source: artifact, destination: "workspace/overlap.py", readOnly: true }],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" },
        },
      };
    },
    async start(_plan, environments) {
      const environment = environments.execution;
      return {
        async *run(signal) {
          const child = await environment.spawn(
            {
              command: "python3",
              args: ["test_overlap.py"],
              cwd: environment.resolvePath("workspace"),
              timeoutMs: 10000,
            },
            signal,
          );
          const result = await child.wait();
          if (result.exitCode !== 0 || !result.stdout.includes("VERIFIED"))
            throw new Error("Independent artifact verification failed");
          yield { type: "output.message" as const, text: result.stdout };
        },
        async close() {},
      };
    },
  };
  const review = await execute(
    "reviewer",
    reviewer,
    new LocalExecutionEnvironmentProvider(),
    "Verify immutable artifact against independent tests",
  );
  if ((await readFile(join(options.source, "overlap.py"), "utf8")) !== original)
    throw new Error("Source checkout was modified");
  const report = {
    harness: options.harness.id,
    executionEnvironment: options.executionEnvironment.id,
    revision: options.revision,
    artifact,
    producerStatus: producer.receipt.status,
    reviewStatus: review.receipt.status,
    verificationCases: 5,
    producerEventTypes: producer.events.map((event) => event.type),
    immutableSource: pathToFileURL(options.source).href,
  };
  await writeFile(join(options.directory, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
