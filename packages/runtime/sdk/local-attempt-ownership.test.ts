import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fsPromises from "node:fs/promises";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalAttemptOwnership,
  localAttemptCleanupConfirmed,
  recoverLocalAttempts,
} from "./src/local-attempt-ownership.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const identity = { taskId: "task", attemptId: "attempt", specDigest: "a".repeat(64) };
describe.skipIf(process.platform === "win32")(
  "Local Attempt ownership conservative recovery",
  () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      const parent = await mkdtemp(join(tmpdir(), "supertag-ownership-test-"));
      cleanups.push(() => rm(parent, { recursive: true, force: true }));
      const root = await mkdtemp(join(parent, "supertag-attempt-"));
      const ownership = await createLocalAttemptOwnership(root, identity);
      return {
        parent,
        root,
        ownership,
        metadata: join(
          parent,
          `.supertag-attempt-owners-${process.getuid?.() ?? "local"}`,
          basename(root),
        ),
      };
    }
    it("preserves a root when a concurrent reaper removes process evidence during disposal", async () => {
      const f = await fixture();
      const original = fsPromises.readdir;
      const scan = vi.spyOn(fsPromises, "readdir").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        if (String(args[0]) === f.metadata) {
          throw Object.assign(new Error("Concurrent ownership removal"), { code: "ENOENT" });
        }
        return original(...args);
      }) as typeof original);
      try {
        await expect(f.ownership.dispose()).resolves.toBe(false);
        expect((await lstat(f.root)).isDirectory()).toBe(true);
      } finally {
        scan.mockRestore();
      }
    });
    it("does not publish disposal to a concurrent reaper before checking process evidence", async () => {
      const f = await fixture();
      const original = fsPromises.readdir;
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let held = false;
      const scan = vi.spyOn(fsPromises, "readdir").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        if (String(args[0]) === f.metadata && !held) {
          held = true;
          entered();
          await blocked;
        }
        return original(...args);
      }) as typeof original);
      const disposal = f.ownership.dispose();
      try {
        await checking;
        await recoverLocalAttempts(f.parent);
        expect((await lstat(f.root)).isDirectory()).toBe(true);
        await expect(lstat(join(f.metadata, "finished.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        release();
        await expect(disposal).resolves.toBe(true);
        // Once disposal has checked its evidence and returned, another reaper may finish cleanup.
        await recoverLocalAttempts(f.parent);
        await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
        await f.ownership.forget();
      } finally {
        release();
        await disposal;
        scan.mockRestore();
      }
    });
    it("preserves an active owner and unknown legacy directories", async () => {
      const f = await fixture();
      const legacy = await mkdtemp(join(f.parent, "supertag-attempt-legacy-"));
      await recoverLocalAttempts(f.parent);
      expect((await lstat(f.root)).isDirectory()).toBe(true);
      expect((await lstat(legacy)).isDirectory()).toBe(true);
    });
    it("reaps finished roots concurrently without following links or touching Session state", async () => {
      const f = await fixture();
      const external = join(f.parent, "sessionState.txt");
      await writeFile(external, "sessionState", { mode: 0o400 });
      await symlink(external, join(f.root, "external-link"));
      const legacyLink = join(f.parent, "supertag-attempt-link");
      await symlink(f.root, legacyLink);
      expect(await f.ownership.dispose()).toBe(true);
      await Promise.all([recoverLocalAttempts(f.parent), recoverLocalAttempts(f.parent)]);
      await recoverLocalAttempts(f.parent);
      await f.ownership.forget();
      await f.ownership.forget();
      await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(legacyLink)).isSymbolicLink()).toBe(true);
      expect(await readFile(external, "utf8")).toBe("sessionState");
      expect((await lstat(external)).mode & 0o777).toBe(0o400);
      await chmod(external, 0o600);
    });
    it("retains roots with interrupted spawn registration or malformed metadata", async () => {
      const f = await fixture();
      await f.ownership.prepareProcess();
      expect(await f.ownership.dispose()).toBe(false);
      expect(
        await localAttemptCleanupConfirmed(f.parent, "task", "attempt", identity.specDigest),
      ).toBe(false);
      await recoverLocalAttempts(f.parent);
      expect((await lstat(f.root)).isDirectory()).toBe(true);
      const other = await fixture();
      expect(await other.ownership.dispose()).toBe(true);
      await writeFile(join(other.metadata, "manifest.json"), "{broken", { mode: 0o600 });
      await recoverLocalAttempts(other.parent);
      expect((await lstat(other.root)).isDirectory()).toBe(true);
    });
    it("persists cleanup proof bound to task, attempt, and specification, never for a live owner", async () => {
      const f = await fixture();
      expect(
        await localAttemptCleanupConfirmed(f.parent, "task", "attempt", identity.specDigest),
      ).toBe(false);
      await f.ownership.dispose();
      expect(
        await localAttemptCleanupConfirmed(f.parent, "task", "attempt", identity.specDigest),
      ).toBe(true);
      // Evidence survives repeated startup recovery after the ownership directory was removed.
      expect(
        await localAttemptCleanupConfirmed(f.parent, "task", "attempt", identity.specDigest),
      ).toBe(true);
      expect(
        await localAttemptCleanupConfirmed(f.parent, "other", "attempt", identity.specDigest),
      ).toBe(false);
      expect(await localAttemptCleanupConfirmed(f.parent, "task", "attempt", "b".repeat(64))).toBe(
        false,
      );
    });
    it("recovers a registered root after its owner process exits without disposal", async () => {
      const parent = await mkdtemp(join(tmpdir(), "supertag-dead-owner-"));
      cleanups.push(() => rm(parent, { recursive: true, force: true }));
      const root = await mkdtemp(join(parent, "supertag-attempt-"));
      const moduleUrl = new URL("./src/local-attempt-ownership.ts", import.meta.url).href;
      const source = `const {createLocalAttemptOwnership} = await import(${JSON.stringify(moduleUrl)}); await createLocalAttemptOwnership(process.argv[1], {taskId:"dead-owner",attemptId:"attempt"});`;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source, root],
        { stdio: "ignore" },
      );
      const exited = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        expect((await exited)[0]).toBe(0);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      await recoverLocalAttempts(parent);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }, 10000);

    it("preserves a recorded live process group after owner finishes, then reaps after exit", async () => {
      const f = await fixture();
      const registration = await f.ownership.prepareProcess();
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 9000)"], {
        detached: true,
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      try {
        if (!child.pid) throw new Error("Child did not start");
        await registration.record(child.pid);
        expect(await f.ownership.dispose()).toBe(false);
        expect(
          await localAttemptCleanupConfirmed(f.parent, "task", "attempt", identity.specDigest),
        ).toBe(false);
        await recoverLocalAttempts(f.parent);
        expect((await lstat(f.root)).isDirectory()).toBe(true);
        process.kill(-child.pid, "SIGTERM");
        await exited;
        await recoverLocalAttempts(f.parent);
        await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          await exited;
        }
      }
    }, 10000);
  },
);
