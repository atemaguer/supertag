// `pnpm test:verify`: runs the full vitest suite, then reruns each failing file alone with
// --maxWorkers=1 and a 60-second timeout. Exits non-zero only if a rerun fails (or the full
// run fails in a way no file accounts for). See scripts/test-verify-lib.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FULL_RUN_ARGS, rerunArgs, verifyTestSuite } from "./test-verify-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules/vitest/vitest.mjs");

function runVitest(args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [vitest, ...args], { cwd: root, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

const scratch = mkdtempSync(join(tmpdir(), "supertag-test-verify-"));
const reportPath = join(scratch, "report.json");
const errorsPath = join(scratch, "run-errors.json");
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
try {
  const result = await verifyTestSuite({
    root,
    async runSuite() {
      const exitCode = await runVitest(
        [
          ...FULL_RUN_ARGS,
          "--reporter=default",
          "--reporter=json",
          `--reporter=${join(root, "scripts/test-verify-reporter.mjs")}`,
          `--outputFile.json=${reportPath}`,
        ],
        { ...process.env, SUPERTAG_TEST_VERIFY_ERRORS_FILE: errorsPath },
      );
      return { exitCode, report: readJson(reportPath), runErrors: readJson(errorsPath) };
    },
    runFile: (file) => runVitest(rerunArgs(file)),
    log: (line) => console.log(line),
  });
  process.exitCode = result.exitCode;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
