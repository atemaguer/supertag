import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModalExecutionEnvironmentProvider } from "../packages/runtime/environments/modal/src/index.js";
import { runServerHarnessConformance } from "../tests/support/server-harness-conformance.js";

const { values } = parseArgs({
  options: { live: { type: "boolean" }, output: { type: "string" } },
});
if (!values.live) throw new Error("Pass --live to create one short-lived Modal sandbox");
const provider = new ModalExecutionEnvironmentProvider({
  appName: "supertag-conformance",
  sandboxTimeoutMs: 60000,
  cpu: 0.25,
  memoryMiB: 256,
});
console.log(
  JSON.stringify(
    await runServerHarnessConformance(
      provider,
      resolve(values.output ?? `.supertag/server-conformance/${Date.now()}`),
    ),
    null,
    2,
  ),
);
