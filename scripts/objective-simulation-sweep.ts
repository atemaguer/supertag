import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type ObjectiveSimulationReport,
  runObjectiveSimulation,
} from "../tests/support/objective-simulation.js";

const { values } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  options: {
    sizes: { type: "string", default: "100,500,1000" },
    seeds: { type: "string", default: "42" },
    repeats: { type: "string", default: "1" },
    hosts: { type: "string", default: "4" },
    concurrency: { type: "string", default: "8" },
    output: { type: "string" },
  },
});
function integerList(value: string, min: number, max: number): number[] {
  const numbers = value.split(",").map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < min || n > max))
    throw new Error(`Expected comma-separated integers in ${min}–${max}`);
  return numbers;
}
const sizes = integerList(values.sizes, 20, 1000);
const seeds = integerList(values.seeds, 0, 2147483647);
function integer(value: string, min: number, max: number): number {
  const numbers = integerList(value, min, max);
  const value_ = numbers[0];
  if (numbers.length !== 1 || value_ === undefined) throw new Error("Expected a single integer");
  return value_;
}
const repeats = integer(values.repeats, 1, 100);
const hosts = integer(values.hosts, 1, 32);
const concurrency = integer(values.concurrency, 1, 100);
const directory = resolve(values.output ?? `.supertag/simulations/sweep-${Date.now()}`);
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "sweep-manifest.json"),
  JSON.stringify({ sizes, seeds, repeats, hosts, concurrency }, null, 2),
  { flag: "wx" },
);
const reports: Array<{ directory: string; report?: ObjectiveSimulationReport; error?: string }> =
  [];
// Repeat in the same process so reports expose retained memory across completed lifecycles.
for (const agents of sizes)
  for (const seed of seeds)
    for (let repeat = 0; repeat < repeats; repeat++) {
      const outputDirectory = join(directory, `${agents}-seed-${seed}-repeat-${repeat}`);
      try {
        const report = await runObjectiveSimulation({
          agents,
          seed,
          hosts,
          concurrency,
          outputDirectory,
          onProgress: (message) =>
            process.stdout.write(`${agents}/${seed}/${repeat}: ${message}\n`),
        });
        reports.push({ directory: outputDirectory, report });
        if (!report.passed) process.exitCode = 1;
      } catch (error) {
        reports.push({ directory: outputDirectory, error: String(error) });
        process.exitCode = 1;
      }
      await writeFile(join(directory, "sweep-report.json"), JSON.stringify(reports, null, 2));
    }
process.stdout.write(`Reports: ${directory}/sweep-report.json\n`);
