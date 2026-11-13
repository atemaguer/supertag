import { parseArgs } from "node:util";
import { readBootstrap } from "@supertag/worker-sdk/internal/rust-harness";
import { runAdapter } from "./adapter.js";
import { writeModelCheck } from "./model-check.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      "timeout-seconds": { type: "string" },
      "allow-unsandboxed-commands": { type: "boolean", default: false },
      "check-models": { type: "boolean", default: false },
      "check-model": { type: "string", multiple: true },
    },
  });
  if (values["check-models"]) {
    let output = "";
    await writeModelCheck(values["check-model"] ?? [], process.env, (line) => {
      output += line;
    });
    // The SDK may hold connections open; exit once the result is flushed.
    await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
    process.exit(0);
  }
  const seconds = Number(values["timeout-seconds"] ?? "3600");
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
    throw new Error("Invalid timeout");
  const bootstrap = await readBootstrap(process.stdin);
  await runAdapter(bootstrap, controller.signal, {
    ...(values.model ? { model: values.model } : {}),
    allowUnsandboxedCommands: values["allow-unsandboxed-commands"],
    timeoutMs: seconds * 1000,
  });
} catch {
  process.stderr.write("Cursor adapter could not complete its execution safely.\n");
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
