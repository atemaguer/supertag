import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { scanChangedPaths, scanRunningAttempts } from "../apps/cli/src/worker-changed-paths.js";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.js";
import { WorkletConnection } from "../packages/runtime/transport/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

describe("Worker Host changed-path reports", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let repository: string;
  let worktree: string;
  let base: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    repository = await createRepository();
    cleanups.push(() => rm(repository, { recursive: true, force: true }));
    const root = await mkdtemp(join(tmpdir(), "supertag-path-scan-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    worktree = join(root, "worktree");
    git(repository, "worktree", "add", "--detach", worktree);
    base = git(worktree, "rev-parse", "HEAD");
    const gitDir = git(worktree, "rev-parse", "--absolute-git-dir");
    await writeFile(join(gitDir, "supertag-base"), `${base}\n`);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("includes modified, untracked, and both renamed paths while dropping .git paths", async () => {
    await writeFile(join(worktree, "README.md"), "changed\n");
    await writeFile(join(worktree, "new.txt"), "new\n");
    git(worktree, "mv", ".gitignore", "renamed-ignore");
    await mkdir(join(worktree, "nested", ".git"), { recursive: true });
    await writeFile(join(worktree, "nested", ".git", "metadata"), "ignored\n");
    expect(await scanChangedPaths(worktree)).toEqual({
      paths: [".gitignore", "README.md", "new.txt", "renamed-ignore"],
      truncated: false,
    });
  });

  it("includes committed changes since the Attempt base and caps sorted paths at 500", async () => {
    await writeFile(join(worktree, "README.md"), "committed\n");
    git(worktree, "add", "README.md");
    git(worktree, "commit", "--quiet", "-m", "change");
    for (let index = 0; index < 501; index++)
      await writeFile(join(worktree, `file-${String(index).padStart(3, "0")}.txt`), "x");
    const report = await scanChangedPaths(worktree);
    expect(report?.paths).toHaveLength(500);
    expect(report?.paths[0]).toBe("README.md");
    expect(report?.paths.at(-1)).toBe("file-498.txt");
    expect(report?.truncated).toBe(true);
  });

  it("skips remote Attempts and failed or unreadable local worktrees", async () => {
    await writeFile(join(worktree, "new.txt"), "new\n");
    const attempts = [{ attemptId: "local", worktree }, { attemptId: "remote" }];
    expect(await scanRunningAttempts(attempts)).toEqual([
      { attemptId: "local", paths: ["new.txt"], truncated: false },
    ]);
    expect(await scanChangedPaths(join(worktree, "missing"))).toBeUndefined();
    expect(await scanChangedPaths(worktree, "bad-ref")).toBeUndefined();
  });

  it("attaches live changed-path reports to a heartbeat", async () => {
    await writeFile(join(worktree, "new.txt"), "new\n");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await once(server, "listening");
    const messages: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        messages.push(message);
        if (message.type === "hello")
          socket.send(
            JSON.stringify({ type: "ready", protocolVersion: 18, heartbeatIntervalMs: 20 }),
          );
      });
    });
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("Missing server address");
    const connection = new WorkletConnection({
      url: `ws://127.0.0.1:${address.port}`,
      credential: "test",
      worklet: new LocalWorklet("test", "host", [
        new StaticWorker({ id: "worker", profile: { id: "worker", revision: "1" } }),
      ]),
      changedPaths: () => scanRunningAttempts([{ attemptId: "attempt-1", worktree }]),
    });
    cleanups.push(() => connection.stop());
    await connection.start();
    await expect
      .poll(() => messages.find((message) => message.type === "heartbeat" && message.changedPaths))
      .toMatchObject({
        changedPaths: [{ attemptId: "attempt-1", paths: ["new.txt"], truncated: false }],
      });
  });
});
