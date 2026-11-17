import { execFileSync, spawnSync } from "node:child_process";
import { PROCESS_SEAL_PROGRAMS } from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { afterEach, expect, it } from "vitest";

// The record and seal programs, run for real in a throwaway Linux container: they kill every
// process they did not record, so they never run on the test machine itself. Skipped where no
// container runtime answers (set SUPERTAG_TEST_REQUIRE_CONTAINER=1 to fail instead).
const IMAGE = process.env["SUPERTAG_TEST_SEAL_IMAGE"] ?? "python:3.13-slim-bookworm";
const runtime = process.env["SUPERTAG_TEST_CONTAINER_RUNTIME"] ?? "docker";
const available =
  spawnSync(runtime, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0 &&
  (spawnSync(runtime, ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0 ||
    spawnSync(runtime, ["pull", "-q", IMAGE], { stdio: "ignore", timeout: 300_000 }).status === 0);
if (!available && process.env["SUPERTAG_TEST_REQUIRE_CONTAINER"] === "1")
  throw new Error(`${runtime} with ${IMAGE} is required for the real seal tests`);

const containers: string[] = [];
afterEach(() => {
  for (const id of containers.splice(0)) spawnSync(runtime, ["rm", "-f", id], { stdio: "ignore" });
});

function start(...flags: string[]): string {
  const id = execFileSync(runtime, ["run", "-d", "--init", ...flags, IMAGE, "sleep", "600"], {
    encoding: "utf8",
  }).trim();
  containers.push(id);
  return id;
}
function exec(id: string, argv: string[], user = "root") {
  return spawnSync(runtime, ["exec", "-u", user, id, ...argv], {
    encoding: "utf8",
    timeout: 60_000,
  });
}
const clean = ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"];
function record(id: string) {
  const result = exec(id, [...clean, "python3", "-I", "-S", "-c", PROCESS_SEAL_PROGRAMS.record]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { interpreter: string; processes: [number, string][] };
}
function seal(id: string, recorded: ReturnType<typeof record>, then: string[] = []) {
  const { interpreter, processes } = recorded;
  return exec(id, [
    ...clean,
    interpreter,
    "-I",
    "-S",
    "-c",
    PROCESS_SEAL_PROGRAMS.seal,
    JSON.stringify(processes),
    ...(then.length ? [interpreter, "-I", "-S", "-c", ...then] : []),
  ]);
}
function processes(id: string): string[] {
  // Plain shell, so it still works after a test replaces the Python interpreter.
  const listed = exec(id, [
    "sh",
    "-c",
    "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done",
  ]);
  return listed.stdout.split("\n").filter(Boolean);
}

it.skipIf(!available)(
  "stops every process a Task left, then runs Capture in the same process",
  () => {
    const id = start();
    const recorded = record(id);
    expect(recorded.processes.some(([pid]) => pid === 1)).toBe(true);
    // Leftovers: nohup, a setsid daemon, another user's process, and a fork loop.
    exec(id, [
      "sh",
      "-c",
      [
        "nohup sleep 900 >/dev/null 2>&1 &",
        "(setsid sh -c 'while true; do sleep 1; done' >/dev/null 2>&1 &)",
        "setpriv --reuid=65534 --regid=65534 --clear-groups sleep 901 &",
        // A parent that keeps forking long-lived children while the seal runs.
        `python3 -c "import os,time\nfor _ in range(100):\n  if os.fork() == 0:\n    time.sleep(900); os._exit(0)\n  time.sleep(0.2)" >/dev/null 2>&1 &`,
        "sleep 1",
      ].join("\n"),
    ]);
    expect(processes(id).some((line) => line.includes("sleep 900"))).toBe(true);
    const result = seal(id, recorded, ["print('captured after the seal')"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^sealed [1-9][0-9]*\ncaptured after the seal\n$/u);
    const left = processes(id);
    for (const leftover of ["sleep 900", "while true", "sleep 901", "os.fork"])
      expect(
        left.some((line) => line.includes(leftover)),
        left.join("\n"),
      ).toBe(false);
    expect(left.some((line) => line.includes("sleep 600"))).toBe(true);
  },
  120_000,
);

it.skipIf(!available)(
  "fails closed when a process's /proc entry, or /proc itself, is hidden by a mount",
  () => {
    const id = start("--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined");
    const recorded = record(id);
    const hidden = exec(id, [
      "sh",
      "-c",
      "sleep 900 >/dev/null 2>&1 & pid=$!; mount -t tmpfs none /proc/$pid && echo $pid",
    ]);
    expect(hidden.status, hidden.stderr).toBe(0);
    const entry = seal(id, recorded, ["print('captured')"]);
    expect(entry.status).toBe(6);
    expect(entry.stdout).not.toContain("captured");
    exec(id, ["umount", `/proc/${hidden.stdout.trim()}`]);
    exec(id, ["mount", "-t", "tmpfs", "none", "/proc"]);
    const whole = seal(id, recorded, ["print('captured')"]);
    expect(whole.status).not.toBe(0);
    expect(whole.stdout).not.toContain("captured");
  },
  120_000,
);

it.skipIf(!available)(
  "is a reliability property, not a boundary, where the Task is root: it can replace the interpreter",
  () => {
    const id = start();
    const recorded = record(id);
    // A root Task swaps the recorded interpreter for one that only claims to seal.
    exec(id, [
      "sh",
      "-c",
      `nohup sleep 900 >/dev/null 2>&1 & cp ${recorded.interpreter} /tmp/real && printf '#!/bin/sh\\necho "sealed 0"\\n' > ${recorded.interpreter}`,
    ]);
    const result = seal(id, recorded);
    expect(result.stdout).toBe("sealed 0\n");
    expect(processes(id).some((line) => line.includes("sleep 900"))).toBe(true);
  },
  120_000,
);
