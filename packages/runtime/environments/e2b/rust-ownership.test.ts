import { FileNotFoundError, Sandbox, SandboxNotFoundError } from "e2b";
import { describe, expect, it, vi } from "vitest";
import {
  e2bSandboxInventory,
  sandboxOwnershipMetadata,
  stopOwnedSandbox,
} from "./src/rust-provider/ownership.ts";

type Inventory = Parameters<typeof stopOwnedSandbox>[0];
type Owner = Parameters<typeof sandboxOwnershipMetadata>[0];

const owner: Owner = {
  hostId: "host-a",
  hostGeneration: 9_007_199_254_740_993n,
  taskId: "task-a",
  attemptId: "attempt-a",
  allocationId: "allocation-a",
};
const sandboxId = "sandbox-a";

function record(id = sandboxId, identity = owner) {
  return { sandboxId: id, metadata: sandboxOwnershipMetadata(identity) };
}

function fixture() {
  return {
    find: vi.fn<Inventory["find"]>().mockResolvedValue([]),
    get: vi.fn<Inventory["get"]>().mockResolvedValue(undefined),
    kill: vi.fn<Inventory["kill"]>().mockResolvedValue(undefined),
  };
}

function sdkClient() {
  return {
    list: vi.fn<typeof Sandbox.list>(),
    getInfo: vi.fn<typeof Sandbox.getInfo>(),
    kill: vi.fn<typeof Sandbox.kill>(),
  };
}

describe("E2B SDK inventory", () => {
  it("queries exact ownership metadata across running and paused sandboxes", async () => {
    const client = sdkClient();
    const pages = Sandbox.list();
    vi.spyOn(pages, "hasNext", "get").mockReturnValueOnce(true).mockReturnValue(false);
    const next = vi.spyOn(pages, "nextItems").mockResolvedValue([]);
    client.list.mockReturnValue(pages);
    const options = { requestTimeoutMs: 250 };
    const metadata = sandboxOwnershipMetadata(owner);

    await expect(e2bSandboxInventory(options, client).find(metadata)).resolves.toEqual([]);
    expect(client.list).toHaveBeenCalledExactlyOnceWith({
      ...options,
      query: { metadata, state: ["running", "paused"] },
    });
    expect(next).toHaveBeenCalledExactlyOnceWith(options);
  });

  it("maps only the SDK's sandbox-not-found error to definitive absence", async () => {
    const client = sdkClient();
    const options = { requestTimeoutMs: 250 };
    const offline = new Error("E2B management request failed");
    const missingFile = new FileNotFoundError("file missing inside sandbox");
    client.getInfo
      .mockRejectedValueOnce(new SandboxNotFoundError("sandbox absent"))
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(missingFile);
    const inventory = e2bSandboxInventory(options, client);

    await expect(inventory.get(sandboxId)).resolves.toBeUndefined();
    await expect(inventory.get(sandboxId)).rejects.toBe(offline);
    await expect(inventory.get(sandboxId)).rejects.toBe(missingFile);
    expect(client.getInfo.mock.calls).toEqual(Array(3).fill([sandboxId, options]));
  });
});

describe("E2B sandbox ownership recovery", () => {
  it("encodes every owner field, including the exact host generation", () => {
    const metadata = sandboxOwnershipMetadata(owner);
    expect(Object.values(metadata)).toEqual(
      expect.arrayContaining([
        owner.hostId,
        "9007199254740993",
        owner.taskId,
        owner.attemptId,
        owner.allocationId,
      ]),
    );
    for (const change of [
      { hostId: "other-host" },
      { hostGeneration: owner.hostGeneration + 1n },
      { taskId: "other-task" },
      { attemptId: "other-attempt" },
      { allocationId: "other-allocation" },
    ]) {
      expect(sandboxOwnershipMetadata({ ...owner, ...change })).not.toEqual(metadata);
    }
  });

  it("finds one exact allocation and verifies that sandbox is gone after killing it", async () => {
    const inventory = fixture();
    const allocated = record();
    inventory.find.mockResolvedValue([allocated]);
    inventory.get.mockResolvedValueOnce(allocated);

    await expect(stopOwnedSandbox(inventory, owner)).resolves.toEqual({
      state: "stopped",
      sandboxId,
    });
    expect(inventory.find).toHaveBeenCalledWith(sandboxOwnershipMetadata(owner));
    expect(inventory.kill).toHaveBeenCalledExactlyOnceWith(sandboxId);
    expect(inventory.get.mock.calls).toEqual([[sandboxId], [sandboxId]]);
  });

  it.each(["absent", "ambiguous"] as const)(
    "leaves an %s allocation without a known sandbox ID uncertain",
    async (state) => {
      const inventory = fixture();
      if (state === "ambiguous") inventory.find.mockResolvedValue([record(), record("sandbox-b")]);

      await expect(stopOwnedSandbox(inventory, owner)).resolves.toEqual({ state: "uncertain" });
      expect(inventory.kill).not.toHaveBeenCalled();
    },
  );

  it("uses definitive absence of a previously recorded sandbox ID as cleanup evidence", async () => {
    const inventory = fixture();

    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "stopped",
      sandboxId,
    });
    expect(inventory.get).toHaveBeenCalledExactlyOnceWith(sandboxId);
    expect(inventory.find).not.toHaveBeenCalled();
    expect(inventory.kill).not.toHaveBeenCalled();
  });

  it("refuses to kill a sandbox owned by another host generation", async () => {
    const inventory = fixture();
    inventory.get.mockResolvedValue(record(sandboxId, { ...owner, hostGeneration: 2n }));

    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.kill).not.toHaveBeenCalled();
  });

  it("does not accept a kill acknowledgement while the sandbox is still present", async () => {
    const inventory = fixture();
    inventory.get.mockResolvedValue(record());

    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.kill).toHaveBeenCalledExactlyOnceWith(sandboxId);
  });

  it("recognizes a successful stop when the kill response is lost but absence is confirmed", async () => {
    const inventory = fixture();
    inventory.get.mockResolvedValueOnce(record());
    inventory.kill.mockRejectedValueOnce(new Error("provider response lost"));

    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "stopped",
      sandboxId,
    });
    expect(inventory.kill).toHaveBeenCalledExactlyOnceWith(sandboxId);
    expect(inventory.get.mock.calls).toEqual([[sandboxId], [sandboxId]]);
  });

  it("keeps a provider lookup failure distinct from confirmed absence", async () => {
    const inventory = fixture();
    inventory.get.mockResolvedValueOnce(record()).mockRejectedValue(new Error("provider offline"));

    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.kill).toHaveBeenCalledExactlyOnceWith(sandboxId);
  });
});
