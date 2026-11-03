import { platformProcessInventory } from "@supertag/worker-sdk/internal/process-inventory";
import { watchStoppedRunner } from "./stop-watchdog.js";

// Process entry for the Cursor stop watchdog; see armCursorStopWatchdog.
const pid = Number(process.argv[2]);
const started = process.argv[3];
if (!Number.isSafeInteger(pid) || pid <= 1 || !started) process.exitCode = 1;
else
  await watchStoppedRunner(process.stdin, platformProcessInventory(), pid, started, () => {
    process.stdout.write("ready\n");
  }).catch(() => {
    process.exitCode = 1;
  });
