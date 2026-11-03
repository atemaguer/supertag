import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactRef, ArtifactStore } from "../../packages/runtime/sdk/src/index.js";

/** Separate credential-free process; a deterministic acceptance check, not a security sandbox. */
export async function evaluateSchedulingArtifact(store: ArtifactStore, artifact: ArtifactRef) {
  const bytes = await store.get(artifact);
  const directory = await mkdtemp(join(tmpdir(), "supertag-software-evaluator-"));
  try {
    await writeFile(join(directory, "schedule.cjs"), bytes, { mode: 0o600 });
    const program = `const overlap = require('./schedule.cjs');
if (typeof overlap !== 'function') throw new Error('Expected a CommonJS function export');
const cases = [
 ['adjacent', {start:0,end:10}, {start:10,end:20}, false],
 ['disjoint', {start:0,end:10}, {start:11,end:20}, false],
 ['partial', {start:0,end:10}, {start:5,end:15}, true],
 ['nested', {start:0,end:20}, {start:5,end:10}, true],
 ['identical', {start:0,end:10}, {start:0,end:10}, true]
];
const checks = cases.map(([name,a,b,expected]) => {
 const forward=overlap(a,b), reverse=overlap(b,a);
 return {name,expected,forward,reverse,passed:forward===expected && reverse===expected};
});
process.stdout.write(JSON.stringify({passed:checks.every(c=>c.passed),assertions:checks.length*2,checks}));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", program], {
      cwd: directory,
      env: {},
      timeout: 2000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
    });
    const result = JSON.parse(stdout) as {
      passed: boolean;
      assertions: number;
      checks: Array<{
        name: string;
        expected: boolean;
        forward: unknown;
        reverse: unknown;
        passed: boolean;
      }>;
    };
    if (result.checks.length !== 5 || result.assertions !== 10)
      throw new Error("Invalid machine verification output");
    return { ...result, artifact, providerCalls: 0 as const };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
