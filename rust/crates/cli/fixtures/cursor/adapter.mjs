import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { adapter, bridge } = JSON.parse(await readFile(new URL("./modules.json", import.meta.url)));
const { runAdapter } = await import(pathToFileURL(adapter).href);
const { readBootstrap } = await import(pathToFileURL(bridge).href);
const { values } = parseArgs({
  options: {
    model: { type: "string" },
    "timeout-seconds": { type: "string" },
    "allow-unsandboxed-commands": { type: "boolean", default: false },
  },
});

assert.ok(process.env.CURSOR_API_KEY === "synthetic-cursor-provider-key");
for (const key of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "SUPERTAG_E2B_TEMPLATE",
  "SUPERTAG_GATEWAY_TOKEN",
  "SUPERTAG_OPERATOR_TOKEN",
  "SUPERTAG_HOST_TOKEN",
  "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
  "NODE_OPTIONS",
  "PYTHONPATH",
])
  assert.equal(process.env[key], undefined, `outer adapter inherited ${key}`);

const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGTERM", abort);
process.on("SIGINT", abort);
try {
  const bootstrap = await readBootstrap(process.stdin);
  await runAdapter(bootstrap, controller.signal, {
    model: values.model,
    timeoutMs: Number(values["timeout-seconds"]) * 1000,
    allowUnsandboxedCommands: values["allow-unsandboxed-commands"],
    runnerEntrypoint: fileURLToPath(new URL("./runner.mjs", import.meta.url)),
  });
} finally {
  process.off("SIGTERM", abort);
  process.off("SIGINT", abort);
}
