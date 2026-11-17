import { createProcessSeal } from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { expect, it, vi } from "vitest";

// The programs never run here: they kill every process they did not record. These cases cover
// what the provider accepts from them; process-seal.container.test.ts runs them for real.

const signal = new AbortController().signal;
const recordOutput = (processes: unknown, interpreter: unknown = "/usr/bin/python3") =>
  `${JSON.stringify({ interpreter, processes })}\n`;

it("seals only after recording, with the exact record and interpreter, then runs the rest", async () => {
  const run = vi.fn(async (argv: string[]) =>
    argv.some((value) => value.includes("sealed %d"))
      ? { exitCode: 0, stdout: "sealed 3\nreceipt\n" }
      : {
          exitCode: 0,
          stdout: recordOutput([
            [1, "10"],
            [7, "12"],
          ]),
        },
  );
  const seal = createProcessSeal(run);
  await expect(seal.sealThen([], 1000, signal)).resolves.toMatchObject({ sealed: false });
  expect(run).not.toHaveBeenCalled();
  await seal.record(signal);
  await expect(seal.record(signal)).rejects.toThrow(/already/);
  const sealed = await seal.sealThen(["print(1)", "capture"], 1000, signal);
  expect(sealed).toEqual({ sealed: true, exitCode: 0, stdout: "receipt\n" });
  const argv = run.mock.calls[1]?.[0] ?? [];
  // A clean environment and the recorded interpreter, never a login shell or a PATH lookup.
  expect(argv.slice(0, 5)).toEqual([
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    "/usr/bin/python3",
  ]);
  expect(argv).toContain(
    JSON.stringify([
      [1, "10"],
      [7, "12"],
    ]),
  );
  expect(argv.slice(-6)).toEqual(["/usr/bin/python3", "-I", "-S", "-c", "print(1)", "capture"]);
});

it("refuses a record that does not look like a sandbox", async () => {
  for (const stdout of [
    recordOutput([]),
    recordOutput([[7, "12"]]),
    recordOutput(Array.from({ length: 257 }, (_, index) => [index + 1, "1"])),
    recordOutput([[1, "x"]]),
    recordOutput([[1, "1"]], "python3"),
    recordOutput([[1, "1"]], "/usr/../tmp/python3"),
    "not json",
  ]) {
    const seal = createProcessSeal(async () => ({ exitCode: 0, stdout }));
    await expect(seal.record(signal)).rejects.toThrow(/recorded/);
    await expect(seal.sealThen([], 1000, signal)).resolves.toMatchObject({ sealed: false });
  }
});

it("reports a seal that failed, printed something else, or could not run", async () => {
  for (const result of [
    { exitCode: 4, stdout: "" },
    { exitCode: 0, stdout: "sealed\n" },
    new Error("sandbox unreachable"),
  ]) {
    const seal = createProcessSeal(async (argv) => {
      if (!argv.some((value) => value.includes("sealed %d")))
        return { exitCode: 0, stdout: recordOutput([[1, "1"]]) };
      if (result instanceof Error) throw result;
      return result;
    });
    await seal.record(signal);
    await expect(seal.sealThen([], 1000, signal)).resolves.toMatchObject({ sealed: false });
  }
});
