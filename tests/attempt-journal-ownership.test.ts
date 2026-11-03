import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAttemptJournal } from "../packages/runtime/sdk/src/index.js";

const directories: string[] = [];
const journals: FileAttemptJournal[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) await journal.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "supertag-journal-owner-"));
  directories.push(path);
  return path;
}
async function owner(path: string, ownership?: string) {
  await writeFile(
    join(path, "owner.lock"),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      ...(ownership === undefined ? {} : { ownership }),
    }),
    { mode: 0o600 },
  );
}
function journal(path: string) {
  const result = new FileAttemptJournal(path);
  journals.push(result);
  return result;
}

describe("Attempt journal supervisor ownership", () => {
  it("shares concurrent initialization without losing its ownership handle", async () => {
    const path = await directory();
    const first = journal(path);
    await Promise.all([first.initialize(), first.initialize()]);
    await expect(journal(path).initialize()).rejects.toThrow("live or unverifiable process");
    await first.close();
    await journal(path).initialize();
  });
  it("serializes lazy reads through the same initialization", async () => {
    const path = await directory();
    const first = journal(path);
    expect(await Promise.all([first.readAll(), first.readAll()])).toEqual([[], []]);
    await first.close();
    await journal(path).initialize();
  });
  it("waits for in-flight initialization before closing and permits later reopening", async () => {
    const path = await directory();
    const first = journal(path);
    const opening = first.initialize();
    const closing = first.close();
    await expect(first.initialize()).rejects.toThrow("closing");
    await Promise.all([opening, closing, first.close()]);
    await first.initialize();
    await first.close();
    await journal(path).initialize();
  });
  it.each([
    "before-guard",
    "guard-linked",
    "before-owner-publish",
    "owner-published",
    "guard-removed",
  ])(
    "recovers after a process is killed during initialization at %s",
    async (stage) => {
      const path = await directory();
      await owner(path, "sqlite");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          resolve(import.meta.dirname, "fixtures/attempt-journal-initializer-crash.ts"),
          path,
          stage,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let errors = "";
      child.stderr?.on("data", (data: Buffer) => {
        errors += data.toString();
      });
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Initializer did not pause: ${errors}`)),
            10_000,
          );
          child.once("message", (message) => {
            clearTimeout(timer);
            if ((message as { stage?: string }).stage === stage) resolveReady();
            else reject(new Error("Unexpected initialization sessionState"));
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`Initializer exited before sessionState: ${errors}`));
          });
          child.once("error", reject);
        });
        // A second supervisor cannot reclaim the guard while the initializer owns SQLite.
        await expect(journal(path).initialize()).rejects.toThrow("live or unverifiable process");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await journal(path).initialize();
      expect(JSON.parse(await readFile(join(path, "owner.lock"), "utf8"))).toMatchObject({
        pid: process.pid,
        ownership: "sqlite",
      });
      await expect(lstat(join(path, "acquiring.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    15_000,
  );
  it("preserves unverifiable legacy directory guards", async () => {
    const path = await directory();
    await mkdir(join(path, "acquiring.lock"), { mode: 0o700 });
    await expect(journal(path).initialize()).rejects.toThrow("guard cannot be verified");
    expect((await lstat(join(path, "acquiring.lock"))).isDirectory()).toBe(true);
  });
  it("does not reclaim unrelated files or symlinks as modern guards", async () => {
    for (const kind of ["file", "symlink"]) {
      const path = await directory();
      const target = join(path, "unrelated");
      await writeFile(target, "preserved", { mode: 0o600 });
      if (kind === "file")
        await writeFile(join(path, "acquiring.lock"), "preserved", { mode: 0o600 });
      else await symlink(target, join(path, "acquiring.lock"));
      await expect(journal(path).initialize()).rejects.toThrow("guard cannot be verified");
      expect(await readFile(join(path, "acquiring.lock"), "utf8")).toBe("preserved");
    }
  });
  it("recovers an unlocked modern journal even when the old PID was reused", async () => {
    const path = await directory();
    await owner(path, "sqlite");
    await journal(path).initialize();
    expect(JSON.parse(await readFile(join(path, "owner.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
      ownership: "sqlite",
    });
  });
  it("rejects another live owner even when its metadata looks stale", async () => {
    const path = await directory();
    await journal(path).initialize();
    // Metadata is not proof of owner liveness: a separate namespace may see another PID.
    await writeFile(
      join(path, "owner.lock"),
      JSON.stringify({ pid: 2147483647, host: hostname(), ownership: "sqlite" }),
    );
    await expect(journal(path).initialize()).rejects.toThrow("live or unverifiable process");
  });
  it.each(["live", "absent"])(
    "rejects a legacy lock when its PID is %s without probing it",
    async (state) => {
      const path = await directory();
      await owner(path);
      const ownerPath = join(path, "owner.lock");
      const original = await readFile(ownerPath, "utf8");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        if (state === "absent")
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        return true;
      });
      const refused = journal(path);
      await expect(refused.initialize()).rejects.toThrow("live or unverifiable process");
      await refused.close();
      expect(kill).not.toHaveBeenCalled();
      expect(await readFile(ownerPath, "utf8")).toBe(original);
      await expect(lstat(join(path, "attempts.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
      // Releasing SQLite ownership after refusal must not make the legacy lock adoptable.
      await expect(journal(path).initialize()).rejects.toThrow("live or unverifiable process");
      expect(await readFile(ownerPath, "utf8")).toBe(original);
    },
  );
  it("rejects unknown ownership protocols without deleting their records", async () => {
    const path = await directory();
    await owner(path, "future-protocol");
    await expect(journal(path).initialize()).rejects.toThrow("Unknown journal ownership protocol");
    expect(JSON.parse(await readFile(join(path, "owner.lock"), "utf8"))).toHaveProperty(
      "ownership",
      "future-protocol",
    );
  });
  it("rejects symlinks before opening the ownership database", async () => {
    const path = await directory();
    const outside = join(await directory(), "outside.sqlite");
    await writeFile(outside, "untouched");
    await symlink(outside, join(path, "owner.sqlite"));
    await expect(journal(path).initialize()).rejects.toThrow("Unsafe journal ownership database");
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
  it("releases kernel ownership after an unverifiable owner prevents initialization", async () => {
    const path = await directory();
    await writeFile(
      join(path, "owner.lock"),
      JSON.stringify({ pid: process.pid, host: "another-host", ownership: "sqlite" }),
      { mode: 0o600 },
    );
    await expect(journal(path).initialize()).rejects.toThrow("owner cannot be verified");
    expect(JSON.parse(await readFile(join(path, "owner.lock"), "utf8")).host).toBe("another-host");
    await owner(path, "sqlite");
    await journal(path).initialize();
  });
  it("releases kernel ownership when opening the event journal fails", async () => {
    const path = await directory();
    const outside = join(await directory(), "outside.sqlite");
    await writeFile(outside, "preserved");
    await symlink(outside, join(path, "attempts.sqlite"));
    await expect(journal(path).initialize()).rejects.toThrow("Unsafe attempt journal database");
    expect(await readFile(outside, "utf8")).toBe("preserved");
    await rm(join(path, "attempts.sqlite"));
    await journal(path).initialize();
  });
  it("releases the ownership lock after closing the journal", async () => {
    const path = await directory();
    const first = journal(path);
    await first.initialize();
    await first.close();
    await journal(path).initialize();
  });
});
