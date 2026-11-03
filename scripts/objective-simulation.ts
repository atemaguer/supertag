import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runObjectiveSimulation } from "../tests/support/objective-simulation.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  allowPositionals: true,
  options: {
    agents: { type: "string" },
    seed: { type: "string" },
    hosts: { type: "string" },
    concurrency: { type: "string" },
    output: { type: "string" },
    "process-mode": { type: "string" },
    "timeout-ms": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: pnpm test:simulation -- --agents 100 --seed 42 --hosts 3 --concurrency 4 [--process-mode simulated|local] [--output DIR] [--timeout-ms N]\n",
  );
} else {
  if (positionals.some((value) => value !== "--"))
    throw new Error("Unexpected positional argument");
  const seed = Number(values.seed ?? 42);
  const outputDirectory = resolve(
    values.output ??
      `.supertag/simulations/${new Date().toISOString().replace(/[:.]/gu, "-")}-seed-${seed}`,
  );
  const report = await runObjectiveSimulation({
    agents: Number(values.agents ?? 100),
    seed,
    hosts: Number(values.hosts ?? 3),
    concurrency: Number(values.concurrency ?? 4),
    outputDirectory,
    processMode: (values["process-mode"] ?? "simulated") as "simulated" | "local",
    ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    `${JSON.stringify(report, null, 2)}\nReport: ${outputDirectory}/report.json\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
