import { expect, it } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.ts";
import { type ExecutionEnvironmentSpec, LocalExecutionEnvironmentProvider } from "./src/index.ts";
import { ProcessInputWriter } from "./src/process-supervision.ts";

const spec: ExecutionEnvironmentSpec = {
  task: repositoryAttempt("stdio"),
  profile: {
    ref: { id: "test", revision: "1" },
    workerType: "test",
    harness: { provider: "test" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
  },
  plan: {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  },
};
it("exchanges multiple requests before EOF through an environment-owned real process", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  try {
    await expect(
      env.spawn({ command: process.execPath, streamInput: true, stdin: "" }),
    ).rejects.toThrow("not both");
    const handle = await env.spawn({
      command: process.execPath,
      args: [
        "-e",
        "const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>console.log('response:'+line));",
      ],
      streamInput: true,
      streamOutput: true,
    });
    if (!handle.write || !handle.endInput || !handle.output)
      throw new Error("Missing duplex input");
    const output = handle.output[Symbol.asyncIterator]();
    await handle.write(new TextEncoder().encode("one\n"));
    expect((await output.next()).value?.text).toBe("response:one\n");
    await handle.write(new TextEncoder().encode("two\n"));
    expect((await output.next()).value?.text).toBe("response:two\n");
    await handle.endInput();
    expect((await handle.wait()).exitCode).toBe(0);
    await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
    expect((await output.next()).done).toBe(true);
  } finally {
    await env.dispose("completed");
  }
});
it("serializes snapshots and EOF, rejects queue overflow, and revokes blocked writes", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const values: number[] = [];
  let ended = false;
  const writer = new ProcessInputWriter({
    write: async (bytes) => {
      values.push(bytes[0] ?? 0);
      await blocked;
    },
    end: async () => {
      ended = true;
    },
  });
  const bytes = new Uint8Array([1]);
  const first = writer.write(bytes);
  bytes[0] = 99;
  const second = writer.write(new Uint8Array([2]));
  const end = writer.end();
  await expect(writer.write(new Uint8Array([3]))).rejects.toThrow("closed");
  await Promise.resolve();
  expect(values).toEqual([1]);
  expect(ended).toBe(false);
  release();
  await Promise.all([first, second, end]);
  expect(values).toEqual([1, 2]);
  expect(ended).toBe(true);
  const blockedWriter = new ProcessInputWriter({
    write: () => new Promise(() => {}),
    end: async () => {},
  });
  const pending = blockedWriter.write(new Uint8Array(1024 * 1024));
  await expect(blockedWriter.write(new Uint8Array([1]))).rejects.toThrow("bounded queue");
  const rejected = expect(pending).rejects.toThrow("stopped");
  blockedWriter.revoke(new Error("stopped"));
  await rejected;
});
it("revokes process input when its environment is disposed", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const handle = await env.spawn({
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    streamInput: true,
  });
  if (!handle.write) throw new Error("Missing write");
  await env.dispose("cancelled");
  await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
});
