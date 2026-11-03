import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleArtifactRequest } from "../apps/cli/src/artifact-http.js";
import { ArtifactCatalog, ObjectiveController } from "../packages/control-plane/src/index.js";
import {
  type ArtifactSelection,
  TagMessagingError,
  type TaskAssignment,
} from "../packages/core/src/index.js";
import { claudeCodeArtifactSources } from "../packages/runtime/harnesses/claude-code/src/artifact-sources.js";
import { codexArtifactSources } from "../packages/runtime/harnesses/codex/src/artifact-sources.js";
import { FileArtifactStore } from "../packages/runtime/sdk/src/artifact-store.js";
import {
  collectTaskAttemptEvents,
  connectWorkerMcpClient,
  createWorker,
  DurableLocalWorklet,
  FileAttemptJournal,
  type Harness,
  type HarnessSessionReference,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  type TaskAttemptSpec,
  terminalTaskResult,
} from "../packages/runtime/sdk/src/index.js";
import { outputSpecDigest } from "../packages/runtime/sdk/src/output-finalization.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { hostArtifactStore } from "./support/host-artifact-store.js";

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect} automatic artifact execution`,
    () => {
      const cleanups: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const close of cleanups.splice(0).reverse()) await close();
      });
      async function fixture(homeMode?: "codex" | "claude") {
        const directory = await mkdtemp(join(tmpdir(), "automatic-artifacts-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const pg =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] as string)
            : undefined;
        if (pg) cleanups.push(pg.cleanup);
        const url = pg?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const owner = await store.createTag({ name: "owner" });
        const producer = await store.createTag({ name: "producer" });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Preserve every output",
        });
        const team = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: objective.id,
            name: "engineering",
            leadTagId: owner.id,
            memberTagIds: [producer.id],
            maxConcurrency: 100,
          },
          owner.id,
        );
        const callers = new Map<string, TaskAssignment>();
        const coordinator = new ObjectiveController(store, undefined);
        const catalog = new ArtifactCatalog(store, {
          async authenticateExecution(token) {
            const caller = callers.get(token ?? "");
            if (!caller) throw new TagMessagingError(401, "Unknown Attempt");
            return caller;
          },
          authorizeArtifactSource: coordinator.authorizeArtifactSource.bind(coordinator),
          artifactDiscoveryTaskIds: coordinator.artifactDiscoveryTaskIds.bind(coordinator),
        });
        // The Worker Host's own copies: the Control Plane below serves metadata only.
        const blobs = new FileArtifactStore(join(directory, "host-artifacts"));
        let unavailable = false;
        const server = createServer((request, response) => {
          // A catalog outage while the host publishes its copy's upload receipt.
          if (unavailable && request.url === "/internal/v1/artifacts/catalog/upload") {
            response.writeHead(503);
            response.end("Catalog unavailable");
            return;
          }
          void handleArtifactRequest(
            request,
            response,
            new URL(request.url ?? "/", "http://localhost"),
            catalog,
          );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanups.push(async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No HTTP port");
        const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
        const roots: string[] = [];
        const runtimeRoots: string[] = [];
        const restoredMemories: string[] = [];
        const leases = new Map<string, string>();
        const nativeSessions = new Map<string, HarnessSessionReference>();
        let runs = 0;
        const harness: Harness = {
          id: "deterministic-output",
          async describe() {
            return {
              sessions: { resume: false, export: false, scope: "none" as const },
              id: this.id,
              version: "1",
              inputKinds: ["instruction", "tool"],
              streaming: true,
              cancellation: true,
              sessionPersistence: "none",
              splitExecution: true,
              toolIsolation: { managerOnly: true },
              mcpClients: [{ client: "worker-host", transports: ["worker-local"] }],
            };
          },
          async plan() {
            const empty = {
              files: [],
              mounts: [],
              environmentVariables: {},
              secretBindings: [],
              network: { mode: "none" as const },
            };
            if (homeMode) {
              const skillHome = homeMode === "codex" ? ".codex/skills" : ".claude-config/skills";
              return {
                runtime: {
                  ...empty,
                  files: [
                    {
                      path: `${skillHome}/installed/SKILL.md`,
                      content: "Preinstalled unchanged capability",
                    },
                  ],
                },
                execution: empty,
                artifactSources:
                  homeMode === "codex" ? codexArtifactSources : claudeCodeArtifactSources,
              };
            }
            return { runtime: empty, execution: empty };
          },
          async start(_plan, environments, context) {
            roots.push(environments.execution.rootDirectory);
            runtimeRoots.push(environments.runtime.rootDirectory);
            let session: HarnessSessionReference | undefined;
            const nativeSession = { harnessId: this.id, id: randomUUID() };
            return {
              get session() {
                return session;
              },
              async *run() {
                runs += 1;
                // Native IDs may become available only after the Harness starts running.
                if (context.attempt.input.messages[0]?.text !== "no-native-session") {
                  session = nativeSession;
                  nativeSessions.set(context.attempt.attemptId, nativeSession);
                }
                if (homeMode) {
                  const mode = context.attempt.input.messages[0]?.text;
                  const put = async (path: string, content: string) => {
                    const destination = join(environments.runtime.rootDirectory, path);
                    await mkdir(dirname(destination), { recursive: true });
                    await writeFile(destination, content);
                  };
                  if (mode !== "unchanged") {
                    if (homeMode === "codex") {
                      await put(
                        ".codex/generated_images/chart.png",
                        `Image for ${context.attempt.taskId}`,
                      );
                      await put(
                        ".codex/visualizations/2026/09/15/session/index.html",
                        "<html>chart</html>",
                      );
                      await put(
                        ".codex/visualizations/2026/09/15/session/data.json",
                        '{"value":42}',
                      );
                      const memoryPath = ".codex/memories/MEMORY.md";
                      if (mode === "update-memory" || mode === "observe-memory") {
                        const restored = await readFile(
                          join(environments.runtime.rootDirectory, memoryPath),
                          "utf8",
                        );
                        restoredMemories.push(restored);
                        if (mode === "update-memory")
                          await put(memoryPath, `${restored}\nRemember follow-up evidence`);
                      } else await put(memoryPath, "Remember evidence");
                      await put(".codex/skills/authored/SKILL.md", "Authored capability");
                      await put(
                        ".codex/skills/.system/private/SKILL.md",
                        "System capability excluded",
                      );
                    } else {
                      await put(
                        ".claude-config/plans/launch.md",
                        `Plan for ${context.attempt.taskId}`,
                      );
                      await put(".claude-config/usage-data/report.html", "<html>Insights</html>");
                      const memoryPath = ".claude-config/projects/project/memory/MEMORY.md";
                      if (mode === "update-memory" || mode === "observe-memory") {
                        const restored = await readFile(
                          join(environments.runtime.rootDirectory, memoryPath),
                          "utf8",
                        );
                        restoredMemories.push(restored);
                        if (mode === "update-memory")
                          await put(memoryPath, `${restored}\nRemember follow-up evidence`);
                      } else await put(memoryPath, "Remember project evidence");
                      await put(
                        ".claude-config/agent-memory/reviewer/MEMORY.md",
                        "Remember reviewer evidence",
                      );
                      await put(".claude-config/skills/authored/SKILL.md", "Authored capability");
                      await put(
                        ".claude-config/projects/project/session.jsonl",
                        "Private transcript excluded",
                      );
                      await put(".claude-config/usage-data/cache.json", "Cached analysis excluded");
                    }
                  }
                  const home = homeMode === "codex" ? ".codex" : ".claude-config";
                  await put(`${home}/auth.json`, "Credential excluded");
                  await put(`${home}/sessions/private.jsonl`, "Transcript excluded");
                  await mkdir(join(environments.execution.rootDirectory, "workspace"), {
                    recursive: true,
                  });
                  await writeFile(
                    join(environments.execution.rootDirectory, "workspace/app.ts"),
                    "Code tracked by Git",
                  );
                  // A decoy verifies collection resolves paths against the runtime, not the execution host.
                  const decoy = join(environments.execution.rootDirectory, home, "plans");
                  await mkdir(decoy, { recursive: true });
                  await writeFile(join(decoy, "wrong-host.md"), "Wrong filesystem excluded");
                }
                if (!homeMode && context.attempt.input.messages[0]?.text !== "missing") {
                  const output = join(environments.execution.rootDirectory, "outputs");
                  await mkdir(output, { recursive: true });
                  await writeFile(
                    join(output, "report.md"),
                    `Report for ${context.attempt.taskId}`,
                  );
                }
                if (context.attempt.input.messages[0]?.text === "stage-failure") {
                  await writeFile(join(directory, "output-journal"), "Blocked staging directory");
                }
                if (context.attempt.input.messages[0]?.text?.startsWith("intermediate")) {
                  await writeFile(
                    join(environments.execution.rootDirectory, "draft.md"),
                    "Intermediate notes",
                  );
                  const tool = context.tools.find((input) => input.binding.kind === "worker-local");
                  if (!tool) throw new Error("No artifact tools");
                  const connection = await connectWorkerMcpClient(tool);
                  const captured = await connection.callTool("capture_artifact", {
                    operationId: "draft",
                    title: "Draft notes",
                    kind: "report",
                    files: [{ path: "draft.md" }],
                  });
                  if (captured.isError) throw new Error(JSON.stringify(captured));
                  await connection.close();
                }
                yield { type: "output.message", text: "Completed without a capture call" };
              },
              async close() {
                session = undefined;
              },
            };
          },
        };
        const makeWorker = () =>
          createWorker({
            id: "automatic-worker",
            maxConcurrency: 16,
            outputJournalDirectory: join(directory, "output-journal"),
            artifactStore: hostArtifactStore(blobs),
            profiles: [
              {
                ref: { id: "test", revision: "1" },
                workerType: "supertag",
                harness: { provider: harness.id },
                execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
                ...(homeMode
                  ? {
                      runtime: {
                        provider: "local-harness-runtime",
                        lifetime: { scope: "attempt" as const },
                      },
                    }
                  : {}),
              },
            ],
            harnesses: [harness],
            ...(homeMode
              ? {
                  harnessRuntimes: [
                    new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
                  ],
                }
              : {}),
            environments: [
              new LocalExecutionEnvironmentProvider({ temporaryDirectory: directory }),
            ],
          });
        async function assignment(
          text = "produce",
          inputArtifacts?: readonly ArtifactSelection[],
        ): Promise<TaskAttemptSpec> {
          const at = new Date().toISOString();
          const record = await store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: objective.id,
            teamId: team.id,
            assignedTagId: producer.id,
            requestedByTagId: owner.id,
            instruction: text,
            acceptanceCriteria: ["Report exists"],
            ...(inputArtifacts ? { inputArtifacts } : {}),
            execution: homeMode
              ? {}
              : {
                  outputs:
                    text === "intermediate-empty"
                      ? { include: ["outputs/absent/**"] }
                      : { required: ["outputs/report.md"] },
                },
            workspacePlan: { version: 1, status: "none" },
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: producer,
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
          });
          const leaseOwner = `fixture-${record.taskId}`;
          const claimed = await store.claimTaskAssignment({ taskId: record.taskId, leaseOwner });
          if (!claimed) throw new Error("Fixture Task was not claimed");
          leases.set(record.taskId, leaseOwner);
          const attempt = await store.createTaskAttempt({
            taskId: record.taskId,
            attemptNumber: claimed.attemptCount,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: at,
          });
          const token = randomUUID();
          callers.set(token, { ...record, attemptCount: 1 });
          const task = await store.findTaskById(record.taskId);
          if (!task) throw new Error("Missing Task");
          return {
            version: 2,
            taskId: record.taskId,
            attemptId: attempt.id,
            tag: producer,
            authorization: task.authorizationSnapshot,
            contextPlan: task.contextPlan,
            workspacePlan: task.workspacePlan,
            execution: task.execution,
            workerProfile: { id: "test", revision: "1" },
            coordination: { controlPlaneUrl, token, objectiveId: objective.id },
            input: {
              ...(Array.isArray(task.trigger["inputArtifacts"])
                ? {
                    attachments: task.trigger["inputArtifacts"] as unknown as NonNullable<
                      TaskAttemptSpec["input"]["attachments"]
                    >,
                  }
                : {}),
              origin: {
                surface: "internal",
                accountId: "organization",
                scope: objective.id,
                sessionKey: record.taskId,
                occurredAt: at,
              },
              messages: [{ id: randomUUID(), role: "requester", text }],
            },
          };
        }
        return {
          store,
          directory,
          blobs,
          roots,
          runtimeRoots,
          makeWorker,
          assignment,
          async find(spec: TaskAttemptSpec, query: string) {
            const response = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/find`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${spec.coordination?.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ query }),
            });
            expect(response.status).toBe(200);
            return response.json() as Promise<{ artifacts: { id: string }[] }>;
          },
          async inspect(spec: TaskAttemptSpec, artifactId: string) {
            const response = await fetch(
              `${controlPlaneUrl}/internal/v1/artifacts/catalog/inspect`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${spec.coordination?.token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ artifactId }),
              },
            );
            expect(response.status).toBe(200);
            return response.json() as Promise<{
              artifact: { harnessSession?: HarnessSessionReference };
            }>;
          },
          async submit(
            spec: TaskAttemptSpec,
            result: NonNullable<ReturnType<typeof terminalTaskResult>>,
          ) {
            const leaseOwner = leases.get(spec.taskId);
            if (!leaseOwner) throw new Error("Missing fixture lease");
            await store.settleTaskAssignment({
              taskId: spec.taskId,
              leaseOwner,
              attemptCount: 1,
              result: { taskResult: result },
            });
          },
          restoredMemories,
          nativeSessions,
          runs: () => runs,
          unavailable(value: boolean) {
            unavailable = value;
          },
        };
      }

      it.each(["codex", "claude"] as const)(
        "captures %s native home bundles from split runtimes without treating workspace code as artifacts",
        async (homeMode) => {
          const f = await fixture(homeMode);
          const spec = await f.assignment();
          expect(spec.execution.outputs).toBeUndefined();
          const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
          expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
            type: "execution.completed",
          });
          const result = present(terminalTaskResult(events));
          expect(result.artifacts).toHaveLength(homeMode === "codex" ? 3 : 4);
          const all = (await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts;
          expect(all).toHaveLength(homeMode === "codex" ? 4 : 5);
          expect(all.every((artifact) => artifact.attemptId === spec.attemptId)).toBe(true);
          for (const artifact of all)
            expect(artifact.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
          expect((await f.inspect(spec, present(all[0]).id)).artifact.harnessSession).toEqual(
            f.nativeSessions.get(spec.attemptId),
          );
          const submitted = new Set(result.artifacts.map((selection) => selection.artifactId));
          const memory = all.filter((artifact) => artifact.kind === "memory");
          expect(memory).toHaveLength(homeMode === "codex" ? 1 : 2);
          expect(memory.every((artifact) => submitted.has(artifact.id))).toBe(true);
          const capabilities = all.filter((artifact) => artifact.kind === "capability");
          expect(capabilities).toHaveLength(1);
          expect(capabilities.every((artifact) => !submitted.has(artifact.id))).toBe(true);
          const paths = all.flatMap((artifact) => artifact.entries.map((entry) => entry.path));
          expect(paths.some((path) => path.endsWith("authored/SKILL.md"))).toBe(true);
          for (const excluded of [
            "auth.json",
            "private.jsonl",
            "session.jsonl",
            "cache.json",
            "wrong-host.md",
            "app.ts",
            "installed/SKILL.md",
            ".system/",
          ])
            expect(paths.some((path) => path.includes(excluded))).toBe(false);
          if (homeMode === "codex") {
            const visual = present(all.find((artifact) => artifact.kind === "visualization"));
            expect(visual.entries.map((entry) => entry.path.split("/").at(-1)).sort()).toEqual([
              "data.json",
              "index.html",
            ]);
            const image = present(all.find((artifact) => artifact.kind === "media"));
            expect(Buffer.from(await f.blobs.get(present(image.entries[0]))).toString()).toBe(
              `Image for ${spec.taskId}`,
            );
          }
          expect(f.runtimeRoots[0]).not.toBe(f.roots[0]);
          for (const root of [...f.roots, ...f.runtimeRoots])
            await expect(access(root)).rejects.toThrow();
        },
      );

      it.each(["codex", "claude"] as const)(
        "does not attribute unchanged preinstalled %s home content to the Attempt",
        async (homeMode) => {
          const f = await fixture(homeMode);
          const spec = await f.assignment("unchanged");
          const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
          expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
            type: "execution.completed",
          });
          expect(terminalTaskResult(events)?.artifacts).toEqual([]);
          expect((await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts).toEqual(
            [],
          );
        },
      );

      it.each(["codex", "claude"] as const)(
        "restores exact admitted %s memory on another Worker and captures only its update",
        async (homeMode) => {
          const f = await fixture(homeMode);
          const first = await f.assignment();
          const firstEvents = await collectTaskAttemptEvents(f.makeWorker().execute(first));
          const firstResult = present(terminalTaskResult(firstEvents));
          await f.submit(first, firstResult);
          const artifacts = (await f.store.listCapturedArtifacts({ taskId: first.taskId }))
            .artifacts;
          const priorMemory = present(artifacts.find((artifact) => artifact.kind === "memory"));
          const memoryInput = present(
            firstResult.artifacts.find((selection) => selection.artifactId === priorMemory.id),
          );

          const observer = await f.assignment("observe-memory", [memoryInput]);
          const observerEvents = await collectTaskAttemptEvents(f.makeWorker().execute(observer));
          expect(observerEvents.at(-1), JSON.stringify(observerEvents.at(-1))).toMatchObject({
            type: "execution.completed",
          });
          expect(
            (await f.store.listCapturedArtifacts({ taskId: observer.taskId })).artifacts.some(
              (artifact) =>
                artifact.entries.some((entry) =>
                  entry.path.includes(
                    `${homeMode === "codex" ? "codex-memories" : "claude-project-memories"}/`,
                  ),
                ),
            ),
          ).toBe(false);

          const second = await f.assignment("update-memory", [memoryInput]);
          const secondEvents = await collectTaskAttemptEvents(f.makeWorker().execute(second));
          expect(secondEvents.at(-1), JSON.stringify(secondEvents.at(-1))).toMatchObject({
            type: "execution.completed",
          });
          const originalMemory =
            homeMode === "codex" ? "Remember evidence" : "Remember project evidence";
          expect(f.restoredMemories).toEqual([originalMemory, originalMemory]);
          const secondArtifacts = (await f.store.listCapturedArtifacts({ taskId: second.taskId }))
            .artifacts;
          const updatedMemory = present(
            secondArtifacts.find(
              (artifact) =>
                artifact.kind === "memory" &&
                artifact.entries.some((entry) =>
                  entry.path.includes(
                    `${homeMode === "codex" ? "codex-memories" : "claude-project-memories"}/`,
                  ),
                ),
            ),
          );
          expect(updatedMemory.id).not.toBe(priorMemory.id);
          expect(priorMemory.harnessSession).toEqual(f.nativeSessions.get(first.attemptId));
          expect(updatedMemory.harnessSession).toEqual(f.nativeSessions.get(second.attemptId));
          expect(updatedMemory.harnessSession).not.toEqual(priorMemory.harnessSession);
          expect(updatedMemory.inputs).toEqual([memoryInput]);
          expect(f.runtimeRoots).toHaveLength(3);
          expect(f.runtimeRoots[0]).not.toBe(f.runtimeRoots[1]);
          expect(f.runtimeRoots[1]).not.toBe(f.runtimeRoots[2]);
        },
      );

      it("retains explicit agent captures alongside automatic home deliverables", async () => {
        const f = await fixture("codex");
        const spec = await f.assignment("intermediate");
        const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
        expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
          type: "execution.completed",
        });
        expect(terminalTaskResult(events)?.artifacts).toHaveLength(4);
        const artifacts = (await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts;
        expect(artifacts).toHaveLength(5);
        expect(artifacts.some((artifact) => artifact.title === "Draft notes")).toBe(true);
        for (const artifact of artifacts)
          expect(artifact.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
      });

      it("recovers native home output groups after upload outage and Worklet restart without rerunning Codex", async () => {
        const f = await fixture("codex");
        const spec = await f.assignment();
        f.unavailable(true);
        const journalDirectory = join(f.directory, "attempt-journal");
        const first = new DurableLocalWorklet(
          new LocalWorklet("worklet", "host", [f.makeWorker()]),
          new FileAttemptJournal(journalDirectory),
        );
        await first.accept(spec);
        for await (const _event of first.events(spec.attemptId)) {
          /* Drain before restart. */
        }
        expect(f.runs()).toBe(1);
        for (const root of [...f.roots, ...f.runtimeRoots])
          await expect(access(root)).rejects.toThrow();
        await first.close();
        f.unavailable(false);
        const restarted = new DurableLocalWorklet(
          new LocalWorklet("worklet", "host", [f.makeWorker()]),
          new FileAttemptJournal(journalDirectory),
        );
        try {
          await expect
            .poll(async () => (await restarted.inspect(spec.attemptId))?.status, { timeout: 10000 })
            .toBe("completed");
          const recovered = [];
          for await (const event of restarted.events(spec.attemptId)) recovered.push(event.event);
          expect(terminalTaskResult(recovered)?.artifacts).toHaveLength(3);
          const artifacts = (await f.store.listCapturedArtifacts({ taskId: spec.taskId }))
            .artifacts;
          expect(artifacts).toHaveLength(4);
          for (const artifact of artifacts)
            expect(artifact.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
          expect(f.runs()).toBe(1);
        } finally {
          await restarted.close();
        }
      }, 20000);

      it("isolates native Codex home artifacts across 100 deterministic Attempts", async () => {
        const f = await fixture("codex");
        const worker = f.makeWorker();
        const specs: TaskAttemptSpec[] = [];
        for (let i = 0; i < 100; i++) specs.push(await f.assignment());
        const ids = await Promise.all(
          specs.map(async (spec) => {
            const events = await collectTaskAttemptEvents(worker.execute(spec));
            expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
              type: "execution.completed",
            });
            expect(terminalTaskResult(events)?.artifacts).toHaveLength(3);
            const all = (await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts;
            expect(all).toHaveLength(4);
            expect(all.every((artifact) => artifact.attemptId === spec.attemptId)).toBe(true);
            for (const artifact of all)
              expect(artifact.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
            const image = present(all.find((artifact) => artifact.kind === "media"));
            expect(Buffer.from(await f.blobs.get(present(image.entries[0]))).toString()).toBe(
              `Image for ${spec.taskId}`,
            );
            return image.id;
          }),
        );
        expect(new Set(ids).size).toBe(100);
        expect(f.runs()).toBe(100);
        for (const root of [...f.roots, ...f.runtimeRoots])
          await expect(access(root)).rejects.toThrow();
      }, 120000);

      it("automatically persists a required report through real HTTP/catalog and survives workspace disposal", async () => {
        const f = await fixture();
        const spec = await f.assignment();
        const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
        expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
          type: "execution.completed",
        });
        const result = terminalTaskResult(events);
        expect(result?.artifacts).toHaveLength(1);
        const artifact = await f.store.findCapturedArtifact(
          present(result?.artifacts[0]).artifactId,
        );
        expect(artifact?.taskId).toBe(spec.taskId);
        expect(artifact?.attemptId).toBe(spec.attemptId);
        expect(artifact?.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
        expect((await f.inspect(spec, present(artifact).id)).artifact.harnessSession).toEqual(
          f.nativeSessions.get(spec.attemptId),
        );
        expect(artifact?.entries.map((entry) => entry.path)).toEqual(["outputs/report.md"]);
        expect(artifact?.summary).toBe("Files (1):\noutputs/report.md");
        expect((await f.find(spec, "report.md")).artifacts.map((item) => item.id)).toEqual([
          present(artifact).id,
        ]);
        expect((await f.find(spec, "unrelated-filename.md")).artifacts).toEqual([]);
        const entry = present(artifact?.entries[0]);
        expect(Buffer.from(await f.blobs.get(entry)).toString()).toBe(`Report for ${spec.taskId}`);
        for (const root of f.roots) await expect(access(root)).rejects.toThrow();
        expect(f.runs()).toBe(1);
      });

      it("leaves native provenance absent when the Harness does not expose a native session", async () => {
        const f = await fixture();
        const spec = await f.assignment("no-native-session");
        const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
        expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
        const artifacts = (await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts;
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.harnessSession).toBeUndefined();
        expect(f.nativeSessions.size).toBe(0);
      });

      it("keeps explicitly captured intermediate files out of automatic submission", async () => {
        const f = await fixture();
        const spec = await f.assignment("intermediate");
        const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
        expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
          type: "execution.completed",
        });
        const result = terminalTaskResult(events);
        expect(result?.artifacts.flatMap((artifact) => artifact.paths)).toEqual([
          "outputs/report.md",
        ]);
        const all = await f.store.listCapturedArtifacts({ taskId: spec.taskId });
        expect(all.artifacts).toHaveLength(2);
        expect(
          all.artifacts.flatMap((artifact) => artifact.entries.map((entry) => entry.path)),
        ).toContain("draft.md");
      });

      it("recovers an unknown durable Attempt through inspection after a Worklet restart", async () => {
        const f = await fixture();
        const spec = await f.assignment();
        f.unavailable(true);
        const journalDirectory = join(f.directory, "attempt-journal");
        const first = new DurableLocalWorklet(
          new LocalWorklet("worklet", "host", [f.makeWorker()]),
          new FileAttemptJournal(journalDirectory),
        );
        await first.accept(spec);
        const original = [];
        for await (const event of first.events(spec.attemptId)) original.push(event);
        expect(original.some((entry) => entry.event.type === "execution.completed")).toBe(false);
        expect(f.runs()).toBe(1);
        for (const root of [...f.roots, ...f.runtimeRoots])
          await expect(access(root)).rejects.toThrow();
        await first.close();
        f.unavailable(false);
        const restarted = new DurableLocalWorklet(
          new LocalWorklet("worklet", "host", [f.makeWorker()]),
          new FileAttemptJournal(journalDirectory),
        );
        try {
          await expect
            .poll(async () => (await restarted.inspect(spec.attemptId))?.status, { timeout: 10000 })
            .toBe("completed");
          const recovered = [];
          for await (const event of restarted.events(spec.attemptId)) recovered.push(event.event);
          expect(terminalTaskResult(recovered)?.artifacts).toHaveLength(1);
          expect(f.runs()).toBe(1);
          expect(recovered.filter((event) => event.type === "execution.started")).toHaveLength(1);
        } finally {
          await restarted.close();
        }
      }, 20000);

      it("removes output files when local staging fails and refuses a repeat execution", async () => {
        const f = await fixture();
        const spec = await f.assignment("stage-failure");
        const worker = f.makeWorker();
        await expect(collectTaskAttemptEvents(worker.execute(spec))).rejects.toThrow();
        expect(f.runs()).toBe(1);
        expect(f.roots).toHaveLength(1);
        await expect(access(present(f.roots[0]))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(collectTaskAttemptEvents(worker.execute(spec))).rejects.toThrow();
        expect(f.runs()).toBe(1);
      });

      it("keeps explicit captures intermediate when an output policy selects no files", async () => {
        const f = await fixture();
        const spec = await f.assignment("intermediate-empty");
        const events = await collectTaskAttemptEvents(f.makeWorker().execute(spec));
        expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
          type: "execution.completed",
        });
        expect(terminalTaskResult(events)?.artifacts).toEqual([]);
        expect(
          (await f.store.listCapturedArtifacts({ taskId: spec.taskId })).artifacts,
        ).toHaveLength(1);
      });

      it("fails when the Harness forgets the required deliverable", async () => {
        const f = await fixture();
        const events = await collectTaskAttemptEvents(
          f.makeWorker().execute(await f.assignment("missing")),
        );
        expect(events.some((event) => event.type === "execution.failed")).toBe(true);
        expect(events.some((event) => event.type === "execution.completed")).toBe(false);
        expect(f.runs()).toBe(1);
      });

      it("recovers frozen outputs after upload outage and Worker restart without repeating the Harness", async () => {
        const f = await fixture();
        const spec = await f.assignment();
        f.unavailable(true);
        await expect(collectTaskAttemptEvents(f.makeWorker().execute(spec))).rejects.toThrow(
          /pending/i,
        );
        expect(f.runs()).toBe(1);
        for (const root of [...f.roots, ...f.runtimeRoots])
          await expect(access(root)).rejects.toThrow();
        f.unavailable(false);
        const restarted = f.makeWorker();
        const recovery = await restarted.recoverOutputFinalization?.(
          spec.attemptId,
          outputSpecDigest(spec),
        );
        expect(recovery).toBeDefined();
        const events = await collectTaskAttemptEvents(present(recovery).events);
        expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
          type: "execution.completed",
        });
        const result = terminalTaskResult(events);
        expect(result?.artifacts).toHaveLength(1);
        expect(f.runs()).toBe(1);
        const artifact = await f.store.findCapturedArtifact(
          present(result?.artifacts[0]).artifactId,
        );
        expect(artifact?.attemptId).toBe(spec.attemptId);
        expect(artifact?.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
        const replay = await restarted.recoverOutputFinalization?.(
          spec.attemptId,
          outputSpecDigest(spec),
        );
        const repeated = terminalTaskResult(await collectTaskAttemptEvents(present(replay).events));
        expect(repeated?.artifacts).toEqual(result?.artifacts);
      });

      it("preserves isolated outputs for 100 deterministic Attempts with bounded concurrency", async () => {
        const f = await fixture();
        const worker = f.makeWorker();
        const specs: TaskAttemptSpec[] = [];
        for (let i = 0; i < 100; i++) specs.push(await f.assignment());
        const results = await Promise.all(
          specs.map(async (spec) => {
            const events = await collectTaskAttemptEvents(worker.execute(spec));
            expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
              type: "execution.completed",
            });
            const result = terminalTaskResult(events);
            expect(result?.artifacts).toHaveLength(1);
            const artifact = await f.store.findCapturedArtifact(
              present(result?.artifacts[0]).artifactId,
            );
            expect(artifact?.attemptId).toBe(spec.attemptId);
            expect(artifact?.harnessSession).toEqual(f.nativeSessions.get(spec.attemptId));
            expect(Buffer.from(await f.blobs.get(present(artifact?.entries[0]))).toString()).toBe(
              `Report for ${spec.taskId}`,
            );
            return present(artifact).id;
          }),
        );
        expect(new Set(results).size).toBe(100);
        expect(f.runs()).toBe(100);
        for (const root of f.roots) await expect(access(root)).rejects.toThrow();
      }, 120_000);
    },
  );
}

function present<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Expected test evidence");
  return value;
}
