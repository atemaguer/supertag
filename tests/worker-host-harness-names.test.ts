import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { renderListTable, runListCommand } from "../apps/cli/src/list-command.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import { fakeWorkRpc } from "./support/fake-work-rpc.ts";

const workers = [
  { id: "local-claude", type: "supertag", profileCapabilities: [{ harness: "claude-code" }] },
  { id: "local-codex", type: "supertag", profileCapabilities: [{ harness: "codex" }] },
  {
    id: "shared",
    type: "supertag",
    profileCapabilities: [{ harness: "codex" }, { harness: "claude-code" }, { harness: "codex" }],
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
  vi.spyOn(api, "request").mockResolvedValue(resource);
  const output = await runResourceCommand(api, "describe", ["worker-host", "host"]);
  expect(output).toContain("Worker: local-claude (claude-code)");
  expect(output).toContain("Worker: local-codex (codex)");
  expect(output).toContain("Worker: shared (claude-code, codex)");
  expect(output).toContain("Worker: custom (custom-worker)");
  expect(
    JSON.parse(await runResourceCommand(api, "describe", ["worker-host", "host", "--output=json"])),
  ).toEqual(resource);
});

afterEach(() => vi.restoreAllMocks());
it("labels running capacity by harness while preserving shared Worker capacity", async () => {
  vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValueOnce({ items: [resource] });
  fakeWorkRpc([
    {
      metadata: { id: "task" },
      status: {
        phase: "running",
        attempt: { phase: "running", workerHostId: "host", workerId: "local-codex" },
      },
    },
  ]);
  const output = await runListCommand({ url: "http://127.0.0.1:1", token: "unused" }, [
    "worker-host",
  ]);
  expect(output).toContain("claude-code 0/1, codex 1/1, claude-code, codex 0/1, custom-worker 0/1");
});
