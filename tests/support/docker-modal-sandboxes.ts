/**
 * Modal Workspace clients backed by local Docker, for reproducing what a real Modal sandbox runs.
 * `buildImage` is `docker build` over the same registry image and Dockerfile commands Modal
 * receives; a setup sandbox or Task sandbox is a `docker run` container with the same CPU and
 * memory bounds; `exec` is `docker exec`; `snapshotFilesystem` is `docker commit`. Every container
 * and image carries one run label so cleanup removes all of them. No Modal API is ever called.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type {
  ModalProcessClient,
  ModalSandboxClient,
  ModalSandboxFactory,
  ModalSetupSandboxClient,
  ModalWorkspaceClient,
} from "../../packages/runtime/environments/modal/src/index.ts";

const execute = promisify(execFile);

export class DockerModalWorld {
  readonly label: string;
  readonly #docker: string;
  readonly #images = new Set<string>();
  readonly #containers = new Set<string>();

  constructor(options: { readonly docker?: string } = {}) {
    this.#docker = options.docker ?? "docker";
    this.label = `supertag.docker-modal=${randomUUID()}`;
  }

  async #run(args: readonly string[], input?: string): Promise<string> {
    const child = execute(this.#docker, [...args], { maxBuffer: 64 * 1024 * 1024 });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout.trim();
  }

  async #container(
    image: string,
    input: { readonly cpu?: number; readonly memoryMiB?: number; readonly blockNetwork?: boolean },
  ): Promise<string> {
    const id = await this.#run([
      "run",
      "-d",
      "--label",
      this.label,
      ...(input.cpu === undefined ? [] : ["--cpus", String(input.cpu)]),
      ...(input.memoryMiB === undefined
        ? []
        : ["--memory", `${input.memoryMiB}m`, "--memory-swap", `${input.memoryMiB}m`]),
      ...(input.blockNetwork ? ["--network", "none"] : []),
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    ]);
    this.#containers.add(id);
    return id;
  }

  #sandbox(container: string): ModalSandboxClient {
    const world = this;
    return {
      sandboxId: container,
      async exec(command, options) {
        // Values go through a private env file, never the docker command line other users see.
        const entries = Object.entries(options.env ?? {});
        const directory =
          entries.length === 0 ? undefined : await mkdtemp(join(tmpdir(), "supertag-docker-env-"));
        const envFile = directory === undefined ? undefined : join(directory, "env");
        try {
          if (envFile !== undefined) {
            for (const [key, value] of entries)
              if (/[\r\n\0]/u.test(value))
                throw new Error(`Docker exec cannot pass ${key}: its value contains a newline`);
            await writeFile(envFile, entries.map(([key, value]) => `${key}=${value}\n`).join(""), {
              mode: 0o600,
              flag: "wx",
            });
          }
          const child = spawn(
            world.#docker,
            [
              "exec",
              "-i",
              ...(options.workdir === undefined ? [] : ["-w", options.workdir]),
              ...(envFile === undefined ? [] : ["--env-file", envFile]),
              container,
              ...command,
            ],
            { stdio: "pipe" },
          );
          const removed = () => {
            if (directory !== undefined)
              void rm(directory, { recursive: true, force: true }).catch(() => undefined);
          };
          child.once("error", removed);
          child.once("close", removed);
          return processClient(child);
        } catch (error) {
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
          throw error;
        }
      },
      async terminate() {
        await world.#run(["rm", "-f", container]).catch(() => "");
        world.#containers.delete(container);
        return 0;
      },
    };
  }

  modal(): { workspaceClient: ModalWorkspaceClient; sandboxFactory: ModalSandboxFactory } {
    const world = this;
    return {
      workspaceClient: {
        async buildImage(input) {
          const context = await mkdtemp(join(tmpdir(), "supertag-docker-modal-"));
          try {
            await writeFile(
              join(context, "Dockerfile"),
              [`FROM ${input.image}`, ...input.commands, ""].join("\n"),
            );
            const tag = `supertag-docker-modal:${randomUUID().slice(0, 12)}`;
            await world.#run(["build", "-q", "--label", world.label, "-t", tag, context]);
            world.#images.add(tag);
            return tag;
          } finally {
            await rm(context, { recursive: true, force: true });
          }
        },
        async createSetupSandbox(input) {
          const container = await world.#container(input.imageId, {
            ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
            ...(input.memoryMiB === undefined ? {} : { memoryMiB: input.memoryMiB }),
          });
          return {
            ...world.#sandbox(container),
            async snapshotFilesystem() {
              const image = await world.#run(["commit", container]);
              world.#images.add(image);
              return image;
            },
          } satisfies ModalSetupSandboxClient;
        },
        async deleteImage(input) {
          await world.#run(["rmi", "-f", input.imageId]).catch(() => "");
          world.#images.delete(input.imageId);
        },
      },
      sandboxFactory: {
        async create(input) {
          const container = await world.#container(input.imageId ?? input.image, {
            ...(input.params.cpu === undefined ? {} : { cpu: input.params.cpu }),
            ...(input.params.memoryMiB === undefined ? {} : { memoryMiB: input.params.memoryMiB }),
            blockNetwork: input.params.blockNetwork === true,
          });
          return world.#sandbox(container);
        },
      },
    };
  }

  /** Removes every container and image this world created. */
  async cleanup(): Promise<void> {
    const labelled = await this.#run(["ps", "-aq", "--filter", `label=${this.label}`]).catch(
      () => "",
    );
    const containers = new Set([...this.#containers, ...labelled.split("\n").filter(Boolean)]);
    if (containers.size > 0) await this.#run(["rm", "-f", ...containers]).catch(() => "");
    this.#containers.clear();
    for (const image of this.#images) await this.#run(["rmi", "-f", image]).catch(() => "");
    this.#images.clear();
  }
}

function processClient(child: ChildProcess): ModalProcessClient {
  const done = new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("close", (code, signal) => resolve(code ?? 128 + signalNumber(signal)));
  });
  child.stdin?.on("error", () => {});
  return {
    stdin: {
      writeBytes: (bytes) =>
        new Promise<void>((resolve, reject) =>
          child.stdin?.write(bytes, (error) => (error ? reject(error) : resolve())),
        ),
      close: () =>
        new Promise<void>((resolve) => {
          child.stdin?.end(() => resolve());
        }),
    },
    stdout: Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr as Readable) as ReadableStream<Uint8Array>,
    wait: () => done,
  };
}

function signalNumber(signal: NodeJS.Signals | null): number {
  return signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0;
}
