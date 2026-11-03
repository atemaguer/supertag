import type {
  ModalSandboxClient,
  ModalSandboxFactory,
  ModalSetupSandboxClient,
  ModalWorkspaceClient,
} from "./index.js";

const STEP_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const RUN_ID = /^[A-Za-z0-9-]+$/;

/** Thrown when the run creates a resource after cleanup began; that resource is removed at once. */
export class LiveWorkspaceClosedError extends Error {
  constructor(resource: string) {
    super(`Modal conformance cleanup already started; removed late ${resource}`);
  }
}

/** Tracks Modal objects owned by one live conformance run. */
export class LiveWorkspaceLedger {
  readonly #images = new Set<string>();
  readonly #sandboxes = new Map<string, ModalSandboxClient>();
  readonly #log: (message: string) => void;
  readonly #workspace: ModalWorkspaceClient;
  readonly #listSandboxes: () => AsyncIterable<ModalSandboxClient>;
  readonly runId: string;
  readonly workspaceClient: ModalWorkspaceClient;
  readonly sandboxFactory: ModalSandboxFactory;
  readonly #stepTimeoutMs: number;
  readonly #terminating = new Map<string, Promise<number>>();
  readonly #late = new Set<Promise<void>>();
  #closed = false;
  #environment: string | undefined;
  #cleanup?: Promise<void>;

  constructor(input: {
    workspace: ModalWorkspaceClient;
    sandboxes: ModalSandboxFactory;
    runId: string;
    listSandboxes: () => AsyncIterable<ModalSandboxClient>;
    log: (message: string) => void;
    /** Per-attempt cleanup timeout; tests shorten it. */
    stepTimeoutMs?: number;
  }) {
    if (!RUN_ID.test(input.runId)) throw new Error("Live Modal run ID must be alphanumeric");
    this.#workspace = input.workspace;
    this.#stepTimeoutMs = input.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    this.#log = input.log;
    this.#listSandboxes = input.listSandboxes;
    this.runId = input.runId;
    this.workspaceClient = {
      buildImage: async (request) => {
        // A no-op layer naming the run keeps the deleted image out of Modal's shared build cache.
        const id = await input.workspace.buildImage({
          ...request,
          commands: [...request.commands, `ENV SUPERTAG_LIVE_RUN_ID=${this.runId}`],
        });
        return this.#trackImage(id, "image");
      },
      createSetupSandbox: async (request) =>
        this.#track(
          await input.workspace.createSetupSandbox({
            ...request,
            tags: { ...request.tags, "supertag.liveRunId": this.runId },
          }),
        ) as ModalSetupSandboxClient,
      deleteImage: async (request) => {
        await input.workspace.deleteImage(request);
        this.#images.delete(request.imageId);
        this.#log(`deleted image ${request.imageId}`);
      },
    };
    this.sandboxFactory = {
      create: async (request) =>
        this.#track(
          await input.sandboxes.create({
            ...request,
            params: {
              ...request.params,
              tags: { ...request.params.tags, "supertag.liveRunId": this.runId },
            },
          }),
        ),
    };
  }

  get remaining(): { sandboxes: string[]; images: string[] } {
    return { sandboxes: [...this.#sandboxes.keys()], images: [...this.#images] };
  }

  #track(sandbox: ModalSandboxClient): ModalSandboxClient {
    this.#sandboxes.set(sandbox.sandboxId, sandbox);
    this.#log(`created sandbox ${sandbox.sandboxId}`);
    const tracked: ModalSandboxClient & Partial<ModalSetupSandboxClient> = {
      sandboxId: sandbox.sandboxId,
      exec: (command, options) => sandbox.exec(command, options),
      terminate: async (options) => {
        const code = await sandbox.terminate(options);
        this.#sandboxes.delete(sandbox.sandboxId);
        this.#log(`deleted sandbox ${sandbox.sandboxId}`);
        return code;
      },
    };
    if ("snapshotFilesystem" in sandbox) {
      const setup = sandbox as ModalSetupSandboxClient;
      tracked.snapshotFilesystem = async () =>
        this.#trackImage(await setup.snapshotFilesystem(), "snapshot image");
    }
    if (this.#closed) {
      this.#removeLate(`sandbox ${sandbox.sandboxId}`, async () => {
        await this.#terminate(sandbox.sandboxId, sandbox);
        this.#sandboxes.delete(sandbox.sandboxId);
      });
    }
    return tracked;
  }

  async #trackImage(id: string, kind: string): Promise<string> {
    this.#images.add(id);
    this.#log(`created ${kind} ${id}`);
    if (this.#closed) {
      this.#removeLate(`image ${id}`, async () => {
        await this.#workspace.deleteImage({
          ...(this.#environment ? { environment: this.#environment } : {}),
          imageId: id,
        });
        this.#images.delete(id);
      });
    }
    return id;
  }

  /** Removes a resource registered after cleanup began, then refuses the creating call. */
  #removeLate(label: string, remove: () => Promise<void>): never {
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    const removal = this.#bounded(label, deadline, remove).then(
      () => this.#log(`deleted ${label}`),
      (error: unknown) => this.#log(`failed to delete late ${label}: ${String(error)}`),
    );
    this.#late.add(removal);
    void removal.finally(() => this.#late.delete(removal));
    throw new LiveWorkspaceClosedError(label);
  }

  /** Retries after a timeout wait on the same call; native setup sandboxes close their client. */
  #terminate(id: string, sandbox: ModalSandboxClient): Promise<number> {
    let pending = this.#terminating.get(id);
    if (!pending) {
      pending = sandbox.terminate({ wait: true });
      this.#terminating.set(id, pending);
      pending.then(
        () => {},
        () => this.#terminating.delete(id),
      );
    }
    return pending;
  }

  /** One cleanup pass is shared by signal and normal-exit paths. */
  cleanup(environment?: string): Promise<void> {
    if (!this.#closed) this.#environment = environment;
    this.#closed = true;
    if (!this.#cleanup) this.#cleanup = this.#cleanupResources(environment);
    return this.#cleanup;
  }

  /** Waits for removals of resources created after cleanup began. */
  async settled(): Promise<void> {
    while (this.#late.size) await Promise.all(this.#late);
  }

  async #cleanupResources(environment?: string): Promise<void> {
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    const failures: string[] = [];
    try {
      // A create call may throw after Modal created a sandbox but before returning its ID.
      await this.#bounded("sandbox listing", deadline, async () => {
        for await (const sandbox of this.#listSandboxes())
          this.#sandboxes.set(sandbox.sandboxId, sandbox);
      });
    } catch (error) {
      failures.push(`sandbox listing: ${String(error)}`);
    }
    for (const [id, sandbox] of this.#sandboxes) {
      try {
        await this.#bounded(`sandbox ${id}`, deadline, () => this.#terminate(id, sandbox));
        this.#sandboxes.delete(id);
        this.#log(`deleted sandbox ${id}`);
      } catch (error) {
        failures.push(`sandbox ${id}: ${String(error)}`);
      }
    }
    for (const id of this.#images) {
      try {
        await this.#bounded(`image ${id}`, deadline, () =>
          this.#workspace.deleteImage({ ...(environment ? { environment } : {}), imageId: id }),
        );
        this.#images.delete(id);
        this.#log(`deleted image ${id}`);
      } catch (error) {
        failures.push(`image ${id}: ${String(error)}`);
      }
    }
    await this.settled();
    if (failures.length) throw new Error(`Modal cleanup failed: ${failures.join("; ")}`);
  }

  async #bounded<T>(label: string, deadline: number, action: () => Promise<T>): Promise<T> {
    let error: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            action(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${label} timed out`)),
                Math.min(this.#stepTimeoutMs, remaining),
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (caught) {
        error = caught;
        if (attempt < ATTEMPTS - 1) {
          const delay = Math.min(250 * 2 ** attempt, Math.max(0, deadline - Date.now()));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw error ?? new Error(`${label} cleanup deadline exceeded`);
  }
}
