import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    harness: { type: "string" },
    model: { type: "string" },
    output: { type: "string" },
    live: { type: "boolean" },
    "auth-file": { type: "string" },
    executable: { type: "string" },
    backend: { type: "string" },
    "image-id": { type: "string" },
    template: { type: "string" },
  },
});
const backend = values.backend ?? "local";
if (!["local", "modal", "e2b"].includes(backend))
  throw new Error("Select --backend local, modal, or e2b");
if (!["codex", "claude-code", "opencode", "cursor"].includes(values.harness ?? ""))
  throw new Error("Select --harness codex, claude-code, opencode, or cursor");
if (values.harness === "opencode" && !values.model)
  throw new Error("OpenCode requires --model provider/model");
if (backend === "modal" && !values["image-id"])
  throw new Error("Modal Harness tests require --image-id containing the selected Harness CLI");
if (backend === "e2b" && !values.template)
  throw new Error("E2B Harness tests require --template containing the selected Harness CLI");
if (values["image-id"] && backend !== "modal")
  throw new Error("--image-id requires --backend modal");
if (values.template && backend !== "e2b") throw new Error("--template requires --backend e2b");
if (values.executable && values.harness !== "opencode")
  throw new Error("--executable is supported only for OpenCode");
if (values["auth-file"] && values.harness === "claude-code")
  throw new Error("Claude Code uses its configured provider environment, not --auth-file");
if (!values.live) throw new Error("Pass --live to authorize this bounded model-provider test");
// Load Harnesses and providers only after the selection is valid, so mistakes fail fast.
const [
  { E2BExecutionEnvironmentProvider },
  { ModalExecutionEnvironmentProvider },
  { ClaudeCodeHarness },
  { CodexHarness },
  { CursorHarness },
  { OpenCodeHarness },
  { LocalExecutionEnvironmentProvider },
  { prepareHarnessFixture, runHarnessConformance },
] = await Promise.all([
  import("../packages/runtime/environments/e2b/src/index.js"),
  import("../packages/runtime/environments/modal/src/index.js"),
  import("../packages/runtime/harnesses/claude-code/src/index.js"),
  import("../packages/runtime/harnesses/codex/src/index.js"),
  import("../packages/runtime/harnesses/cursor/src/index.js"),
  import("../packages/runtime/harnesses/opencode/src/index.js"),
  import("../packages/runtime/sdk/src/index.js"),
  import("../tests/support/harness-conformance.js"),
]);
const directory = resolve(values.output ?? `.supertag/harness-conformance/${Date.now()}`);
await mkdir(directory, { recursive: true });
const fixture = await prepareHarnessFixture(directory);
const common = { workspace: fixture.source, timeoutMs: 120000 };
const harness =
  values.harness === "codex"
    ? new CodexHarness({
        ...common,
        model: values.model ?? "gpt-5.6-luna",
        ...(backend === "modal" ? { sandboxMode: "external" as const } : {}),
        ...(values["auth-file"] ? { authFile: resolve(values["auth-file"]) } : {}),
      })
    : values.harness === "cursor"
      ? new CursorHarness({ ...common, model: values.model ?? "auto" })
      : values.harness === "claude-code"
        ? new ClaudeCodeHarness({ ...common, model: values.model ?? "haiku", maxTurns: 8 })
        : values.harness === "opencode" && values.model
          ? new OpenCodeHarness({
              ...common,
              model: values.model,
              ...(values["auth-file"] ? { authFile: resolve(values["auth-file"]) } : {}),
              ...(values.executable ? { executable: values.executable } : {}),
            })
          : undefined;
if (!harness)
  throw new Error("Select codex, claude-code, cursor, or opencode with an explicit model");
const report = await runHarnessConformance({
  directory,
  harness,
  executionEnvironment:
    backend === "modal"
      ? new ModalExecutionEnvironmentProvider({
          appName: "supertag-conformance",
          sandboxTimeoutMs: 180000,
          ...(values["image-id"] ? { imageId: values["image-id"] } : {}),
          cpu: 1,
          memoryMiB: 1024,
        })
      : backend === "e2b"
        ? new E2BExecutionEnvironmentProvider({
            ...(values.template ? { template: values.template } : {}),
            sandboxTimeoutMs: 180000,
          })
        : new LocalExecutionEnvironmentProvider(),
  ...fixture,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
