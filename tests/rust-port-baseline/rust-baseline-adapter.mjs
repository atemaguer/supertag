/**
 * Deterministic baseline harness for the Rust Worker Host. It uses only the public
 * `supertag-ai/harness` entry point (built `dist/`), never Control Plane internals.
 *
 * Arguments: --mode=complete|hold|produce|review --record=ABSOLUTE_FILE [--revision=SHA]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const { openHarness } = await import(
  new URL("../../packages/supertag-ai/dist/harness.js", import.meta.url).href
);

const option = (name) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = option("mode") ?? "complete";
const record = option("record");
if (!record) throw new Error("The baseline adapter requires --record");

const gitWith = (input, ...args) =>
  execFileSync("/usr/bin/git", args, {
    encoding: "utf8",
    input,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const git = (...args) => gitWith(undefined, ...args);

const harness = await openHarness(process.stdin);
const run = await harness.client.attach({});
const task = run.task;
if (!task) throw new Error("The Worker Host supplied no Task");
const note = (event, extra = {}) =>
  appendFileSync(
    record,
    `${JSON.stringify({ event, taskId: task.taskId, pid: process.pid, cwd: process.cwd(), ...extra })}\n`,
  );
note("started", { allowedActions: [...task.allowedActions] });

let sequence = 0n;
const publish = (text) => harness.client.publish({ sequence: ++sequence, text });
await publish("execution started");

let result = "Baseline complete";
if (mode === "hold") {
  // Stay running until the Worker Host stops this process. The timer keeps Node's event
  // loop alive; an unresolved promise alone would let the process exit.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else if (mode === "produce") {
  const revision = option("revision");
  const head = git("rev-parse", "HEAD");
  if (head !== revision) throw new Error("Materialized the wrong revision");
  if (existsSync("later.txt")) throw new Error("Newer source leaked into the pinned checkout");
  if (readFileSync("overlap.cjs", "utf8").includes("uncommitted operator changes"))
    throw new Error("Operator working-tree changes leaked into the checkout");
  writeFileSync("overlap.cjs", "module.exports=(a,b)=>a.start<b.end&&b.start<a.end;\n");
  const paths = git("diff", "--name-only");
  if (paths !== "overlap.cjs") throw new Error("Unexpected edit scope");
  result = JSON.stringify({ revision: head, changedPaths: [paths] });
} else if (mode === "review") {
  const prompt = JSON.parse(task.prompt);
  // The reviewer applies the exported patch to its own pinned checkout.
  gitWith(prompt.patch, "apply", "--check", "-");
  gitWith(prompt.patch, "apply", "-");
  const { createRequire } = await import("node:module");
  const overlap = createRequire(`${process.cwd()}/`)("./overlap.cjs");
  if (prompt.evidence.revision !== git("rev-parse", "HEAD")) throw new Error("Wrong evidence");
  const checks = [
    !overlap({ start: 0, end: 10 }, { start: 10, end: 20 }),
    overlap({ start: 0, end: 10 }, { start: 5, end: 15 }),
  ];
  if (!checks.every(Boolean)) throw new Error("Independent checks failed");
  result = JSON.stringify({
    passed: true,
    revision: prompt.evidence.revision,
    checks: checks.length,
  });
  writeFileSync("verification.json", `${result}\n`);
}
await publish("output ready");
await publish(result);
note("finished");
await harness.client.complete({
  result,
  succeeded: true,
  objectiveSignal: 0,
  waitingApprovalIds: [],
});
harness.close();
