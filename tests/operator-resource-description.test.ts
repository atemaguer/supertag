import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.js";

afterEach(() => vi.restoreAllMocks());
const client = () => new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
it("describes Host observations without treating stored slots as live capacity", async () => {
  const api = client();
  vi.spyOn(api, "request").mockResolvedValue({
    kind: "WorkerHost",
    metadata: { id: "host" },
    spec: { draining: true },
    status: {
      phase: "unreachable",
      connectionStatus: "disconnected",
      connectionGeneration: 4,
      capacity: 3,
      availableSlots: 2,
      activeAttempts: 1,
      protocolVersion: 14,
      durableProtocolVersion: 1,
      workers: [{ id: "worker", type: "codex", profiles: [{ id: "default", revision: "1" }] }],
    },
  });
  const output = await runResourceCommand(api, "describe", [
    "worker-host",
    "host",
    "--output",
    "text",
  ]);
  expect(output).toContain("Recorded available slots: 2");
  expect(output).toContain("current Host reachability and free capacity are not verified");
  expect(output).toContain("Profile: default@1");
  expect(output).toContain("Worklet protocol: v14, durable v1\n");
});
it("keeps get and explicit describe JSON unchanged and rejects invalid formats before requests", async () => {
  const api = client();
  const session = { id: "session", tagId: "tag", phase: "SESSION_PHASE_OPEN" };
  const rpc = fakeOperatorRpc({ "WorkService/GetSession": () => session });
  expect(
    JSON.parse(await runResourceCommand(api, "describe", ["session", "session", "--output=json"])),
  ).toEqual(session);
  expect(rpc.calls).toHaveLength(1);
  expect(JSON.parse(await runResourceCommand(api, "get", ["session", "session"]))).toEqual(session);
  await expect(runResourceCommand(api, "get", ["session", "--output", "text"])).rejects.toThrow(
    "describe",
  );
  await expect(
    runResourceCommand(api, "describe", ["session", "--output", "yaml"]),
  ).rejects.toThrow("YAML output is available for get");
  expect(rpc.calls).toHaveLength(2);
});
it("summarizes native archive metadata without exposing archived content", async () => {
  const api = client();
  const rpc = fakeOperatorRpc({
    "WorkService/GetSession": () => ({ id: "session/a", tagId: "tag", tag: "builder" }),
    "WorkService/ListSessionStates": () => ({
      states: [
        {
          id: "state",
          harnessId: "codex",
          status: "SESSION_STATE_STATUS_RESUMABLE",
          nativeId: "native",
          data: { secret: "never render transcript" },
        },
      ],
    }),
  });
  const output = await runResourceCommand(api, "describe", ["session", "session/a"]);
  expect(rpc.called("WorkService/ListSessionStates").map((call) => call.body)).toEqual([
    { sessionId: "session/a", pageSize: 100 },
  ]);
  expect(output).toContain("Tag: builder");
  expect(output).toContain("  codex: resumable; native ID native;");
  expect(output).toContain("a later Task of this Session resumes it");
  expect(output).not.toContain("never render transcript");
});
it("quotes operator follow-up commands safely and distinguishes empty bindings", async () => {
  const api = client();
  vi.spyOn(api, "request").mockResolvedValue({
    kind: "Tag",
    metadata: { name: "team'; $(touch stolen)" },
    spec: { roles: ["reviewer"], workerHosts: [] },
    status: { phase: "active" },
  });
  const output = await runResourceCommand(api, "describe", ["tag", "team"]);
  expect(output).toContain("No Worker Host is bound");
  expect(output).toContain(
    "supertag update tag 'team'\"'\"'; $(touch stolen)' --add-worker-host HOST",
  );
});
