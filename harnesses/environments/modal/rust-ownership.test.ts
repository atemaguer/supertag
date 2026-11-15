import { type ModalClient, NotFoundError, SandboxService } from "modal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modalSandboxInventory,
  sandboxOwnershipMatches,
  sandboxOwnershipMetadata,
  sandboxOwnershipName,
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
const sandboxId = "sb-0000000000000000000000";
const appId = "ap-0000000000000000000000";

function identity(id = sandboxId, value = owner) {
  return { sandboxId: id, metadata: sandboxOwnershipMetadata(value) };
}

function fixture() {
  return {
    find: vi.fn<Inventory["find"]>().mockResolvedValue([identity()]),
    get: vi.fn<Inventory["get"]>().mockResolvedValue(identity()),
    poll: vi.fn<Inventory["poll"]>().mockResolvedValue(null),
    terminate: vi.fn<Inventory["terminate"]>().mockResolvedValue(137),
  };
}

function sdkFixture() {
  const cpClient = {
    sandboxList: vi.fn().mockResolvedValue({ sandboxes: [] }),
    sandboxTagsGet: vi.fn().mockResolvedValue({
      tags: Object.entries(sandboxOwnershipMetadata(owner)).map(([tagName, tagValue]) => ({
        tagName,
        tagValue,
      })),
    }),
    sandboxWait: vi.fn().mockResolvedValue({ result: { status: 3, exitcode: 137 } }),
    sandboxTerminate: vi.fn().mockResolvedValue({}),
  };
  // Exercise the pinned SDK's actual handle, polling, wait, and detach behavior
  // over an in-memory control-plane seam; no provider connection is constructed.
  const client = {
    cpClient,
    environmentName: (value?: string) => value ?? "test-environment",
    logger: { debug: vi.fn() },
  } as unknown as ModalClient;
  const sandboxes = new SandboxService(client);
  return {
    cpClient,
    inventory: modalSandboxInventory({ sandboxes }, { appId, environment: "test-environment" }),
  };
}

afterEach(() => vi.useRealTimers());

describe("Modal allocation ownership", () => {
  it("binds every exact owner field in a stable bounded creation name and tags", () => {
    const tags = sandboxOwnershipMetadata(owner);
    const name = sandboxOwnershipName(owner);
    expect(name).toMatch(/^supertag-[A-Za-z0-9_-]{43}$/u);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(Object.entries(tags).flat().join(""))).toBeLessThanOrEqual(512);
    expect(sandboxOwnershipMetadata({ ...owner })).toEqual(tags);
    expect(sandboxOwnershipName({ ...owner })).toEqual(name);
    for (const change of [
      { hostId: "other-host" },
      { hostGeneration: owner.hostGeneration + 1n },
      { taskId: "other-task" },
      { attemptId: "other-attempt" },
      { allocationId: "other-allocation" },
    ]) {
      expect(sandboxOwnershipMetadata({ ...owner, ...change })).not.toEqual(tags);
      expect(sandboxOwnershipName({ ...owner, ...change })).not.toBe(name);
      expect(sandboxOwnershipMatches(owner, identity(sandboxId, { ...owner, ...change }))).toBe(
        false,
      );
    }
    expect(sandboxOwnershipMatches(owner, identity())).toBe(true);
  });

  it("uses an unambiguous tuple and rejects invalid owner fields", () => {
    expect(sandboxOwnershipName({ ...owner, hostId: "a:b", taskId: "c" })).not.toBe(
      sandboxOwnershipName({ ...owner, hostId: "a", taskId: "b:c" }),
    );
    for (const change of [
      { hostGeneration: 0n },
      { hostGeneration: 18_446_744_073_709_551_616n },
      { hostId: "" },
      { taskId: "bad\nfield" },
      { allocationId: "a".repeat(257) },
    ])
      expect(() => sandboxOwnershipMetadata({ ...owner, ...change })).toThrow("ownership");
    expect(() => sandboxOwnershipMetadata({ ...owner, hostId: "é".repeat(256) })).not.toThrow();
  });
});

describe("pinned Modal SDK inventory", () => {
  it("uses complete app/environment/tag-scoped discovery and checks returned tags", async () => {
    const { cpClient, inventory } = sdkFixture();
    cpClient.sandboxList
      .mockResolvedValueOnce({ sandboxes: [{ id: sandboxId, createdAt: 123 }] })
      .mockResolvedValueOnce({ sandboxes: [] });
    await expect(inventory.find(sandboxOwnershipMetadata(owner))).resolves.toEqual([identity()]);
    expect(cpClient.sandboxList).toHaveBeenCalledTimes(2);
    expect(cpClient.sandboxList.mock.calls[0]?.[0]).toEqual({
      appId,
      beforeTimestamp: undefined,
      environmentName: "test-environment",
      includeFinished: false,
      tags: Object.entries(sandboxOwnershipMetadata(owner)).map(([tagName, tagValue]) => ({
        tagName,
        tagValue,
      })),
    });
    expect(cpClient.sandboxList.mock.calls[1]?.[0].beforeTimestamp).toBe(123);
    expect(cpClient.sandboxTagsGet).toHaveBeenCalledExactlyOnceWith({ sandboxId });
  });

  it("does not mistake fromId's local handle for a provider lookup", async () => {
    const { cpClient, inventory } = sdkFixture();
    const missing = new NotFoundError("no sandbox visibility");
    cpClient.sandboxTagsGet.mockRejectedValue(missing);
    await expect(inventory.get(sandboxId)).rejects.toBe(missing);
    expect(cpClient.sandboxTagsGet).toHaveBeenCalledExactlyOnceWith({ sandboxId });
  });

  it("preserves running versus terminal status and waits for termination", async () => {
    const { cpClient, inventory } = sdkFixture();
    cpClient.sandboxWait
      .mockResolvedValueOnce({ result: { status: 0 } })
      .mockResolvedValueOnce({ result: { status: 4 } });
    await expect(inventory.poll(sandboxId)).resolves.toBeNull();
    await expect(inventory.terminate(sandboxId)).resolves.toBe(124);
    expect(cpClient.sandboxTerminate).toHaveBeenCalledExactlyOnceWith({ sandboxId });
    expect(cpClient.sandboxWait.mock.calls.map(([request]) => request)).toEqual([
      { sandboxId, timeout: 0 },
      { sandboxId, timeout: 10 },
    ]);
    // A separate handle is required because terminate({wait:true}) detaches its handle.
    await expect(inventory.poll(sandboxId)).resolves.toBe(137);
  });

  it("bounds repeated or oversized discovery instead of trusting a partial inventory", async () => {
    const { cpClient, inventory } = sdkFixture();
    cpClient.sandboxList.mockResolvedValue({ sandboxes: [{ id: sandboxId, createdAt: 123 }] });
    await expect(inventory.find(sandboxOwnershipMetadata(owner))).rejects.toThrow("inventory");
    expect(cpClient.sandboxList.mock.calls.length).toBeLessThanOrEqual(257);
  });
});

describe("Modal definitive stop proof", () => {
  it("discovers one exact owner and waits for its terminal result", async () => {
    const inventory = fixture();
    await expect(stopOwnedSandbox(inventory, owner)).resolves.toEqual({
      state: "stopped",
      sandboxId,
    });
    expect(inventory.find).toHaveBeenCalledExactlyOnceWith(sandboxOwnershipMetadata(owner));
    expect(inventory.get).toHaveBeenCalledExactlyOnceWith(sandboxId);
    expect(inventory.terminate).toHaveBeenCalledExactlyOnceWith(sandboxId);
  });

  it.each([0, 1, 124, 137])(
    "accepts terminal exit code %i without another terminate",
    async (code) => {
      const inventory = fixture();
      inventory.poll.mockResolvedValue(code);
      await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
        state: "stopped",
        sandboxId,
      });
      expect(inventory.find).not.toHaveBeenCalled();
      expect(inventory.terminate).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "ambiguous"])("keeps %s unknown allocation uncertain", async (kind) => {
    const inventory = fixture();
    inventory.find.mockResolvedValue(
      kind === "missing" ? [] : [identity(), identity("sb-1111111111111111111111")],
    );
    await expect(stopOwnedSandbox(inventory, owner)).resolves.toEqual({ state: "uncertain" });
    expect(inventory.terminate).not.toHaveBeenCalled();
  });

  it("never interprets NotFound on an exact ID as termination proof", async () => {
    const inventory = fixture();
    inventory.get.mockRejectedValue(new NotFoundError("not found"));
    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.terminate).not.toHaveBeenCalled();
  });

  it("filters a discovery result by the complete owner rather than trusting provider filtering", async () => {
    const inventory = fixture();
    inventory.find.mockResolvedValue([identity(sandboxId, { ...owner, allocationId: "old" })]);
    await expect(stopOwnedSandbox(inventory, owner)).resolves.toEqual({ state: "uncertain" });
    expect(inventory.get).not.toHaveBeenCalled();
    expect(inventory.terminate).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, 0.5, 2_147_483_648])(
    "rejects malformed terminal status %s",
    async (code) => {
      const inventory = fixture();
      inventory.poll.mockResolvedValue(code);
      await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
        state: "uncertain",
      });
      expect(inventory.terminate).not.toHaveBeenCalled();
    },
  );

  it("does not accept an acknowledgement without a terminal wait result", async () => {
    const inventory = fixture();
    inventory.terminate.mockResolvedValue(undefined as unknown as number);
    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.poll).toHaveBeenCalledTimes(2);
  });

  it.each(["wrong-owner", "wrong-id"])("refuses a %s lookup before any effect", async (kind) => {
    const inventory = fixture();
    inventory.get.mockResolvedValue(
      kind === "wrong-owner"
        ? identity(sandboxId, { ...owner, hostGeneration: 2n })
        : identity("sb-1111111111111111111111"),
    );
    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "uncertain",
    });
    expect(inventory.poll).not.toHaveBeenCalled();
    expect(inventory.terminate).not.toHaveBeenCalled();
  });

  it("reattaches and verifies terminal state after a lost terminate response", async () => {
    const inventory = fixture();
    inventory.terminate.mockRejectedValue(new Error("response lost"));
    inventory.poll.mockResolvedValueOnce(null).mockResolvedValueOnce(137);
    await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
      state: "stopped",
      sandboxId,
    });
    expect(inventory.get.mock.calls).toEqual([[sandboxId], [sandboxId]]);
    expect(inventory.poll.mock.calls).toEqual([[sandboxId], [sandboxId]]);
  });

  it.each(["running", "not-found", "wrong-owner"])(
    "keeps a lost response with %s evidence uncertain",
    async (kind) => {
      const inventory = fixture();
      inventory.terminate.mockRejectedValue(new Error("response lost"));
      if (kind === "not-found")
        inventory.poll
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new NotFoundError("no status"));
      if (kind === "wrong-owner")
        inventory.get
          .mockResolvedValueOnce(identity())
          .mockResolvedValueOnce(identity(sandboxId, { ...owner, taskId: "other" }));
      await expect(stopOwnedSandbox(inventory, owner, sandboxId)).resolves.toEqual({
        state: "uncertain",
      });
      expect(inventory.terminate).toHaveBeenCalledOnce();
    },
  );

  it("bounds a stuck terminal wait without treating a late response as proof", async () => {
    vi.useFakeTimers();
    const inventory = fixture();
    let finish: ((code: number) => void) | undefined;
    inventory.terminate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = stopOwnedSandbox(inventory, owner, sandboxId, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({ state: "uncertain" });
    expect(inventory.terminate).toHaveBeenCalledOnce();
    finish?.(137);
    await expect(result).resolves.toEqual({ state: "uncertain" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors cancellation before discovery and fences later effects after cancelled discovery", async () => {
    const inventory = fixture();
    const controller = new AbortController();
    let discovered: ((value: ReturnType<typeof identity>[]) => void) | undefined;
    inventory.find.mockImplementation(
      () =>
        new Promise((resolve) => {
          discovered = resolve;
        }),
    );
    const result = stopOwnedSandbox(inventory, owner, undefined, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toEqual({ state: "uncertain" });
    discovered?.([identity()]);
    await Promise.resolve();
    expect(inventory.get).not.toHaveBeenCalled();
    expect(inventory.terminate).not.toHaveBeenCalled();
    inventory.find.mockClear();
    await expect(
      stopOwnedSandbox(inventory, owner, undefined, { signal: controller.signal }),
    ).resolves.toEqual({ state: "uncertain" });
    expect(inventory.find).not.toHaveBeenCalled();
  });

  it("fences termination when cancellation arrives during status lookup", async () => {
    const inventory = fixture();
    const controller = new AbortController();
    inventory.poll.mockImplementation(async () => {
      controller.abort();
      return null;
    });
    await expect(
      stopOwnedSandbox(inventory, owner, sandboxId, { signal: controller.signal }),
    ).resolves.toEqual({ state: "uncertain" });
    expect(inventory.terminate).not.toHaveBeenCalled();
  });
});
