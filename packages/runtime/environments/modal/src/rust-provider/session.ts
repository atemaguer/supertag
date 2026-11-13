import { sandboxExecutionEnvironment } from "@supertag/worker-sdk";
import {
  createSandboxWorkspaceSession,
  MAX_TRANSFER,
  type SandboxEnvironment,
  type SandboxWorkspaceSession,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { ModalClient } from "modal";
import { FILE_HELPER } from "../files.js";
import { ModalExecutionEnvironmentProvider, type ModalSandboxClient } from "../index.js";
import { adaptModal, collect } from "../sandbox.js";
import {
  modalSandboxInventory,
  type SandboxInventory,
  sandboxOwnershipMatches,
  sandboxOwnershipMetadata,
  sandboxOwnershipName,
  stopOwnedSandbox,
} from "./ownership.js";

const MAX_LIFETIME_MS = 3_600_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const TRANSFER_CHUNK_BYTES = 256 * 1024;
const FILE_COMMAND = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "LANG=C.UTF-8",
  "python3",
  "-I",
  "-S",
  "-c",
  FILE_HELPER,
];

export interface ModalWorkspaceScope {
  readonly inventory: SandboxInventory;
  create(params: {
    readonly name: string;
    readonly tags: Record<string, string>;
    readonly timeoutMs: number;
    readonly blockNetwork: true;
    /** A devcontainer image: Dockerfile layers on its registry image or the configured one. */
    readonly image?: Pick<SandboxEnvironment, "image" | "dockerfileCommands">;
  }): Promise<ModalSandboxClient>;
  close(): void;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim() || value.length > 2048 || /\p{Cc}/u.test(value))
    throw new Error(`Missing Modal Workspace configuration ${name}`);
  return value;
}

async function openNativeScope(): Promise<ModalWorkspaceScope> {
  const appName = required("SUPERTAG_MODAL_WORKSPACE_APP");
  const environment = process.env["SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT"] ?? "main";
  const imageName = process.env["SUPERTAG_MODAL_WORKSPACE_IMAGE"] ?? "python:3.13-bookworm";
  const client = new ModalClient({
    tokenId: required("MODAL_TOKEN_ID"),
    tokenSecret: required("MODAL_TOKEN_SECRET"),
    endpoint: process.env["MODAL_SERVER_URL"] ?? "https://api.modal.com:443",
    environment,
    timeoutMs: 25_000,
    maxRetries: 0,
  });
  try {
    const app = await client.apps.fromName(appName, { createIfMissing: false });
    return {
      inventory: modalSandboxInventory(client, { appId: app.appId, environment }),
      async create({ image: devcontainer, ...params }) {
        const name = devcontainer?.image ?? imageName;
        let image = /^im-(?:[A-Za-z0-9]{22}|[A-Za-z0-9]{26})$/u.test(name)
          ? await client.images.fromId(name)
          : client.images.fromRegistry(name);
        if (devcontainer && devcontainer.dockerfileCommands.length > 0)
          image = await image.dockerfileCommands([...devcontainer.dockerfileCommands]).build(app);
        return client.sandboxes.create(app, image, params);
      },
      close: () => client.close(),
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function withSignal<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<T>();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work(), interrupted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function writeTransfer(
  sandbox: ModalSandboxClient,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  await withSignal(async () => {
    const process = await sandbox.exec([...FILE_COMMAND, "write", path, "0", "384"], {
      mode: "binary",
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const result = Promise.all([
      collect(process.stdout, 0),
      collect(process.stderr, 8192),
      process.wait(),
    ]);
    void result.catch(() => undefined);
    for (let offset = 0; offset < bytes.byteLength; offset += TRANSFER_CHUNK_BYTES) {
      signal.throwIfAborted();
      await process.stdin.writeBytes(bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES));
    }
    await process.stdin.close();
    const [, , status] = await result;
    if (status !== 0) throw new Error("Modal Workspace transfer write failed");
  }, signal);
}

async function readTransfer(
  sandbox: ModalSandboxClient,
  path: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const process = await withSignal(
    () =>
      sandbox.exec([...FILE_COMMAND, "read-stream", path, String(MAX_TRANSFER), "0"], {
        mode: "binary",
        timeoutMs: TRANSFER_TIMEOUT_MS,
      }),
    signal,
  );
  const completion = Promise.all([collect(process.stderr, 8192), process.wait()]);
  void completion.catch(() => undefined);
  await withSignal(() => process.stdin.close(), signal);
  const reader = process.stdout.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await withSignal(() => reader.read(), signal);
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        const [, status] = await withSignal(() => completion, signal);
        if (status !== 0) throw new Error("Modal Workspace transfer read failed");
        controller.close();
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        throw error;
      }
      reader.releaseLock();
    },
    async cancel() {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function createModalWorkspaceSession(
  options: { readonly open?: () => Promise<ModalWorkspaceScope> } = {},
): SandboxWorkspaceSession {
  let scope: Promise<ModalWorkspaceScope> | undefined;
  const open = () => (scope ??= (options.open ?? openNativeScope)());
  const environmentOptions = new ModalExecutionEnvironmentProvider({
    appName: "workspace-provider",
    maxOutputCharacters: 65_536,
  }).options;
  const session = createSandboxWorkspaceSession({
    label: "Modal",
    validateOwner: sandboxOwnershipMetadata,
    async allocate(owner, timeoutMs, signal, environment) {
      const connection = await withSignal(open, signal);
      const sandbox = await withSignal(
        () =>
          connection.create({
            name: sandboxOwnershipName(owner),
            tags: { ...sandboxOwnershipMetadata(owner) },
            timeoutMs: Math.min(Math.ceil(timeoutMs / 1000) * 1000, MAX_LIFETIME_MS),
            blockNetwork: true,
            ...(environment && environment.dockerfileCommands.length > 0
              ? {
                  image: {
                    ...(environment.image === undefined ? {} : { image: environment.image }),
                    dockerfileCommands: environment.dockerfileCommands,
                  },
                }
              : {}),
          }),
        signal,
      );
      const sandboxId = sandbox.sandboxId;
      if (!/^[\w-]{1,256}$/u.test(sandboxId)) throw new Error("Invalid Modal sandbox identity");
      const identity = await withSignal(() => connection.inventory.get(sandboxId), signal);
      if (identity.sandboxId !== sandboxId || !sandboxOwnershipMatches(owner, identity))
        throw new Error("Modal sandbox ownership could not be verified");
      return {
        sandboxId,
        environment: (root) =>
          sandboxExecutionEnvironment(adaptModal(sandbox), root, environmentOptions),
        async run(argv, timeoutMs, signal) {
          return withSignal(async () => {
            const process = await sandbox.exec(argv, {
              mode: "binary",
              workdir: "/tmp",
              timeoutMs,
            });
            const result = Promise.all([
              collect(process.stdout, 8192),
              collect(process.stderr, 8192),
              process.wait(),
            ]);
            void result.catch(() => undefined);
            await process.stdin.close();
            const [stdout, , exitCode] = await result;
            return { stdout: new TextDecoder().decode(stdout), exitCode };
          }, signal);
        },
        writeTransfer: (path, bytes, signal) => writeTransfer(sandbox, path, bytes, signal),
        readTransfer: (path, signal) => readTransfer(sandbox, path, signal),
      };
    },
    async stop(owner, sandboxId) {
      const connection = await open();
      return stopOwnedSandbox(connection.inventory, owner, sandboxId);
    },
  });
  return {
    ...session,
    async close() {
      try {
        await session.close();
      } finally {
        // A timed-out SDK operation may still be resolving its connection.
        void scope?.then((connection) => connection.close()).catch(() => undefined);
      }
    },
  };
}
