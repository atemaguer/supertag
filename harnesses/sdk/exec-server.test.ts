import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createExecServer,
  EXEC_SERVER_PROGRAM,
} from "./src/rust-workspace-provider/exec-server.js";

const servers: ReturnType<typeof createExecServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The real server program, on this machine, as a provider would run it in a sandbox. */
function local() {
  let starts = 0;
  const server = createExecServer(() => {
    starts += 1;
    return spawn("python3", ["-I", "-S", "-c", EXEC_SERVER_PROGRAM], { stdio: "pipe" });
  });
  servers.push(server);
  return { server, starts: () => starts };
}

async function run(
  server: ReturnType<typeof createExecServer>,
  request: Parameters<ReturnType<typeof createExecServer>["spawn"]>[0],
) {
  let stdout = "";
  let stderr = "";
  const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const process = await server.spawn(request, (stream, bytes) => {
    const text = decoder[stream].decode(bytes, { stream: true });
    if (stream === "stdout") stdout += text;
    else stderr += text;
  });
  if (!process) throw new Error("no server");
  return { process, done: process.exited.then((exitCode) => ({ exitCode, stdout, stderr })) };
}

it("runs commands with their input, directory, and environment, and reports how they exit", async () => {
  const { server, starts } = local();
  const echoed = await run(server, {
    argv: ["sh", "-c", 'cat; echo "$PWD $GREETING"; echo oops >&2; exit 3'],
    cwd: "/",
    environment: { GREETING: "hello" },
    stdin: new TextEncoder().encode("piped\n"),
  });
  expect(await echoed.done).toEqual({ exitCode: 3, stdout: "piped\n/ hello\n", stderr: "oops\n" });
  // A replaced environment holds exactly what was given.
  const bare = await run(server, {
    argv: ["/usr/bin/env"],
    environment: { ONLY: "this" },
    replaceEnvironment: true,
  });
  expect((await bare.done).stdout).toBe("ONLY=this\n");
  // A command that cannot run exits as a runtime exec reports it.
  const missing = await run(server, { argv: ["/no/such/program"] });
  expect(await missing.done).toMatchObject({ exitCode: 127 });
  // One server served every request.
  expect(starts()).toBe(1);
});

it("streams input and output, kills a process group, and runs requests at once", async () => {
  const { server } = local();
  const streaming = await run(server, { argv: ["cat"], streamInput: true });
  await streaming.process.write(new TextEncoder().encode("one "));
  await streaming.process.write(new TextEncoder().encode("two"));
  streaming.process.endInput();
  expect(await streaming.done).toMatchObject({ exitCode: 0, stdout: "one two" });
  // A kill reaches the whole group, the shell's child included; SIGKILL exits 137.
  const sleeper = await run(server, { argv: ["sh", "-c", "sleep 60 & wait"] });
  const started = Date.now();
  sleeper.process.kill();
  expect((await sleeper.done).exitCode).toBe(137);
  expect(Date.now() - started).toBeLessThan(5_000);
  const parallel = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      run(server, { argv: ["sh", "-c", `sleep 0.2; echo ${index}`] }).then(({ done }) => done),
    ),
  );
  expect(parallel.map(({ stdout }) => stdout.trim())).toEqual(
    Array.from({ length: 20 }, (_, index) => String(index)),
  );
  // Large output arrives whole.
  const large = await run(server, { argv: ["python3", "-c", "print('x' * 3_000_000)"] });
  expect((await large.done).stdout.length).toBe(3_000_001);
}, 30_000);

it("starts another server after one stops, fails what was running then, and never reruns it", async () => {
  const { server, starts } = local();
  const marks = await mkdtemp(join(tmpdir(), "exec-server-"));
  // The command stops its server at once, before or after the server reports it started, and
  // later; either way it ends without an exit code and runs exactly once.
  for (const [index, delay] of ["0", "0.3"].entries()) {
    const mark = join(marks, `ran-${index}`);
    const running = await run(server, {
      argv: ["sh", "-c", `echo ran >> ${mark}; sleep ${delay}; kill -9 $PPID; sleep 30`],
    });
    expect((await running.done).exitCode).toBeNull();
    expect(await readFile(mark, "utf8")).toBe("ran\n");
    const next = await run(server, { argv: ["echo", "again"] });
    expect(await next.done).toMatchObject({ exitCode: 0, stdout: "again\n" });
    expect(starts()).toBe(index + 2);
  }
  await rm(marks, { recursive: true, force: true });
});

it("starts another server after a reset, as after a seal stopped the last", async () => {
  const { server, starts } = local();
  expect(await (await run(server, { argv: ["echo", "one"] })).done).toMatchObject({
    stdout: "one\n",
  });
  server.reset();
  expect(await (await run(server, { argv: ["echo", "two"] })).done).toMatchObject({
    stdout: "two\n",
  });
  expect(starts()).toBe(2);
});

it("resolves undefined when no server can start, so the caller runs the command itself", async () => {
  const server = createExecServer(() =>
    spawn("python3", ["-I", "-S", "-c", "import sys; sys.exit(1)"], { stdio: "pipe" }),
  );
  servers.push(server);
  expect(await server.spawn({ argv: ["true"] }, () => {})).toBeUndefined();
});
