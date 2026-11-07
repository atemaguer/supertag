import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import {
  runTagConversationCommand,
  type TagMessageRecord,
} from "../apps/cli/src/tag-conversation.ts";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.ts";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.ts";
import {
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

async function mcp(spec: TaskAttemptSpec, method: string, params: Record<string, unknown>) {
  const coordination = spec.coordination;
  if (!coordination) throw new Error("Task has no coordination");
  const response = await fetch(`${coordination.controlPlaneUrl}/internal/v1/coordination/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${coordination.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: Record<string, unknown> };
}

it("numbers a work Session's branches after its short id", () => {
  const id = "0f3c2a9e-1111-2222-3333-444455556666";
  expect(workSessionBranch(id)).toBe("supertag/session/0f3c2a9e");
  expect(workSessionBranch(id, "supertag/session/0f3c2a9e")).toBe("supertag/session/0f3c2a9e-2");
  expect(workSessionBranch(id, "supertag/session/0f3c2a9e-2")).toBe("supertag/session/0f3c2a9e-3");
});

interface WorkletOptions {
  readonly failFirstWork?: boolean;
  /** The first work Task writes nothing, as when it only asks the person. */
  readonly emptyFirstWork?: boolean;
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `work Session Workspaces (${dialect})`,
    { timeout: 60_000 },
    () => {
      const cleanups: (() => Promise<unknown> | unknown)[] = [];
      let checkout: string;
      let store: DrizzleStore;
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
      /** What each Task saw: its kind, spec, tool results and, for work, the files it found. */
      let seen: {
        kind: "conversation" | "work" | "report";
        spec: TaskAttemptSpec;
        results: string[];
        files?: string[];
      }[];

      /** A Tag Worklet whose work Tasks run a real Worker on a Workspace worktree. */
      function worklet(workspaces: readonly string[], options: WorkletOptions = {}): Worklet {
        let failWork = options.failFirstWork === true;
        let skipWrite = options.emptyFirstWork === true;
        const root = join(checkout, "..", `${checkout.split("/").at(-1)}-worktrees`);
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        let files: string[] = [];
        const worker = createCodexWorker({
          workspace: checkout,
          workspaceResolvers: new WorkspaceResolverRegistry([
            new WorkspaceEnvironmentResolver({
              checkouts: workspaces.map((name) => ({ name, path: checkout })),
              worktreeRoot: root,
            }),
          ]),
          runner: async function* (request: { readonly workspace: string }) {
            files = (await readdir(request.workspace)).filter((name) => name.endsWith(".txt"));
            // A Task that only asks the person edits nothing.
            if (skipWrite) {
              skipWrite = false;
              yield { type: "output.message" as const, text: "Which file should I write?" };
              return;
            }
            const next = files.includes("first.txt") ? "second.txt" : "first.txt";
            await writeFile(join(request.workspace, next), `${next}\n`);
            yield { type: "output.message" as const, text: `Wrote ${next}.` };
          } as never,
        });
        const profile = { id: "default", revision: "1" };
        return {
          id: "work-worklet",
          describe: async () => ({
            id: "work-worklet",
            protocolVersion: 1,
            host: {
              id: "work-host",
              workspaces: [...workspaces],
              workers: [
                {
                  id: "work-worker",
                  type: "deterministic",
                  profiles: [profile],
                  profileCapabilities: [
                    { profile, capabilities: [SURFACE_COORDINATION_CAPABILITY], contextTypes: [] },
                  ],
                  capabilities: [SURFACE_COORDINATION_CAPABILITY],
                  contextTypes: [],
                  maxConcurrency: 4,
                },
              ],
            },
          }),
          selectPlacement: async () => ({
            workerHostId: "work-host",
            workletId: "work-worklet",
            workerId: "work-worker",
            workerProfile: profile,
          }),
          async *execute(spec): AsyncIterable<TaskAttemptEvent> {
            const system = spec.input.messages
              .filter((message) => message.role === "system")
              .map((message) => message.text)
              .join("\n");
            const kind = /This (is|continues) work Session/u.test(system)
              ? "work"
              : system.includes("Report its result")
                ? "report"
                : "conversation";
            if (kind === "work" && spec.workspacePlan.status === "workspace") {
              const workerProfile = (await worker.describe()).profiles[0];
              if (!workerProfile) throw new Error("The Worker has no profile");
              const failing = failWork;
              failWork = false;
              for await (const event of worker.execute({ ...spec, workerProfile })) {
                // A failing first Attempt commits its edits, then fails before completing.
                if (failing && (event.type === "result" || event.type === "execution.completed"))
                  continue;
                yield event;
              }
              seen.push({ kind, spec, results: [], files });
              if (failing) throw new Error("The Worker Host went away");
              return;
            }
            const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
            const at = () => new Date().toISOString();
            yield { ...identity, at: at(), type: "execution.started", workerId: "work-worker" };
            const request = spec.input.messages.findLast((message) => message.role === "requester");
            const results: string[] = [];
            const call = async (name: string, args: Record<string, unknown>) => {
              const response = await mcp(spec, "tools/call", { name, arguments: args });
              const content = response.result?.["content"] as { text: string }[] | undefined;
              results.push(content?.[0]?.text ?? "");
            };
            let text = "Done.";
            if (kind === "conversation") {
              // "work:TITLE[@WORKSPACE]" or "continue:SESSION|MESSAGE".
              const message = request?.text ?? "";
              if (message.startsWith("work:")) {
                const [title, workspace] = message.slice(5).split("@");
                await call("start_session", {
                  title,
                  instruction: `Do ${title}`,
                  ...(workspace === undefined ? {} : { workspace }),
                });
              } else if (message.startsWith("continue:")) {
                const [sessionId, answer] = message.slice(9).split("|");
                await call("continue_session", { sessionId, message: answer });
              }
              text = results[0] ?? "Answered.";
            } else if (kind === "report") text = system;
            seen.push({ kind, spec, results });
            yield {
              ...identity,
              at: at(),
              type: "output.message",
              message: { role: "teammate", text },
            };
            yield {
              ...identity,
              at: at(),
              type: "result",
              result: {
                summary: text,
                decisions: [],
                changes: [],
                unresolved: [],
                findings: [],
                references: [],
                artifacts: [],
              },
            };
            yield { ...identity, at: at(), type: "execution.completed" };
          },
        };
      }

      async function start(workspaces: readonly string[], options: WorkletOptions = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-session-workspaces-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let databaseUrl = `file:${join(directory, "supertag.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          databaseUrl = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url: databaseUrl });
        store = new DrizzleStore({ url: databaseUrl });
        await store.connect();
        cleanups.push(() => store.disconnect());
        await store.applyWorkspace({ name: "app", delivery: "branch" });
        await store.applyWorkspace({ name: "docs", delivery: "branch" });
        const tag = await store.createTag({ name: "planner" });
        await store.bindTagWorkerHost(tag.id, "work-host");
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl,
          adminToken: ADMIN,
          worklet: worklet(workspaces, options),
        });
        cleanups.push(async () => {
          await runtime?.close();
          runtime = undefined;
        });
      }

      const send = async (text: string) => {
        if (!runtime) throw new Error("not started");
        return JSON.parse(
          await runTagConversationCommand(
            { url: runtime.url, token: ADMIN },
            ["planner", text, "--session", "plan", "--output", "json"],
            { intervalMs: 20, timeoutMs: 30_000 },
          ),
        ) as TagMessageRecord;
      };

      beforeEach(async () => {
        seen = [];
        cleanups.push(await isolateGitConfiguration());
        checkout = await createRepository();
        cleanups.push(() => rm(checkout, { recursive: true, force: true }));
      });
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
        vi.unstubAllEnvs();
      });

      it("commits a work Session's edits to its branch, reports it, and continues from it", async () => {
        await start(["app"]);
        const record = await send("work:Fix readme");
        const started = record.startedSessions?.[0];
        if (!started?.taskId || !started.reportTaskId) throw new Error("missing work Session");
        const branch = workSessionBranch(started.id);
        expect(branch).toBe(`supertag/session/${started.id.slice(0, 8)}`);
        // The CLI conversation's Tag host declares one Workspace, so the work Task edits it.
        const workTask = await store.findTaskById(started.taskId);
        expect(workTask?.workspacePlan).toEqual({
          version: 1,
          status: "workspace",
          workspace: "app",
          branch,
          delivery: "branch",
        });
        // The conversation turn itself keeps its own plan.
        expect((await store.findTaskById(record.taskId))?.workspacePlan).toEqual({
          version: 1,
          status: "none",
        });
        expect(git(checkout, "show", `${branch}:first.txt`)).toBe("first.txt");
        expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");
        expect(git(checkout, "status", "--porcelain")).toBe("");
        const head = git(checkout, "rev-parse", branch);
        // The report turn is told where the changes are.
        const reportSystem = seen
          .filter((entry) => entry.kind === "report")
          .map((entry) =>
            entry.spec.input.messages
              .filter((message) => message.role === "system")
              .map((message) => message.text)
              .join("\n"),
          )
          .join("\n");
        expect(reportSystem).toContain(
          `Its changes are committed to branch ${branch} of Workspace app (head ${head.slice(0, 12)}, 1 changed file).`,
        );

        // The continued Task starts from the work Session's branch and sees the earlier commit.
        const continued = await send(`continue:${started.id}|Answer: go on`);
        expect(continued.status).toBe("replied");
        await vi.waitFor(
          async () => {
            const tasks = await store.listTasks({ sessionId: started.id });
            expect(tasks).toHaveLength(2);
            expect(tasks[0]?.status).toBe("completed");
          },
          { timeout: 20_000 },
        );
        const [next] = await store.listTasks({ sessionId: started.id });
        expect(next?.workspacePlan).toMatchObject({ workspace: "app", branch: `${branch}-2` });
        const work = seen.filter((entry) => entry.kind === "work");
        expect(work).toHaveLength(2);
        expect(work[1]?.spec.workspacePlan).toMatchObject({
          dependencyBranches: [{ taskId: started.taskId, branch, head }],
        });
        expect(work[1]?.files).toEqual(["first.txt"]);
        expect(git(checkout, "show", `${branch}-2:first.txt`)).toBe("first.txt");
        expect(git(checkout, "show", `${branch}-2:second.txt`)).toBe("second.txt");
        expect(git(checkout, "merge-base", "--is-ancestor", head, `${branch}-2`)).toBe("");
        // Its report says the new branch already holds the earlier branch's changes.
        await vi.waitFor(
          () =>
            expect(
              seen
                .filter((entry) => entry.kind === "report")
                .flatMap((entry) => entry.spec.input.messages.map((message) => message.text))
                .join("\n"),
            ).toContain(`starts from the work Session's earlier branch ${branch}, so it already`),
          { timeout: 20_000 },
        );
      });

      it("gives the Session's branch to its first Task that commits, after one that asked", async () => {
        await start(["app"], { emptyFirstWork: true });
        const record = await send("work:Fix readme");
        const started = record.startedSessions?.[0];
        if (!started?.taskId) throw new Error("missing work Session");
        const branch = workSessionBranch(started.id);
        expect((await store.findTaskById(started.taskId))?.workspacePlan).toMatchObject({
          branch,
        });
        // The first Task committed nothing, so its Worker removed the branch.
        expect(git(checkout, "branch", "--list", branch)).toBe("");

        const waitForTasks = (count: number) =>
          vi.waitFor(
            async () => {
              const tasks = await store.listTasks({ sessionId: started.id });
              expect(tasks).toHaveLength(count);
              expect(tasks[0]?.status).toBe("completed");
            },
            { timeout: 20_000 },
          );
        await send(`continue:${started.id}|Answer: first.txt`);
        await waitForTasks(2);
        const [second] = await store.listTasks({ sessionId: started.id });
        // The Task that does the work gets the Session's branch, and starts from the base.
        expect(second?.workspacePlan).toMatchObject({ workspace: "app", branch });
        const work = seen.filter((entry) => entry.kind === "work");
        expect(work[1]?.spec.workspacePlan).not.toHaveProperty("dependencyBranches");
        expect(git(checkout, "show", `${branch}:first.txt`)).toBe("first.txt");
        const head = git(checkout, "rev-parse", branch);

        // The next Task is numbered after it and builds on it.
        await send(`continue:${started.id}|Answer: go on`);
        await waitForTasks(3);
        const [third] = await store.listTasks({ sessionId: started.id });
        expect(third?.workspacePlan).toMatchObject({ branch: `${branch}-2` });
        expect(seen.filter((entry) => entry.kind === "work")[2]?.spec.workspacePlan).toMatchObject({
          dependencyBranches: [{ taskId: second?.id, branch, head }],
        });
        expect(git(checkout, "show", `${branch}-2:second.txt`)).toBe("second.txt");
      });

      it("pins a retried work Session Task to its own branch and head", async () => {
        await start(["app"], { failFirstWork: true });
        const record = await send("work:Fix readme");
        const started = record.startedSessions?.[0];
        const taskId = started?.taskId;
        if (!started || !taskId) throw new Error("missing work Session");
        const branch = workSessionBranch(started.id);
        await vi.waitFor(
          async () => expect((await store.findTaskById(taskId))?.status).toBe("completed"),
          { timeout: 20_000 },
        );
        const work = seen.filter((entry) => entry.kind === "work");
        expect(work).toHaveLength(2);
        // The retry names the branch and head the first Attempt committed, so a Worker Host
        // without that branch adopts it instead of starting again from the base.
        const retried = work[1]?.spec.workspacePlan as { branchPinHead?: string } | undefined;
        expect(retried).toMatchObject({ branch, branchPin: branch });
        expect(retried?.branchPinHead).toMatch(/^[0-9a-f]{40}/u);
        const pinned = retried?.branchPinHead ?? "";
        expect(git(checkout, "merge-base", "--is-ancestor", pinned, branch)).toBe("");
      });

      it("asks for a choice among several Workspaces and validates it", async () => {
        await start(["app", "docs"]);
        await send("work:Ambiguous");
        expect(seen.find((entry) => entry.kind === "conversation")?.results[0]).toContain(
          "This conversation has several Workspaces; pass workspace, one of: app, docs",
        );
        await send("work:Elsewhere@other");
        expect(seen.filter((entry) => entry.kind === "conversation")[1]?.results[0]).toContain(
          "workspace must be one of this conversation's Workspaces: app, docs",
        );
        const record = await send("work:Docs@docs");
        const started = record.startedSessions?.[0];
        if (!started?.taskId) throw new Error("missing work Session");
        expect((await store.findTaskById(started.taskId))?.workspacePlan).toMatchObject({
          workspace: "docs",
          branch: workSessionBranch(started.id),
        });
      });

      it("keeps the conversation's plan without a Workspace", async () => {
        await start([]);
        const record = await send("work:Research");
        const started = record.startedSessions?.[0];
        if (!started?.taskId) throw new Error("missing work Session");
        expect((await store.findTaskById(started.taskId))?.workspacePlan).toEqual({
          version: 1,
          status: "none",
        });
        expect(git(checkout, "branch", "--list", "supertag/*")).toBe("");
      });
    },
  );
}
