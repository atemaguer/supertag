import { sandboxExecutionEnvironment } from "@supertag/worker-sdk";
import {
  createSandboxWorkspaceSession,
  type SandboxWorkspaceSession,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { Sandbox, type SandboxOpts } from "e2b";
import { E2BExecutionEnvironmentProvider } from "../index.js";
import { adaptE2B, type E2BSandboxClient, shellQuote } from "../sandbox.js";
import {
  e2bSandboxInventory,
  type SandboxInventory,
  sandboxOwnershipMetadata,
  stopOwnedSandbox,
} from "./ownership.js";

const MAX_LIFETIME_MS = 3_600_000;
const API_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;

export interface E2BWorkspaceSandbox {
  readonly client: E2BSandboxClient;
  writeTransfer(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readTransfer(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

interface E2BWorkspaceSessionOptions {
  readonly template?: string;
  readonly factory?: { create(options: SandboxOpts): Promise<E2BWorkspaceSandbox> };
  readonly inventory?: SandboxInventory;
}

const nativeFactory = {
  async create(options: SandboxOpts): Promise<E2BWorkspaceSandbox> {
    const client = await Sandbox.create(options);
    return {
      client,
      async writeTransfer(path, bytes, signal) {
        // Use an exact view of the trusted Host buffer. The SDK accepts an upload stream.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        await client.files.write(path, stream, { signal, requestTimeoutMs: TRANSFER_TIMEOUT_MS });
      },
      readTransfer(path, signal) {
        return client.files.read(path, {
          format: "stream",
          signal,
          requestTimeoutMs: API_TIMEOUT_MS,
          streamIdleTimeoutMs: API_TIMEOUT_MS,
        });
      },
    };
  },
};

export function createE2BWorkspaceSession(
  options: E2BWorkspaceSessionOptions = {},
): SandboxWorkspaceSession {
  const template = options.template ?? process.env["SUPERTAG_E2B_TEMPLATE"] ?? "base";
  if (!template.trim() || template.length > 256 || /\p{Cc}/u.test(template))
    throw new Error("Invalid E2B Workspace template");
  const factory = options.factory ?? nativeFactory;
  const inventory = options.inventory ?? e2bSandboxInventory({ requestTimeoutMs: API_TIMEOUT_MS });
  return createSandboxWorkspaceSession({
    label: "E2B",
    validateOwner: sandboxOwnershipMetadata,
    async allocate(owner, timeoutMs, signal) {
      const metadata = sandboxOwnershipMetadata(owner);
      const sandbox = await factory.create({
        template,
        metadata: { ...metadata },
        timeoutMs: Math.min(timeoutMs, MAX_LIFETIME_MS),
        requestTimeoutMs: 30_000,
        allowInternetAccess: false,
        secure: true,
        lifecycle: { onTimeout: "kill", autoResume: false },
        signal,
      });
      signal.throwIfAborted();
      const sandboxId = sandbox.client.sandboxId;
      if (!sandboxId || sandboxId.length > 256 || /\p{Cc}/u.test(sandboxId))
        throw new Error("Invalid sandbox identity");
      const identity = await inventory.get(sandboxId);
      if (
        identity?.sandboxId !== sandboxId ||
        !Object.entries(metadata).every(([key, value]) => identity.metadata[key] === value)
      )
        throw new Error("Unexpected sandbox ownership");
      return {
        sandboxId,
        environment: (root) =>
          sandboxExecutionEnvironment(
            adaptE2B(sandbox.client),
            root,
            new E2BExecutionEnvironmentProvider({ maxOutputCharacters: 65_536 }).options,
          ),
        run: (argv, timeoutMs, signal) =>
          sandbox.client.commands.run(argv.map(shellQuote).join(" "), {
            cwd: "/tmp",
            timeoutMs,
            signal,
          }),
        writeTransfer: (path, bytes, signal) => sandbox.writeTransfer(path, bytes, signal),
        readTransfer: (path, signal) => sandbox.readTransfer(path, signal),
      };
    },
    stop: (owner, sandboxId) => stopOwnedSandbox(inventory, owner, sandboxId),
  });
}
