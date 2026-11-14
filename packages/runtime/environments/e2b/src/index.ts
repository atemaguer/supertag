import {
  type CapabilityIdentifier,
  type EnvironmentPlan,
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
} from "@supertag/worker-sdk";
import { Sandbox, type SandboxOpts } from "e2b";
import { adaptE2B, type E2BSandboxClient } from "./sandbox.js";
export const E2B_REMOTE_SANDBOX_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.execution.remote-sandbox.e2b",
  version: 1,
};
export type { E2BSandboxClient } from "./sandbox.js";

export interface E2BSandboxFactory {
  create(options: SandboxOpts): Promise<E2BSandboxClient>;
}

export interface E2BExecutionEnvironmentProviderOptions {
  /** E2B template or snapshot name. Defaults to E2B's `base` template. */
  readonly template?: string;
  /** Base directory created inside each sandbox. */
  readonly rootDirectory?: string;
  /** Sandbox lifetime enforced by E2B. */
  readonly sandboxTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxOutputCharacters?: number;
  /** Test/custom-client seam. Authentication must still remain outside Worker Profiles. */
  readonly sandboxFactory?: E2BSandboxFactory;
}

const defaultSandboxFactory: E2BSandboxFactory = {
  async create(options) {
    return await Sandbox.create(options);
  },
};
const E2B_BACKEND: Pick<SandboxBackend, "guarantees" | "capabilities"> = {
  guarantees: {
    filesystemIsolation: "sandbox",
    networkPolicy: "enforced",
    processTreeTermination: true,
    scopedHttp: false,
  },
  capabilities: {
    networkModes: ["none", "allowlist", "unrestricted"],
    readOnlyMounts: true,
    boundedSymlinkSafeReads: true,
    outputFiles: true,
    streamOutput: true,
    streamInput: true,
  },
};
/** E2B adapter; portable preparation and lifecycle live in SandboxExecutionEnvironmentProvider. */
export class E2BExecutionEnvironmentProvider extends SandboxExecutionEnvironmentProvider {
  constructor(options: E2BExecutionEnvironmentProviderOptions = {}) {
    const backend: SandboxBackend = {
      ...E2B_BACKEND,
      async create(input) {
        const sandbox = await (options.sandboxFactory ?? defaultSandboxFactory).create({
          metadata: {
            "supertag.taskId": input.taskId,
            "supertag.attemptId": input.attemptId,
            "supertag.tagId": input.tagId,
          },
          ...networkOptions(input.network),
          ...(options.template === undefined ? {} : { template: options.template }),
          ...(options.sandboxTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.sandboxTimeoutMs }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return adaptE2B(sandbox);
      },
    };
    super({
      id: "e2b",
      backend,
      capabilities: [E2B_REMOTE_SANDBOX_CAPABILITY],
      rootDirectory: options.rootDirectory ?? "/home/user/supertag-tasks",
      ...(options.maxOutputCharacters === undefined
        ? {}
        : { maxOutputCharacters: options.maxOutputCharacters }),
    });
  }
}

function networkOptions(
  network: EnvironmentPlan["network"],
): Pick<SandboxOpts, "allowInternetAccess" | "network"> {
  switch (network.mode) {
    case "none":
      return { allowInternetAccess: false };
    case "unrestricted":
      return { allowInternetAccess: true };
    case "allowlist": {
      const hosts = network.allowedHosts ?? [];
      if (hosts.length === 0) {
        throw new Error("An E2B network allowlist must contain at least one host");
      }
      return { network: { allowOut: [...hosts] } };
    }
  }
}
