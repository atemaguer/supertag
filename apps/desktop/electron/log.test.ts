import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FileLog, guardStdio, logLine } from "./log";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "supertag-log-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("drops a closed stdout's EPIPE instead of throwing it", () => {
  // A stream with no error listener throws what it emits, as a closed pipe's does in the app.
  const stdout = new EventEmitter();
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  expect(() => stdout.emit("error", epipe)).toThrow("EPIPE");
  guardStdio([stdout]);
  expect(() => stdout.emit("error", epipe)).not.toThrow();
});

it("writes log lines to its file, with an error's stack", async () => {
  const file = path.join(dir, "logs", "main.log");
  const echoed: string[] = [];
  const log = new FileLog(file, (line) => echoed.push(line));
  log.warn("The update failed (installing):", new Error("Could not get code signature"));
  const written = await readFile(file, "utf8");
  expect(written).toMatch(
    /^\d{4}-\d\d-\d\dT[\d:.]+Z warn The update failed \(installing\): Error: /u,
  );
  expect(written).toContain("Could not get code signature");
  expect(echoed).toEqual([written]);
  expect(logLine("info", ["a", 1], new Date(0))).toBe("1970-01-01T00:00:00.000Z info a 1\n");
});

it("never throws, with nowhere to write and a closed stderr", async () => {
  const blocker = path.join(dir, "not-a-directory");
  await writeFile(blocker, "");
  const log = new FileLog(path.join(blocker, "main.log"), () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  });
  expect(() => log.error("still running")).not.toThrow();
  expect(() => log.info("and again")).not.toThrow();
});
