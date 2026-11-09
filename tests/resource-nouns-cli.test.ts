import { expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const canonical = [
  "tag",
  "permission-set",
  "context-set",
  "role",
  "surface-account",
  "worker-host",
  "worker-profile",
  "task",
  "session",
  "volume",
  "workspace",
  "auth-key",
  "operator-token",
  "objective",
];
const aliases = [
  ...canonical.map((kind) => `${kind}s`),
  ...canonical.filter((kind) => kind.includes("-")).map((kind) => kind.replaceAll("-", "")),
  "Tag",
  "PermissionSet",
  "unknown",
  "constructor",
  "__proto__",
];

const listedByRpc: Readonly<Record<string, string>> = {
  task: "WorkService/ListTasks",
  session: "WorkService/ListSessions",
  "surface-account": "SurfaceService/ListSurfaceAccounts",
  "worker-host": "HostService/ListWorkerHosts",
  "auth-key": "HostService/ListAuthKeys",
  "operator-token": "AccessService/ListOperatorTokens",
};

it.each(canonical.filter((kind) => !(kind in listedByRpc)))(
  "lists canonical resource %s",
  async (kind) => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const client = { request } as unknown as ControlPlaneClient;
    await runResourceCommand(client, "get", [kind]);
    expect(request).toHaveBeenCalledWith(`/api/v1/${kind}s`);
  },
);

it.each(Object.entries(listedByRpc))("lists canonical resource %s", async (kind, method) => {
  const rpc = fakeOperatorRpc({ [method]: () => ({}) });
  try {
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    await runResourceCommand(client, "get", [kind]);
    expect(rpc.called(method)).toHaveLength(1);
  } finally {
    rpc.fetch.mockRestore();
  }
});

it.each(aliases)("rejects noncanonical resource %s before requesting", async (kind) => {
  const request = vi.fn().mockResolvedValue({ items: [] });
  const client = { request } as unknown as ControlPlaneClient;
  await expect(runResourceCommand(client, "get", [kind])).rejects.toThrow(
    `Unknown resource kind: ${kind}. Use one of: ${canonical.join(", ")}`,
  );
  expect(request).not.toHaveBeenCalled();
});
