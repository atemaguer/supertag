import { parseArgs } from "node:util";
import { readBootstrap } from "@supertag/worker-sdk/internal/rust-harness";
import { runAdapter } from "./adapter.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      model: { type: "string" },
      "timeout-seconds": { type: "string" },
      "allow-unsandboxed-commands": { type: "boolean", default: false },
      "auth-file": { type: "string" },
    },
  });
  const seconds = Number(values["timeout-seconds"] ?? "3600");
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
    throw new Error("Invalid timeout");
  const bootstrap = await readBootstrap(process.stdin);
  await runAdapter(bootstrap, controller.signal, {
    ...(values.executable ? { executable: values.executable } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["auth-file"] ? { authFile: values["auth-file"] } : {}),
    allowUnsandboxedCommands: values["allow-unsandboxed-commands"] === true,
    timeoutMs: seconds * 1000,
  });
} catch {
  // Bootstrap and process errors may carry credentials.
  process.stderr.write("OpenCode adapter could not complete its execution safely.\n");
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
