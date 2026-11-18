/**
 * The `local-vm` environment's Workspace provider: each Task runs in a container on the Worker
 * Host's own container runtime, which on macOS is a Linux virtual machine. The harness and its
 * keys stay on the host; file and command tools run in the container, with no network.
 */
import {
  type ContainerProviderOptions,
  createContainerWorkspaceSession,
  nativePlatform,
  type SandboxWorkspaceSession,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";

/**
 * The image a Workspace runs when the operator names none: a pinned Debian base with the tools
 * a coding agent expects, and an unprivileged `user` with no sudo. It is built once per host, on
 * the first allocation, for the host's own platform.
 */
export const BASE_DOCKERFILE = `FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
    ca-certificates curl git nodejs npm procps python3 python3-venv ripgrep \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash --uid 1000 user
USER user
WORKDIR /home/user
`;

const RUNTIMES = new Set(["docker", "podman"]);

export interface LocalVmOptions {
  readonly runtime: string;
  readonly image: ContainerProviderOptions["image"];
  readonly user: string;
  readonly memory: string;
}

/** The provider's settings, from the environment the Worker Host passes it. */
export function localVmOptions(environment: NodeJS.ProcessEnv = process.env): LocalVmOptions {
  const runtime = environment["SUPERTAG_LOCAL_VM_RUNTIME"] || "docker";
  if (!RUNTIMES.has(runtime)) throw new Error("The local-vm runtime must be docker or podman");
  const image = environment["SUPERTAG_LOCAL_VM_IMAGE"] || undefined;
  const user = environment["SUPERTAG_LOCAL_VM_USER"] || "user";
  const memory = environment["SUPERTAG_LOCAL_VM_MEMORY"] || "8g";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u.test(user))
    throw new Error("The local-vm user is invalid");
  if (!/^[1-9][0-9]{0,5}[kmg]$/u.test(memory)) throw new Error("The local-vm memory is invalid");
  return { runtime, image: image ?? { dockerfile: BASE_DOCKERFILE }, user, memory };
}

export function createLocalVmWorkspaceSession(
  options: LocalVmOptions = localVmOptions(),
  log: (line: string) => void = () => {},
): SandboxWorkspaceSession {
  return createContainerWorkspaceSession({
    name: "local-vm",
    label: "supertag.local-vm",
    runtime: options.runtime,
    image: options.image,
    user: options.user,
    platform: nativePlatform(),
    buildImages: true,
    runFlags: ["--memory", options.memory],
    log,
  });
}
