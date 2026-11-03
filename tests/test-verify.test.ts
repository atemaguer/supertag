import { describe, expect, it } from "vitest";
import {
  FULL_RUN_ARGS,
  failedTestFiles,
  rerunArgs,
  unexplainedFailure,
  verifyTestSuite,
} from "../scripts/test-verify-lib.mjs";

const root = "/repo";

function report(results: Array<[string, string]>) {
  return { testResults: results.map(([name, status]) => ({ name, status })) };
}

const clean = { reason: "failed", unhandledErrors: [] };

function harness(
  suite: { exitCode: number; report: unknown; runErrors?: unknown },
  rerunCodes: Record<string, number>,
) {
  const reran: string[] = [];
  const lines: string[] = [];
  return {
    reran,
    lines,
    options: {
      root,
      runSuite: async () => suite,
      runFile: async (file: string) => {
        reran.push(file);
        return rerunCodes[file] ?? 0;
      },
      log: (line: string) => lines.push(line),
    },
  };
}

describe("test:verify rerun logic", () => {
  it("runs the full suite with two workers and reruns one file alone with a longer timeout", () => {
    expect(FULL_RUN_ARGS).toEqual(["run", "--maxWorkers=2"]);
    expect(rerunArgs("tests/a.test.ts")).toEqual([
      "run",
      "tests/a.test.ts",
      "--maxWorkers=1",
      "--testTimeout=60000",
      "--hookTimeout=60000",
    ]);
  });

  it("lists failed files relative to the root, sorted and without duplicates", () => {
    const files = failedTestFiles(
      report([
        ["/repo/tests/b.test.ts", "failed"],
        ["/repo/tests/a.test.ts", "passed"],
        ["/repo/packages/x/c.test.ts", "failed"],
        ["/repo/tests/b.test.ts", "failed"],
        ["/repo/tests/d.test.ts", "skipped"],
      ]),
      root,
    );
    expect(files).toEqual(["packages/x/c.test.ts", "tests/b.test.ts"]);
  });

  it("treats a missing or malformed report as unreadable", () => {
    expect(failedTestFiles(null, root)).toBeNull();
    expect(failedTestFiles({}, root)).toBeNull();
    expect(failedTestFiles({ testResults: [{ status: "failed" }] }, root)).toBeNull();
  });

  it("passes without reruns when the full run passes", async () => {
    const run = harness({ exitCode: 0, report: report([["/repo/tests/a.test.ts", "passed"]]) }, {});
    await expect(verifyTestSuite(run.options)).resolves.toMatchObject({ exitCode: 0, reruns: [] });
    expect(run.reran).toEqual([]);
  });

  it("passes when every failing file passes alone", async () => {
    const run = harness(
      {
        exitCode: 1,
        report: report([
          ["/repo/tests/a.test.ts", "failed"],
          ["/repo/tests/b.test.ts", "failed"],
        ]),
        runErrors: clean,
      },
      {},
    );
    const result = await verifyTestSuite(run.options);
    expect(result.exitCode).toBe(0);
    expect(run.reran).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
    expect(run.lines).toContain("  passed  tests/b.test.ts");
  });

  it("fails when any rerun fails, after rerunning every failing file", async () => {
    const run = harness(
      {
        exitCode: 1,
        report: report([
          ["/repo/tests/a.test.ts", "failed"],
          ["/repo/tests/b.test.ts", "failed"],
        ]),
        runErrors: clean,
      },
      { "tests/a.test.ts": 1 },
    );
    const result = await verifyTestSuite(run.options);
    expect(result.exitCode).toBe(1);
    expect(run.reran).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
    expect(result.reruns).toEqual([
      { file: "tests/a.test.ts", passed: false, exitCode: 1 },
      { file: "tests/b.test.ts", passed: true, exitCode: 0 },
    ]);
    expect(run.lines).toContain("  FAILED  tests/a.test.ts");
  });

  it("fails when the full run fails without a failing file or without a report", async () => {
    const unhandled = harness(
      { exitCode: 1, report: report([["/repo/tests/a.test.ts", "passed"]]) },
      {},
    );
    await expect(verifyTestSuite(unhandled.options)).resolves.toMatchObject({ exitCode: 1 });
    expect(unhandled.reran).toEqual([]);

    const crashed = harness({ exitCode: 0, report: null }, {});
    await expect(verifyTestSuite(crashed.options)).resolves.toMatchObject({ exitCode: 1 });
    expect(crashed.reran).toEqual([]);
  });

  it("treats unhandled errors, an aborted run, or a missing error summary as unexplained", () => {
    expect(unexplainedFailure(clean)).toBeNull();
    expect(unexplainedFailure({ reason: "passed", unhandledErrors: [] })).toBeNull();
    expect(unexplainedFailure({ reason: "failed", unhandledErrors: ["boom"] })).toMatch(
      /1 unhandled/,
    );
    expect(unexplainedFailure({ reason: "interrupted", unhandledErrors: [] })).toMatch(
      /interrupted/,
    );
    expect(unexplainedFailure(null)).toMatch(/no error summary/);
  });

  it("fails without rerunning when failed files coexist with an unhandled error", async () => {
    const run = harness(
      {
        exitCode: 1,
        report: report([["/repo/tests/a.test.ts", "failed"]]),
        runErrors: { reason: "failed", unhandledErrors: ["Error: leaked rejection"] },
      },
      {},
    );
    await expect(verifyTestSuite(run.options)).resolves.toMatchObject({ exitCode: 1, reruns: [] });
    expect(run.reran).toEqual([]);
    expect(run.lines).toContain("  Error: leaked rejection");
  });

  it("fails without rerunning when the full run left no error summary", async () => {
    const run = harness({ exitCode: 1, report: report([["/repo/tests/a.test.ts", "failed"]]) }, {});
    await expect(verifyTestSuite(run.options)).resolves.toMatchObject({ exitCode: 1, reruns: [] });
    expect(run.reran).toEqual([]);
  });
});
