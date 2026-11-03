import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runTransportComparison } from "../tests/support/worklet-transport-comparison.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string" },
    warmup: { type: "string" },
    reconnects: { type: "string" },
    "deadline-ms": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: pnpm exec tsx --conditions=development scripts/worklet-transport-benchmark.ts [--iterations 50] [--warmup 5] [--reconnects 3] [--deadline-ms 5000] [--output .supertag/benchmarks/worklet-transports.json]\n",
  );
} else {
  const integer = (name: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
    return parsed;
  };
  const iterations = integer("iterations", values.iterations);
  const warmup = integer("warmup", values.warmup);
  const reconnects = integer("reconnects", values.reconnects);
  const deadlineMs = integer("deadline-ms", values["deadline-ms"]);
  const report = await runTransportComparison({
    ...(iterations === undefined ? {} : { iterations }),
    ...(warmup === undefined ? {} : { warmup }),
    ...(reconnects === undefined ? {} : { reconnects }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json, { mode: 0o600 });
  }
  process.stdout.write(json);
}
