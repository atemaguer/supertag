import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

// The Worker Host hands the key over in a private file the adapter deletes, never its environment.
assert.ok(existsSync(process.env.SUPERTAG_PROVIDER_CREDENTIALS_FILE ?? ""), "no provider key file");
for (const key of [
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "SUPERTAG_E2B_TEMPLATE",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_SERVER_URL",
  "MODAL_CONFIG_PATH",
  "MODAL_ENVIRONMENT",
  "SUPERTAG_MODAL_WORKSPACE_APP",
  "SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT",
  "SUPERTAG_MODAL_WORKSPACE_IMAGE",
  "SUPERTAG_GATEWAY_CREDENTIAL",
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
  const credentials = process.env.SUPERTAG_PROVIDER_CREDENTIALS_FILE;
  const running = runAdapter(bootstrap, controller.signal, {
    model: values.model,
    timeoutMs: Number(values["timeout-seconds"]) * 1000,
    allowUnsandboxedCommands: values["allow-unsandboxed-commands"],
    runnerEntrypoint: fileURLToPath(new URL("./runner.mjs", import.meta.url)),
  });
  assert.ok(!existsSync(credentials), "the adapter left its provider key file behind");
  await running;
} finally {
  process.off("SIGTERM", abort);
  process.off("SIGINT", abort);
}
