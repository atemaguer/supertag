import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TaskNamedWorkspacePlan, taskWorkspaceBranch } from "../packages/core/src/index.js";
import type { WorkspacePullRequestOutcome } from "../packages/runtime/sdk/src/git-workspace.js";
import {
  deliverWorkspace,
  MAX_WORKSPACE_BUNDLE_BYTES,
  WorkspaceHost,
} from "../packages/runtime/sdk/src/workspace-environment.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

vi.setConfig({ testTimeout: 30_000 });

describe("ref-based Workspace delivery", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  let source: string;
  let clone: string;
  let root: string;
  let base: string;
  let secret: string;
  let head: string;
  let bundle: string;
  let host: WorkspaceHost;
  const branch = taskWorkspaceBranch("objective-1", "task-1");
  const plan = (delivery: TaskNamedWorkspacePlan["delivery"]): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch,
    delivery,
  });
  const objects = async (path = bundle) => ({
    bundle: path,
    digest: `sha256:${createHash("sha256")
      .update(await readFile(path))
      .digest("hex")}`,
  });
  const deliver = async (
    delivery: TaskNamedWorkspacePlan["delivery"] = "branch",
    overrides: {
      head?: string;
      bundle?: string;
      digest?: string;
      base?: string;
      publish?: (base: string, head: string) => Promise<WorkspacePullRequestOutcome>;
    } = {},
  ) =>
    deliverWorkspace(
      {
        host,
        repository: { path: clone, managed: true },
        base: overrides.base ?? base,
        outcome: "completed",
        ...(overrides.publish ? { publish: overrides.publish } : {}),
      },
      plan(delivery),
      {
        head: overrides.head ?? head,
        committed: true,
        objects: {
          ...(await objects(overrides.bundle)),
          ...(overrides.digest ? { digest: overrides.digest } : {}),
        },
      },
    );

  beforeEach(async () => {
    cleanup.push(await isolateGitConfiguration());
    source = await createRepository();
    base = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--quiet", "-b", "secret");
    await writeFile(join(source, "secret.txt"), "TOPSECRET\n");
    git(source, "add", "secret.txt");
    git(source, "commit", "--quiet", "-m", "Secret");
    secret = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--quiet", "main");
    root = await mkdtemp(join(tmpdir(), "supertag-ref-delivery-"));
    clone = join(root, "clone.git");
    git(root, "clone", "--bare", "--quiet", source, clone);
    git(source, "checkout", "--quiet", "-b", "candidate");
    await writeFile(join(source, "change.txt"), "task change\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "Task change");
    head = git(source, "rev-parse", "HEAD");
    bundle = join(root, "task.bundle");
    git(source, "bundle", "create", bundle, "candidate", `^${base}`);
    host = new WorkspaceHost({ root, checkouts: new Map(), cloneSources: true });
    cleanup.push(() => rm(source, { recursive: true, force: true }));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
  });

  afterEach(async () => {
    for (const done of cleanup.splice(0).reverse()) await done();
  });

  it.each(["branch", "patch", "pull-request"] as const)(
    "delivers %s from the imported ref",
    async (mode) => {
      const publish = vi.fn(async () => ({
        status: "approval-pending" as const,
        message: "approval required",
      }));
      const record = await deliver(mode, { publish });
      expect(git(clone, "rev-parse", `refs/heads/${branch}`)).toBe(head);
      expect(record).toMatchObject({
        branch,
        delivery: mode,
        base,
        head,
        committed: true,
        changedFiles: 1,
      });
      expect(record.patch === undefined).toBe(mode !== "patch");
      if (mode === "patch")
        expect(Buffer.from(record.patch ?? []).toString()).toContain("task change");
      expect(publish).toHaveBeenCalledTimes(mode === "pull-request" ? 1 : 0);
    },
  );

  it("accepts the single HEAD advertised by a base..HEAD bundle", async () => {
    const headBundle = join(root, "head.bundle");
    git(source, "bundle", "create", headBundle, "HEAD", `^${base}`);
    const record = await deliver("branch", { bundle: headBundle });
    expect(record.head).toBe(head);
    expect(git(clone, "rev-parse", `refs/heads/${branch}`)).toBe(head);
  });

  it("delivers a thin bundle with a delta against a large base file", async () => {
    git(source, "checkout", "--quiet", "main");
    const lines = Array.from(
      { length: 400 },
      (_, index) => `line ${index}: ${"payload".repeat(20)}`,
    );
    await writeFile(join(source, "big.txt"), `${lines.join("\n")}\n`);
    git(source, "add", "big.txt");
    git(source, "commit", "--quiet", "-m", "Large base file");
    base = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--quiet", "-b", "large-candidate");
    lines[200] = "line 200: changed payload";
    await writeFile(join(source, "big.txt"), `${lines.join("\n")}\n`);
    git(source, "add", "big.txt");
    git(source, "commit", "--quiet", "-m", "Edit large base file");
    head = git(source, "rev-parse", "HEAD");
    git(root, "--git-dir", clone, "fetch", "--quiet", source, "main:refs/heads/main");
    const thin = join(root, "thin.bundle");
    git(source, "bundle", "create", thin, "large-candidate", `^${base}`);
    const bundleBytes = await readFile(thin);
    const packStart = bundleBytes.indexOf(Buffer.from("\n\n")) + 2;
    const empty = join(root, "empty.git");
    git(root, "init", "--bare", "--quiet", empty);
    expect(() =>
      execFileSync("git", ["-C", empty, "index-pack", "--stdin"], {
        input: bundleBytes.subarray(packStart),
      }),
    ).toThrow(/unresolved deltas/);
    const record = await deliver("patch", { bundle: thin });
    expect(record.head).toBe(head);
    expect(Buffer.from(record.patch ?? []).toString()).toContain("changed payload");
    expect(git(clone, "rev-parse", `refs/heads/${branch}`)).toBe(head);
  });

  it("rejects a bundle over 32 MiB before importing", async () => {
    const huge = join(root, "huge.bundle");
    await writeFile(huge, Buffer.alloc(MAX_WORKSPACE_BUNDLE_BYTES + 1));
    await expect(deliver("branch", { bundle: huge })).rejects.toThrow("at most");
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("refuses a FIFO bundle path without blocking", async () => {
    const fifo = join(root, "fifo.bundle");
    execFileSync("mkfifo", [fifo]);
    await expect(
      deliverWorkspace(
        { host, repository: { path: clone, managed: true }, base, outcome: "completed" },
        plan("branch"),
        { head, committed: true, objects: { bundle: fifo, digest: `sha256:${"0".repeat(64)}` } },
      ),
    ).rejects.toThrow("regular file");
  });

  it("ignores inherited Git environment overrides", async () => {
    const previous = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(root, "nonexistent.git");
    try {
      const record = await deliver();
      expect(record.head).toBe(head);
    } finally {
      if (previous === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = previous;
    }
  });

  it("honors operator global config for network git commands", async () => {
    const config = join(root, "operator.gitconfig");
    await writeFile(config, `[url "${clone}"]\n\tinsteadOf = operator://workspace\n`);
    const previous = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = config;
    try {
      expect(await host.run(root, ["ls-remote", "operator://workspace", "HEAD"])).toContain(base);
      expect((await deliver()).head).toBe(head);
    } finally {
      if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = previous;
    }
  });

  it("rejects a changed digest and a corrupt bundle", async () => {
    await expect(deliver("branch", { digest: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
      "digest",
    );
    const corrupt = join(root, "corrupt.bundle");
    await writeFile(corrupt, "not a git bundle\n");
    await expect(deliver("branch", { bundle: corrupt })).rejects.toThrow(/bundle|git/i);
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("rejects a bundle whose prerequisite is absent from the host clone", async () => {
    await writeFile(join(source, "later.txt"), "later\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "Later");
    const later = git(source, "rev-parse", "HEAD");
    const laterBundle = join(root, "later.bundle");
    git(source, "bundle", "create", laterBundle, "candidate", `^${head}`);
    await expect(deliver("branch", { bundle: laterBundle, head: later })).rejects.toThrow(
      /bundle verify|prerequisite/i,
    );
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("rejects a damaged pack even when the bundle digest matches", async () => {
    const bytes = await readFile(bundle);
    bytes[bytes.length - 24] = (bytes[bytes.length - 24] as number) ^ 0xff;
    const damaged = join(root, "damaged.bundle");
    await writeFile(damaged, bytes);
    await expect(deliver("branch", { bundle: damaged })).rejects.toThrow();
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("rejects an unreachable object hidden in the single-ref bundle pack", async () => {
    const extraFile = join(source, "hidden-object.txt");
    await writeFile(extraFile, "not in the Task history\n");
    const extra = git(source, "hash-object", "-w", extraFile);
    const original = await readFile(bundle);
    const packStart = original.indexOf(Buffer.from("PACK"));
    expect(packStart).toBeGreaterThan(0);
    const pack = execFileSync("git", ["-C", source, "pack-objects", "--stdout", "--revs"], {
      input: `${head}\n^${base}\n${extra}\n`,
      maxBuffer: MAX_WORKSPACE_BUNDLE_BYTES,
    });
    const injected = join(root, "injected.bundle");
    await writeFile(injected, Buffer.concat([original.subarray(0, packStart), pack]));
    await expect(deliver("branch", { bundle: injected })).rejects.toThrow(
      /pack|history|fsck|fetch/i,
    );
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("refuses a bundle that borrows a secret branch commit from the host clone", async () => {
    const merged = execFileSync(
      "git",
      ["-C", source, "commit-tree", `${secret}^{tree}`, "-p", base, "-p", secret],
      { input: "Merge secret\n", encoding: "utf8" },
    ).trim();
    const pack = execFileSync("git", ["-C", source, "pack-objects", "--stdout"], {
      input: `${merged}\n`,
    });
    const malicious = join(root, "merge-secret.bundle");
    await writeFile(
      malicious,
      Buffer.concat([
        Buffer.from(
          `# v2 git bundle\n-${base} base\n-${secret} secret\n${merged} refs/heads/candidate\n\n`,
        ),
        pack,
      ]),
    );
    await expect(deliver("patch", { bundle: malicious, head: merged })).rejects.toThrow();
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("refuses a bundle whose tree borrows a secret blob from the host clone", async () => {
    const secretBlob = git(source, "rev-parse", "secret:secret.txt");
    const tree = execFileSync("git", ["-C", source, "mktree", "--missing"], {
      input: `100644 blob ${secretBlob}\tborrowed.txt\n`,
      encoding: "utf8",
    }).trim();
    const borrowed = execFileSync("git", ["-C", source, "commit-tree", tree, "-p", base], {
      input: "Borrow secret blob\n",
      encoding: "utf8",
    }).trim();
    const pack = execFileSync("git", ["-C", source, "pack-objects", "--stdout"], {
      input: `${borrowed}\n${tree}\n`,
    });
    const malicious = join(root, "borrow-secret.bundle");
    await writeFile(
      malicious,
      Buffer.concat([
        Buffer.from(`# v2 git bundle\n-${base} base\n${borrowed} refs/heads/candidate\n\n`),
        pack,
      ]),
    );
    await expect(deliver("patch", { bundle: malicious, head: borrowed })).rejects.toThrow();
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("rejects a bundle advertising more than one ref", async () => {
    git(source, "branch", "extra");
    const two = join(root, "two.bundle");
    git(source, "bundle", "create", two, "candidate", "extra", `^${base}`);
    await expect(deliver("branch", { bundle: two })).rejects.toThrow("exactly one ref");
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("rejects a head outside the Task base history", async () => {
    git(source, "checkout", "--quiet", "--orphan", "unrelated");
    git(source, "rm", "-qrf", ".");
    await writeFile(join(source, "unrelated.txt"), "unrelated\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "Unrelated");
    const unrelated = git(source, "rev-parse", "HEAD");
    const other = join(root, "other.bundle");
    git(source, "bundle", "create", other, "unrelated");
    await expect(deliver("branch", { bundle: other, head: unrelated })).rejects.toThrow();
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });

  it("imports only the Task ref and refuses a finalized head mismatch", async () => {
    git(source, "branch", "evil");
    await expect(deliver("branch", { head: base })).rejects.toThrow("head differs");
    const record = await deliver();
    expect(record.head).toBe(head);
    expect(git(clone, "show-ref", "--heads")).not.toContain("evil");
  });

  it("refuses a non-fast-forward update to an existing Task ref", async () => {
    await deliver();
    git(source, "checkout", "--quiet", "-b", "sibling", base);
    await writeFile(join(source, "sibling.txt"), "different\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "Sibling");
    const sibling = git(source, "rev-parse", "HEAD");
    const siblingBundle = join(root, "sibling.bundle");
    git(source, "bundle", "create", siblingBundle, "sibling", `^${base}`);
    await expect(deliver("branch", { bundle: siblingBundle, head: sibling })).rejects.toThrow();
    expect(git(clone, "rev-parse", `refs/heads/${branch}`)).toBe(head);
  });

  it("does not run a repository hook while importing or updating the Task ref", async () => {
    const signal = join(root, "hook-ran");
    const hook = join(clone, "hooks", "reference-transaction");
    await writeFile(hook, `#!/bin/sh\nprintf hook > '${signal}'\n`);
    await chmod(hook, 0o755);
    await deliver();
    await expect(stat(signal)).rejects.toThrow();
  });

  it("removes an empty Task ref when a remote Attempt made no commit", async () => {
    const record = await deliverWorkspace(
      { host, repository: { path: clone, managed: true }, base, outcome: "completed" },
      plan("branch"),
      { head: base, committed: false },
    );
    expect(record).toMatchObject({ changedFiles: 0, committed: false, branchRemoved: true });
    expect(git(clone, "show-ref", "--heads")).not.toContain(branch);
  });
});
