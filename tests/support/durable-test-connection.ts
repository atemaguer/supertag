import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableLocalWorklet, FileAttemptJournal } from "../../packages/runtime/sdk/src/index.js";
import {
  WorkletConnection,
  type WorkletConnectionOptions,
} from "../../packages/runtime/transport/src/index.js";

/** A test host with a private journal; stopping it also shuts down its owned execution. */
export function createDurableTestConnection(options: WorkletConnectionOptions): WorkletConnection {
  if (options.durableWorklet) return new WorkletConnection(options);
  const directory = mkdtempSync(join(tmpdir(), "supertag-test-worklet-"));
  const journal = new FileAttemptJournal(directory);
  const durable = new DurableLocalWorklet(options.worklet, journal);
  const connection = new WorkletConnection({ ...options, durableWorklet: durable });
  const stop = connection.stop.bind(connection);
  let closing: Promise<void> | undefined;
  connection.stop = () => {
    closing ??= (async () => {
      await stop();
      await durable.shutdown("Test host stopped");
      await rm(directory, { recursive: true, force: true });
    })();
    return closing;
  };
  return connection;
}

export async function connectDurableTestWorklet(
  options: WorkletConnectionOptions,
): Promise<WorkletConnection> {
  const connection = createDurableTestConnection(options);
  try {
    await connection.start();
    return connection;
  } catch (error) {
    await connection.stop();
    throw error;
  }
}
