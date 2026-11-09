import { afterEach, expect, it, vi } from "vitest";
import { fakeHostRpc, workerHostResourceOf } from "../../tests/support/fake-host-rpc.js";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { main } from "./src/index.js";
import { operatorNotice } from "./src/operator-notice.js";
import { runResourceCommand } from "./src/resources.js";

afterEach(() => vi.restoreAllMocks());

it("explains interrupted work with a recovery action", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(["--help"])).toBe(0);
  const text = write.mock.calls.map(([value]) => String(value)).join("");
  expect(text).toContain("Reconnect the original Worker Host to check interrupted work.");
  expect(text).not.toContain("unknown execution retains capacity");
});

it("keeps connection counters in JSON, not the human host description", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  const resource = {
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { id: "host" },
    spec: { draining: false },
    status: { phase: "ready", connectionStatus: "connected", connectionGeneration: 2 },
  };
  fakeHostRpc([resource]);
  const text = await runResourceCommand(client, "describe", ["worker-host", "host"]);
  expect(text).toContain("Recorded connection: connected");
  expect(text).not.toContain("Connection generation:");
  expect(
    JSON.parse(
      await runResourceCommand(client, "describe", ["worker-host", "host", "--output", "json"]),
    ),
  ).toEqual(workerHostResourceOf(resource));
});

it("translates generated stall notices without rewriting owner messages", () => {
  const notice =
    "Needs you: owner stalled. SuperTag wrote this notice: the Objective is still working, but no owner activation is running, queued, or waiting, and SuperTag will not start another automatically because its limit was reached.";
  expect(operatorNotice(notice)).toContain("reply with your next instruction to restart the owner");
  expect(operatorNotice(notice)).not.toContain("owner activation");
  const ownerMessage =
    "Please review my result. A prose request is enough for me to understand your direction.";
  expect(operatorNotice(ownerMessage)).toBe(ownerMessage);
});
