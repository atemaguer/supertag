import { describe, expect, it, vi } from "vitest";
import type { ModalSandboxFactory, ModalWorkspaceClient } from "./src/index.ts";
import { LiveWorkspaceClosedError, LiveWorkspaceLedger } from "./src/live-workspace-ledger.ts";

function fixture() {
  const events: string[] = [];
  const terminate = vi.fn(async () => 0);
  const deleteImage = vi.fn(async (_input: { imageId: string }) => {});
  const workspace = {
    buildImage: vi.fn(async () => "base"),
    createSetupSandbox: vi.fn(async () => ({
      sandboxId: "setup",
      exec: vi.fn(),
      terminate,
      snapshotFilesystem: vi.fn(async () => "snapshot"),
    })),
    deleteImage,
  } as unknown as ModalWorkspaceClient;
  const sandboxes = {
    create: vi.fn(async () => ({ sandboxId: "task", exec: vi.fn(), terminate })),
  } as unknown as ModalSandboxFactory;
  const ledger = new LiveWorkspaceLedger({
    workspace,
    sandboxes,
    runId: "test-run",
    async *listSandboxes() {},
    log: (line) => events.push(line),
  });
  return { ledger, events, terminate, deleteImage, workspace, sandboxes };
}

async function createResources(ledger: LiveWorkspaceLedger) {
  await ledger.workspaceClient.buildImage({
    appName: "test",
    createAppIfMissing: false,
    image: "base",
    commands: [],
  });
  const setup = await ledger.workspaceClient.createSetupSandbox({
    appName: "test",
    createAppIfMissing: false,
    imageId: "base",
    timeoutMs: 1000,
    tags: {},
  });
  await setup.snapshotFilesystem();
  await ledger.sandboxFactory.create({
    appName: "test",
    createAppIfMissing: false,
    image: "base",
    params: {},
  });
}

describe("live Modal workspace cleanup", () => {
  it("deletes setup and Task sandboxes before both images after a run fails", async () => {
    const { ledger, events, terminate, deleteImage } = fixture();
    await expect(
      (async () => {
        try {
          await createResources(ledger);
          throw new Error("conformance failed");
        } finally {
          await ledger.cleanup();
        }
      })(),
    ).rejects.toThrow("conformance failed");
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(deleteImage).toHaveBeenCalledTimes(2);
    expect(events.filter((item) => item.startsWith("deleted "))).toEqual([
      "deleted sandbox setup",
      "deleted sandbox task",
      "deleted image base",
      "deleted image snapshot",
    ]);
  });

  it("retries failed deletions and continues deleting every resource", async () => {
    const { ledger, terminate, deleteImage } = fixture();
    await createResources(ledger);
    terminate.mockRejectedValueOnce(new Error("termination failed"));
    deleteImage.mockRejectedValueOnce(new Error("image deletion failed"));
    await ledger.cleanup();
    expect(terminate).toHaveBeenCalledTimes(3);
    expect(deleteImage).toHaveBeenCalledTimes(3);
    expect(ledger.remaining).toEqual({ sandboxes: [], images: [] });
  });

  it("sweeps a tagged sandbox whose create call failed after creation", async () => {
    const { ledger, terminate } = fixture();
    const hidden = {
      sandboxId: "unreturned",
      exec: vi.fn(),
      terminate,
    };
    const sweep = new LiveWorkspaceLedger({
      workspace: ledger.workspaceClient,
      sandboxes: ledger.sandboxFactory,
      runId: "test-run",
      async *listSandboxes() {
        yield hidden as never;
      },
      log: vi.fn(),
    });
    await sweep.cleanup();
    expect(terminate).toHaveBeenCalledOnce();
    expect(sweep.remaining.sandboxes).toEqual([]);
  });

  it("reports IDs that still need manual deletion after bounded retries", async () => {
    const { ledger, terminate, deleteImage } = fixture();
    await createResources(ledger);
    terminate.mockRejectedValue(new Error("unavailable"));
    await expect(ledger.cleanup()).rejects.toThrow("sandbox setup");
    expect(terminate).toHaveBeenCalledTimes(6);
    expect(deleteImage).toHaveBeenCalledTimes(2);
    expect(ledger.remaining.sandboxes).toEqual(["setup", "task"]);
  });

  it("adds a no-op layer naming the run so the deleted base image is unique to it", async () => {
    const { ledger, workspace } = fixture();
    await ledger.workspaceClient.buildImage({
      appName: "test",
      createAppIfMissing: false,
      image: "python:3.13-slim",
      commands: ["RUN apt-get install -y git"],
    });
    expect(workspace.buildImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "python:3.13-slim",
        commands: ["RUN apt-get install -y git", "ENV SUPERTAG_LIVE_RUN_ID=test-run"],
      }),
    );
  });

  it("refuses a run ID that is not safe in a Dockerfile command", () => {
    expect(
      () =>
        new LiveWorkspaceLedger({
          workspace: {} as ModalWorkspaceClient,
          sandboxes: {} as ModalSandboxFactory,
          runId: "x\nRUN curl evil",
          async *listSandboxes() {},
          log: vi.fn(),
        }),
    ).toThrow("alphanumeric");
  });

  it("terminates a sandbox and deletes images created after cleanup finished", async () => {
    const { ledger, events, terminate, deleteImage } = fixture();
    await ledger.cleanup();
    await expect(
      ledger.sandboxFactory.create({
        appName: "test",
        createAppIfMissing: false,
        image: "base",
        params: {},
      }),
    ).rejects.toBeInstanceOf(LiveWorkspaceClosedError);
    await expect(
      ledger.workspaceClient.buildImage({
        appName: "test",
        createAppIfMissing: false,
        image: "base",
        commands: [],
      }),
    ).rejects.toBeInstanceOf(LiveWorkspaceClosedError);
    await ledger.settled();
    expect(terminate).toHaveBeenCalledOnce();
    expect(deleteImage).toHaveBeenCalledWith({ imageId: "base" });
    expect(ledger.remaining).toEqual({ sandboxes: [], images: [] });
    expect(events).toContain("deleted sandbox task");
    expect(events).toContain("deleted image base");
  });

  it("waits for a sandbox created while cleanup is running", async () => {
    const { ledger, terminate } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new LiveWorkspaceLedger({
      workspace: ledger.workspaceClient,
      sandboxes: ledger.sandboxFactory,
      runId: "test-run",
      listSandboxes: () => ({
        async *[Symbol.asyncIterator]() {
          await gate;
          yield* [];
        },
      }),
      log: vi.fn(),
    });
    const cleanup = slow.cleanup();
    const late = slow.sandboxFactory.create({
      appName: "test",
      createAppIfMissing: false,
      image: "base",
      params: {},
    });
    await expect(late).rejects.toBeInstanceOf(LiveWorkspaceClosedError);
    release();
    await cleanup;
    expect(terminate).toHaveBeenCalled();
    expect(slow.remaining.sandboxes).toEqual([]);
  });

  it("waits on a slow termination after a timeout instead of calling a closed client again", async () => {
    const { ledger, terminate } = fixture();
    await ledger.sandboxFactory.create({
      appName: "test",
      createAppIfMissing: false,
      image: "base",
      params: {},
    });
    let closed = false;
    terminate.mockImplementation(async () => {
      if (closed) throw new Error("client closed");
      await new Promise((resolve) => setTimeout(resolve, 30));
      closed = true;
      return 0;
    });
    const quick = new LiveWorkspaceLedger({
      workspace: ledger.workspaceClient,
      sandboxes: ledger.sandboxFactory,
      runId: "test-run",
      async *listSandboxes() {
        yield { sandboxId: "task", exec: vi.fn(), terminate } as never;
      },
      log: vi.fn(),
      stepTimeoutMs: 10,
    });
    await quick.cleanup();
    expect(terminate).toHaveBeenCalledOnce();
    expect(quick.remaining.sandboxes).toEqual([]);
  });
});
