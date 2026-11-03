// Pure logic behind `pnpm test:verify`: run the full suite once, then rerun each failing
// test file alone with a longer timeout. The command fails only when a rerun fails, so
// load-sensitive timeouts in a busy full run do not fail verification on their own.
import { isAbsolute, relative } from "node:path";

export const FULL_RUN_ARGS = Object.freeze(["run", "--maxWorkers=2"]);
export const RERUN_TIMEOUT_MS = 60_000;

/** Arguments for rerunning one test file alone with a longer test and hook timeout. */
export function rerunArgs(file, timeoutMs = RERUN_TIMEOUT_MS) {
  return [
    "run",
    file,
    "--maxWorkers=1",
    `--testTimeout=${timeoutMs}`,
    `--hookTimeout=${timeoutMs}`,
  ];
}

/**
 * Test files the vitest JSON report marks as failed, relative to root and sorted.
 * Returns null when the report is missing or malformed, because failures cannot be attributed.
 */
export function failedTestFiles(report, root) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) return null;
  const files = new Set();
  for (const result of report.testResults) {
    if (!result || typeof result.name !== "string") return null;
    if (result.status !== "failed") continue;
    files.add(isAbsolute(result.name) ? relative(root, result.name) : result.name);
  }
  return [...files].sort();
}

/**
 * Why a failed full run cannot be explained by failing test files alone, or null.
 * runErrors is { reason, unhandledErrors } from scripts/test-verify-reporter.mjs; a missing
 * record counts as unexplained, because errors outside test files could not be checked.
 */
export function unexplainedFailure(runErrors) {
  if (!runErrors || typeof runErrors !== "object" || !Array.isArray(runErrors.unhandledErrors)) {
    return "the full run recorded no error summary, so errors outside test files cannot be ruled out";
  }
  if (runErrors.unhandledErrors.length > 0) {
    return `the full run had ${runErrors.unhandledErrors.length} unhandled error(s) outside test results`;
  }
  if (runErrors.reason && runErrors.reason !== "passed" && runErrors.reason !== "failed") {
    return `the full run ended as ${runErrors.reason}`;
  }
  return null;
}

/**
 * Runs the full suite, then reruns each failing file alone.
 * runSuite() resolves to { exitCode, report, runErrors }; runFile(file) resolves to an exit code.
 * A non-zero full run passes only when failing files fully explain it and each passes alone.
 * Resolves to { exitCode, failedFiles, reruns }.
 */
export async function verifyTestSuite({ root, runSuite, runFile, log = () => {} }) {
  const full = await runSuite();
  const failedFiles = failedTestFiles(full.report, root);
  if (failedFiles === null) {
    log("test:verify: the full run produced no readable report; failures cannot be rerun.");
    return { exitCode: full.exitCode === 0 ? 1 : full.exitCode, failedFiles: [], reruns: [] };
  }
  if (failedFiles.length === 0) {
    if (full.exitCode !== 0) {
      // Every file passed, but vitest still failed, for example on an unhandled error.
      log(`test:verify: no test file failed, but the full run exited ${full.exitCode}.`);
      return { exitCode: full.exitCode, failedFiles, reruns: [] };
    }
    log("test:verify: the full run passed.");
    return { exitCode: 0, failedFiles, reruns: [] };
  }

  const unexplained = full.exitCode === 0 ? null : unexplainedFailure(full.runErrors);
  if (unexplained !== null) {
    log(`test:verify: ${unexplained}; the full run exited ${full.exitCode}.`);
    for (const error of full.runErrors?.unhandledErrors ?? []) log(`  ${error}`);
    return { exitCode: full.exitCode, failedFiles, reruns: [] };
  }

  log(`test:verify: rerunning ${failedFiles.length} failing file(s) one at a time:`);
  for (const file of failedFiles) log(`  ${file}`);
  const reruns = [];
  for (const file of failedFiles) {
    const exitCode = await runFile(file);
    reruns.push({ file, passed: exitCode === 0, exitCode });
  }

  log("test:verify: rerun summary:");
  for (const rerun of reruns) log(`  ${rerun.passed ? "passed" : "FAILED"}  ${rerun.file}`);
  const stillFailing = reruns.filter((rerun) => !rerun.passed);
  if (stillFailing.length > 0) {
    log(`test:verify: ${stillFailing.length} file(s) failed again when run alone.`);
    return { exitCode: 1, failedFiles, reruns };
  }
  log("test:verify: every failing file passed when run alone.");
  return { exitCode: 0, failedFiles, reruns };
}
