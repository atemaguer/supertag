import { createProcessSeal } from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { expect, it, vi } from "vitest";

// The programs never run here: they kill every process they did not record. These cases cover
// what the provider accepts from them. The programs themselves run in sandboxes only (the live
// Modal suite and the operator's container check).

const signal = new AbortController().signal;

it("seals only after recording the sandbox's own processes, with that exact record", async () => {
  const run = vi.fn(async (argv: string[]) =>
    argv.length > 5
      ? { exitCode: 0, stdout: "sealed 3\n" }
      : { exitCode: 0, stdout: '[[1,"10"],[7,"12"]]\n' },
  );
  const seal = createProcessSeal(run);
  await expect(seal.seal(signal)).resolves.toBe(false);
  expect(run).not.toHaveBeenCalled();
  await seal.record(signal);
  await expect(seal.record(signal)).rejects.toThrow(/already/);
  await expect(seal.seal(signal)).resolves.toBe(true);
  expect(JSON.parse(run.mock.calls[1]?.[0].at(-1) ?? "")).toEqual([
    [1, "10"],
    [7, "12"],
  ]);
});

it("refuses a record that does not look like a sandbox", async () => {
  for (const stdout of [
    "[]",
    '[[7,"12"]]',
    JSON.stringify(Array.from({ length: 257 }, (_, index) => [index + 1, "1"])),
    '[[1,"x"]]',
    "not json",
  ]) {
    const seal = createProcessSeal(async () => ({ exitCode: 0, stdout }));
    await expect(seal.record(signal)).rejects.toThrow(/recorded/);
    await expect(seal.seal(signal)).resolves.toBe(false);
  }
});

it("reports a seal that failed, printed something else, or could not run", async () => {
  for (const result of [
    { exitCode: 4, stdout: "" },
    { exitCode: 0, stdout: "sealed\n" },
    new Error("sandbox unreachable"),
  ]) {
    const seal = createProcessSeal(async (argv) => {
      if (argv.length <= 5) return { exitCode: 0, stdout: '[[1,"1"]]' };
      if (result instanceof Error) throw result;
      return result;
    });
    await seal.record(signal);
    await expect(seal.seal(signal)).resolves.toBe(false);
  }
});
