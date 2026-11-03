import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { executeInSandbox, readMcpEvidence } from "./execution.mjs";

const stateDirectory = resolve(
  process.env.SUPERTAG_EXAMPLE_STATE ?? join(homedir(), ".supertag/examples/shared-organization"),
);

// The generated module runs in the shared sandbox as the workload user. Never
// import it into this host process or inherit the execution service credential.
const source = String.raw`
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const path = "/data/workspace/csv-summary.mjs";
const bytes = await readFile(path);
const { summarizeCsv } = await import(path);
const checks = [];
// Compare the data contract without requiring a particular object prototype.
const equal = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
function check(name, operation) {
  try { operation(); checks.push({ name, passed: true }); }
  catch { checks.push({ name, passed: false }); }
}
check("basic numeric summary", () => equal(summarizeCsv("name,amount\nalpha,2\nbeta,4\n"), {
  rowCount: 2, headers: ["name", "amount"], numeric: { amount: { count: 2, sum: 6, min: 2, max: 4, mean: 3 } },
}));
check("quoted comma and CRLF", () => equal(summarizeCsv('name,value\r\n"a,b",3\r\n'), {
  rowCount: 1, headers: ["name", "value"], numeric: { value: { count: 1, sum: 3, min: 3, max: 3, mean: 3 } },
}));
check("quoted newlines and doubled quotes", () => equal(summarizeCsv('note,n\n"a\nb",1\n"say ""yes""",5'), {
  rowCount: 2, headers: ["note", "n"], numeric: { n: { count: 2, sum: 6, min: 1, max: 5, mean: 3 } },
}));
check("negative fractional and empty values", () => equal(summarizeCsv("n,empty\n-2.5,\n,\n4.5,\n"), {
  rowCount: 3, headers: ["n", "empty"], numeric: { n: { count: 2, sum: 2, min: -2.5, max: 4.5, mean: 1 } },
}));
check("header only", () => equal(summarizeCsv("name,value\n"), {
  rowCount: 0, headers: ["name", "value"], numeric: {},
}));
check("mixed and nonfinite values excluded", () => equal(summarizeCsv("mixed,infinite,blank\n1,Infinity, \nx,2,\n"), {
  rowCount: 2, headers: ["mixed", "infinite", "blank"], numeric: {},
}));
check("overflowing decimal input excluded", () => equal(summarizeCsv("n,valid\n" + "9".repeat(400) + ",2\n1,4"), {
  rowCount: 2, headers: ["n", "valid"], numeric: { valid: { count: 2, sum: 6, min: 2, max: 4, mean: 3 } },
}));
check("special object key preserved as column data", () => equal(summarizeCsv("__proto__\n1\n3"), JSON.parse('{"rowCount":2,"headers":["__proto__"],"numeric":{"__proto__":{"count":2,"sum":4,"min":1,"max":3,"mean":2}}}')));
for (const [name, text] of [
  ["empty input", ""], ["duplicate headers", "a,a\n1,2"], ["empty header", "a,\n1,2"],
  ["inconsistent row length", "a,b\n1"], ["unclosed quote", 'a,b\n"x,2'],
  ["invalid quote suffix", 'a,b\n"x"z,2'],
]) check(name, () => assert.throws(() => summarizeCsv(text), Error));
const digest = createHash("sha256").update(bytes).digest("hex");
check("review identifies the actual file digest", () => {});
let review;
try {
  review = await readFile("/data/workspace/review.md", "utf8");
  checks[checks.length - 1].passed = review.includes(digest);
} catch { checks[checks.length - 1].passed = false; }
check("independent review approves the current source", () => {
  const verdicts = review?.match(/^Verdict:.*$/gim) ?? [];
  assert.equal(verdicts.length, 1);
  assert.match(verdicts[0], /^Verdict:\s*approved\s*$/i);
});
console.log("SUPERTAG_VERIFICATION=" + JSON.stringify({ passed: checks.every((c) => c.passed), checks, digest: "sha256:" + digest }));
`;

try {
  const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
  const stdout = await executeInSandbox(state, source);
  const line = stdout.split("\n").findLast((value) => value.startsWith("SUPERTAG_VERIFICATION="));
  if (!line) throw new Error("Verifier did not return a result");
  const report = JSON.parse(line.slice("SUPERTAG_VERIFICATION=".length));
  if (state.mcp) {
    const rows = await readMcpEvidence(state);
    const probe = rows.filter((row) => row.actor === "probe" && row.committed);
    const nativeClients = [];
    for (const harness of ["claude-code", "codex"]) {
      const reads = rows.filter(
        (row) =>
          row.actor === harness &&
          row.action === "read" &&
          row.text === "INTERRUPTED_HANDOFF" &&
          row.at > (probe[0]?.at ?? ""),
      );
      for (const attemptId of new Set(reads.map((row) => row.attemptId))) {
        const matching = reads.filter((row) => row.attemptId === attemptId);
        nativeClients.push({
          harness,
          taskId: matching[0].taskId,
          attemptId,
          transports: [...new Set(matching.map((row) => row.transport))],
          readAfterProbe: true,
        });
      }
    }
    report.mcp = {
      passed:
        probe.length === 1 &&
        rows.every((row) => !row.forbidden) &&
        ["claude-code", "codex"].every((harness) =>
          nativeClients.some(
            (client) =>
              client.harness === harness &&
              client.transports.includes("stdio") &&
              client.transports.includes("http"),
          ),
        ),
      nativeClients,
    };
    report.passed = report.passed && report.mcp.passed;
  }
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      passed: false,
      checks: [{ name: "load and execute generated module in sandbox", passed: false }],
    }),
  );
  process.exitCode = 1;
}
