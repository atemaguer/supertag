import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  type Worklet,
} from "../../packages/runtime/sdk/src/index.js";

const hosts: Array<{ directory: string; worklet: DurableLocalWorklet }> = [];
afterEach(async () => {
  for (const { directory, worklet } of hosts.splice(0)) {
    await worklet.shutdown("Test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

/** Give a local controller fixture the same durable contract as a connected host. */
export function durableTestWorklet(local: Worklet): DurableLocalWorklet {
  const directory = mkdtempSync(join(tmpdir(), "supertag-controller-worklet-"));
  const worklet = new DurableLocalWorklet(local, new FileAttemptJournal(directory));
  hosts.push({ directory, worklet });
  return worklet;
}
