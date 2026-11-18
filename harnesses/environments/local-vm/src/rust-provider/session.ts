/**
 * The `local-vm` environment's Workspace provider: each Task runs in a container on the Worker
 * Host's own container runtime, which on macOS is a Linux virtual machine. The harness and its
 * keys stay on the host; file and command tools run in the container, with no network.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type ContainerProviderOptions,
  createContainerWorkspaceSession,
  nativePlatform,
  type SandboxWorkspaceSession,
  validCodexVersion,
  WorkspaceConfigurationError,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";

/**
 * The image a Workspace runs when the operator names none: a pinned Debian base with the tools
 * a coding agent expects, and an unprivileged `user` with no sudo and no setuid or setgid program. Node and npm come from a pinned
 * official Node 22 image: Debian's npm 9 never exits after an install through an HTTPS proxy,
 * which is how a Task's commands reach the network here. It is built once per host, on the first
 * allocation, for the host's own platform. Image names are fully qualified: Podman refuses a short
 * name it would have to resolve without a terminal.
 */
export const BASE_DOCKERFILE = `FROM docker.io/library/node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS node
FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
    ca-certificates curl git procps python3 python3-venv ripgrep \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash --uid 1000 user
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \\
 && find / -xdev -type f -perm /6000 -exec chmod u-s,g-s {} +
USER user
WORKDIR /home/user
`;

const RUNTIMES = new Set(["docker", "podman"]);

export interface LocalVmOptions {
  readonly runtime: string;
  readonly image: ContainerProviderOptions["image"];
  readonly user: string;
  readonly memory: string;
  /** For a Codex Worker Host, its Codex version: every image gets that `codex` on top. */
  readonly codexVersion?: string;
}

/** Docker when its CLI is on PATH, then Podman; Docker otherwise, to name in the error. */
function runtimeOnPath(path: string | undefined): string {
  const found = (name: string) =>
    (path ?? "").split(delimiter).some((directory) => {
      try {
        accessSync(join(directory, name), constants.X_OK);
        return directory !== "";
      } catch {
        return false;
      }
    });
  return ["docker", "podman"].find(found) ?? "docker";
}

/** The provider's settings, from the environment the Worker Host passes it. */
export function localVmOptions(environment: NodeJS.ProcessEnv = process.env): LocalVmOptions {
  const runtime = environment["SUPERTAG_LOCAL_VM_RUNTIME"] || runtimeOnPath(environment["PATH"]);
  if (!RUNTIMES.has(runtime)) throw new Error("The local-vm runtime must be docker or podman");
  const image = environment["SUPERTAG_LOCAL_VM_IMAGE"] || undefined;
  const user = environment["SUPERTAG_LOCAL_VM_USER"] || "user";
  const memory = environment["SUPERTAG_LOCAL_VM_MEMORY"] || "8g";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u.test(user))
    throw new Error("The local-vm user is invalid");
  if (!/^[1-9][0-9]{0,5}[kmg]$/u.test(memory)) throw new Error("The local-vm memory is invalid");
  const codexVersion = environment["SUPERTAG_LOCAL_VM_CODEX_VERSION"] || undefined;
  if (codexVersion !== undefined && !validCodexVersion(codexVersion))
    throw new Error("The local-vm Codex version is invalid");
  return {
    runtime,
    image: image ?? { dockerfile: BASE_DOCKERFILE },
    user,
    memory,
    ...(codexVersion === undefined ? {} : { codexVersion }),
  };
}

/**
 * Why a Podman host's Task Attempts fail to start. Under Podman a Task process keeps inheritable
 * capabilities, can signal the egress relay, and reaches places Docker keeps from it, so local-vm
 * refuses it until its isolation suite passes there.
 */
export const PODMAN_REFUSAL =
  "Podman doesn't yet give local-vm the isolation it requires; use Docker";

export function createLocalVmWorkspaceSession(
  options: LocalVmOptions = localVmOptions(),
  log: (line: string) => void = () => {},
  /** Only the isolation suite sets this, to watch for Podman's parity in CI. */
  testing: { readonly allowPodman?: boolean } = {},
): SandboxWorkspaceSession {
  const session = createContainerWorkspaceSession({
    name: "local-vm",
    label: "supertag.local-vm",
    runtime: options.runtime,
    image: options.image,
    user: options.user,
    platform: nativePlatform(),
    buildImages: true,
    dependencyCaches: true,
    runFlags: ["--memory", options.memory],
    ...(options.codexVersion === undefined ? {} : { codexVersion: options.codexVersion }),
    log,
  });
  if (options.runtime === "podman" && !testing.allowPodman)
    session.allocate = async () => {
      throw new WorkspaceConfigurationError(PODMAN_REFUSAL);
    };
  return session;
}
