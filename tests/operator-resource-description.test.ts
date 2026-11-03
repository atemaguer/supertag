import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";

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
  const resource = { kind: "Session", metadata: { id: "session" }, status: { phase: "active" } };
  const request = vi.spyOn(api, "request").mockResolvedValue(resource);
  expect(
    JSON.parse(await runResourceCommand(api, "describe", ["session", "session", "--output=json"])),
  ).toEqual(resource);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await runResourceCommand(api, "get", ["session", "session"]))).toEqual(
    resource,
  );
  await expect(runResourceCommand(api, "get", ["session", "--output", "text"])).rejects.toThrow(
    "describe",
  );
  await expect(
    runResourceCommand(api, "describe", ["session", "--output", "yaml"]),
  ).rejects.toThrow("YAML output is available for get");
  expect(request).toHaveBeenCalledTimes(2);
});
it("summarizes native archive metadata without exposing archived content", async () => {
  const api = client();
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({
      kind: "Session",
      metadata: { id: "session/a" },
      spec: { tagId: "tag" },
      status: { phase: "active" },
    })
    .mockResolvedValueOnce({
      states: [
        {
          harnessId: "codex",
          status: "resumable",
          nativeId: "native",
          data: { secret: "never render transcript" },
        },
      ],
    })
    .mockResolvedValueOnce({ items: [] });
  const output = await runResourceCommand(api, "describe", ["session", "session/a"]);
  expect(request).toHaveBeenCalledWith("/api/v1/sessions/session%2Fa/states");
  expect(output).toContain("reuse still requires compatible");
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
