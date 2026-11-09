import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { renderListTable, runListCommand } from "../apps/cli/src/list-command.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import { fakeHostRpc, workerHostJson, workerHostResourceOf } from "./support/fake-host-rpc.ts";
import { fakeWorkRpc } from "./support/fake-work-rpc.ts";

/** One Worker Profile's capabilities for a harness, as a Worklet advertises them. */
const serves = (harness: string) => ({
  profile: { id: harness, revision: "1" },
  capabilities: [],
  contextTypes: [],
  harness,
});
const workers = [
  { id: "local-claude", type: "supertag", profileCapabilities: [serves("claude-code")] },
  { id: "local-codex", type: "supertag", profileCapabilities: [serves("codex")] },
  {
    id: "shared",
    type: "supertag",
    profileCapabilities: [serves("codex"), serves("claude-code"), serves("codex")],
  },
  { id: "custom", type: "custom-worker", profileCapabilities: [] },
];
const resource = { kind: "WorkerHost", metadata: { id: "host" }, status: { workers } };

it("lists advertised harnesses instead of the built-in Worker type", () => {
  const output = renderListTable("worker-host", { items: [resource] });
  expect(output).toContain("claude-code, codex, claude-code, codex, custom-worker");
  expect(output).not.toContain("supertag");
});

it("describes each Worker's harnesses with a fallback for custom Workers", async () => {
  const api = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  fakeHostRpc([resource]);
  const output = await runResourceCommand(api, "describe", ["worker-host", "host"]);
  expect(output).toContain("Worker: local-claude (claude-code)");
  expect(output).toContain("Worker: local-codex (codex)");
  expect(output).toContain("Worker: shared (claude-code, codex)");
  expect(output).toContain("Worker: custom (custom-worker)");
  expect(
    JSON.parse(await runResourceCommand(api, "describe", ["worker-host", "host", "--output=json"])),
  ).toEqual(workerHostResourceOf(resource));
});

afterEach(() => vi.restoreAllMocks());
it("labels running capacity by harness while preserving shared Worker capacity", async () => {
  fakeWorkRpc(
    [
      {
        metadata: { id: "task" },
        status: {
          phase: "running",
          attempt: { phase: "running", workerHostId: "host", workerId: "local-codex" },
        },
      },
    ],
    { "HostService/ListWorkerHosts": () => ({ workerHosts: [workerHostJson(resource)] }) },
  );
  const output = await runListCommand({ url: "http://127.0.0.1:1", token: "unused" }, [
    "worker-host",
  ]);
  expect(output).toContain("claude-code 0/1, codex 1/1, claude-code, codex 0/1, custom-worker 0/1");
});
