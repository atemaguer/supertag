import { afterEach, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.ts";
import * as controlPlane from "../apps/cli/src/control-plane-client.ts";
import { formatCliFailure, main } from "../apps/cli/src/index.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const target = { url: "http://127.0.0.1:1", token: "unused" };
afterEach(() => vi.restoreAllMocks());

it.each([
  ["slack", ["--channel-id=C1"], { channelId: "C1" }],
  ["lark", ["--chat-id=chat"], { chatId: "chat" }],
  ["teams", ["--team-id=T1", "--channel-id=C1"], { teamId: "T1", channelId: "C1" }],
  ["github", ["--repo=owner/repo"], { repo: "owner/repo" }],
  ["github", ["--repo-id=123"], { repoId: "123" }],
  ["linear", ["--team=ENG"], { team: "ENG" }],
  ["linear", ["--team-id=team-id"], { teamId: "team-id" }],
] as const)(
  "routes %s inline scope flags through public update and activation commands",
  async (provider, flags, scope) => {
    vi.spyOn(controlPlane, "resolveControlPlaneTarget").mockResolvedValue(target);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handlers = Object.fromEntries(
      ["AddTagLocation", "RemoveTagLocation", "ActivateSet", "DeactivateSet"].map((method) => [
        `SurfaceService/${method}`,
        () => ({ tag: "builder", set: "shared", location: "scope", changed: true }),
      ]),
    );
    const rpc = fakeOperatorRpc(handlers);
    for (const operation of ["add", "remove"]) {
      expect(
        await main([
          "update",
          "tag",
          "builder",
          `--${operation}-location=${provider}`,
          ...flags,
          "--account=account",
        ]),
      ).toBe(0);
      expect(
        rpc.called(`SurfaceService/${operation === "add" ? "Add" : "Remove"}TagLocation`)[0]?.body,
      ).toMatchObject({ tag: "builder", location: { ...scope, account: "account" } });
    }
    for (const kind of ["context-set", "permission-set"]) {
      for (const action of ["activate", "deactivate"]) {
        expect(
          await main([action, kind, "shared", "--tag=builder", `--provider=${provider}`, ...flags]),
        ).toBe(0);
        expect(
          rpc
            .called(`SurfaceService/${action === "activate" ? "Activate" : "Deactivate"}Set`)
            .at(-1)?.body,
        ).toMatchObject({
          tag: "builder",
          set: "shared",
          kind: kind === "context-set" ? "SET_KIND_CONTEXT_SET" : "SET_KIND_PERMISSION_SET",
          location: scope,
        });
      }
    }
  },
);

it.each([
  ["slack", [], "--channel-id is required"],
  ["lark", [], "--chat-id is required"],
  ["teams", ["--team-id=T1"], "Teams requires both"],
  ["teams", ["--channel-id=C1"], "Teams requires both"],
  ["github", [], "exactly one"],
  ["github", ["--repo=a/b", "--repo-id=1"], "exactly one"],
  ["linear", [], "exactly one"],
  ["linear", ["--team=ENG", "--team-id=id"], "exactly one"],
  ["slack", ["--channel-id=C1", "--chat-id=chat"], "cannot be used"],
  ["lark", ["--chat-id=chat", "--repo=a/b"], "cannot be used"],
  ["teams", ["--team-id=T1", "--channel-id=C1", "--team=ENG"], "cannot be used"],
  ["github", ["--repo=a/b", "--team=ENG"], "cannot be used"],
  ["linear", ["--team=ENG", "--channel-id=C1"], "cannot be used"],
  ["slack", ["--channel-id=C1", "--actions=read"], "--actions is only valid"],
  ["slack", ["--channel-id=C1", "--unknown=x"], "Unknown option"],
  ["unknown", [], "Surface provider must be"],
] as const)(
  "rejects invalid %s location flags before requesting",
  async (provider, flags, message) => {
    const rpc = fakeOperatorRpc({});
    const client = new controlPlane.ControlPlaneClient(target);
    for (const command of ["add", "remove"] as const) {
      await expect(client.runTagCommand(command, ["builder", provider, ...flags])).rejects.toThrow(
        message,
      );
    }
    expect(rpc.fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ["create", "tag", "builder", "--help"],
  ["update", "tag", "builder", "--add-location=slack", "--help"],
  ["update", "tag", "builder", "--add-worker-host=host", "-h"],
  ["activate", "context-set", "shared", "--tag=builder", "--provider=slack", "--help"],
  ["deactivate", "permission-set", "shared", "--tag=builder", "--provider=teams", "--help"],
])("shows Tag help before resolving credentials: %j", async (...args) => {
  const resolve = vi
    .spyOn(controlPlane, "resolveControlPlaneTarget")
    .mockRejectedValue(new Error("must not read credentials"));
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(args)).toBe(0);
  expect(write.mock.calls.flat().join("")).toContain(
    "supertag create tag NAME [--worker-host HOST ...]",
  );
  expect(resolve).not.toHaveBeenCalled();
});

it("passes repeated Worker Hosts to the create manifest and validates positionals", async () => {
  const rpc = fakeOperatorRpc({
    "ResourceService/ApplyManifests": () => ({
      results: [{ outcome: "MANIFEST_OUTCOME_APPLIED" }],
      complete: true,
    }),
    "ResourceService/GetResource": () => ({
      tag: {
        metadata: { id: "tag-id", name: "builder" },
        spec: { workerHosts: ["host-a", "host-b"] },
        status: { phase: "TAG_PHASE_ACTIVE" },
      },
    }),
  });
  const client = new controlPlane.ControlPlaneClient(target);
  expect(
    await client.runTagCommand("create", [
      "builder",
      "--worker-host=host-a",
      "--worker-host",
      "host-b",
    ]),
  ).toBe("Created Tag builder (tag-id).\n");
  expect(rpc.called("ResourceService/ApplyManifests")[0]?.body).toMatchObject({
    imperative: true,
    documents: [
      {
        manifest: {
          kind: "Tag",
          metadata: { name: "builder" },
          spec: { workerHosts: ["host-a", "host-b"] },
        },
      },
    ],
  });
  rpc.fetch.mockClear();
  for (const args of [
    [],
    ["builder", "extra"],
    [" "],
    ["builder", "--worker-host="],
    ["builder", "--worker-profile=removed"],
  ]) {
    await expect(client.runTagCommand("create", args)).rejects.toThrow();
  }
  expect(rpc.fetch).not.toHaveBeenCalled();
});

it("routes inline Worker Host changes through HostService", async () => {
  const rpc = fakeOperatorRpc({
    "HostService/BindWorkerHost": () => ({ tag: "builder" }),
    "HostService/UnbindWorkerHost": () => ({ tag: "builder" }),
  });
  const client = new controlPlane.ControlPlaneClient(target);
  for (const action of ["add", "remove"]) {
    const [, command, ...args] = normalizeActionFirstCommand([
      "update",
      "tag",
      "builder",
      `--${action}-worker-host=host-a`,
    ]);
    expect(command).toBe(action === "add" ? "bind-worker-host" : "unbind-worker-host");
    await client.runTagCommand(action === "add" ? "bind-worker-host" : "unbind-worker-host", args);
    expect(
      rpc.called(`HostService/${action === "add" ? "Bind" : "Unbind"}WorkerHost`)[0]?.body,
    ).toEqual({ tag: "builder", workerHostId: "host-a" });
  }
});

it("preserves multiline diagnostics for humans and one-line JSON failures", () => {
  const message = "Multiple accounts:\n  one\tName\n  two\tOther";
  expect(formatCliFailure(new Error(message), [])).toBe(
    `SuperTag failed: ${message.replaceAll("\t", " ")}\n`,
  );
  expect(formatCliFailure(new Error(message), ["--output=json"])).not.toContain("\n  ");
});
