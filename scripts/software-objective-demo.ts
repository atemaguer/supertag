import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runSoftwareObjectiveDemo } from "../tests/support/software-objective-demo.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string" },
    recovery: { type: "boolean" },
    "timeout-ms": { type: "string" },
    "max-attempts": { type: "string" },
  },
});
if (values.mode !== undefined && !["real", "deterministic", "live-handoff"].includes(values.mode))
  throw new Error("mode must be deterministic, live-handoff, or real");
const outputDirectory = resolve(values.output ?? `.supertag/software-demo/${Date.now()}`);
const report = await runSoftwareObjectiveDemo({
  outputDirectory,
  recovery: values.recovery ?? false,
  timeoutMs: Number(
    values["timeout-ms"] ??
      (values.mode && values.mode !== "deterministic" ? 600000 : values.recovery ? 120000 : 30000),
  ),
  maxAttempts: Number(values["max-attempts"] ?? 12),
  mode:
    values.mode === "real"
      ? "real"
      : values.mode === "live-handoff"
        ? "live-handoff"
        : "deterministic",
});
await writeFile(resolve(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
