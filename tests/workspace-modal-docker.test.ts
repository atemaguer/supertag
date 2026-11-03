import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ModalWorkspaceEnvironment } from "../packages/runtime/environments/modal/src/index.ts";
import { runWorkspaceEnvironmentConformance } from "../packages/runtime/sdk/src/conformance.ts";
import {
  bundleTaskObjects,
  bundleTrustedCommit,
  resolveWorkspaceMcpServers,
} from "../packages/runtime/sdk/src/index.ts";
import { workspaceDefinition } from "../packages/runtime/sdk/src/workspace-environment.ts";
import { DockerModalWorld } from "./support/docker-modal-sandboxes.ts";

const git = promisify(execFile);
const enabled = process.env["SUPERTAG_DOCKER_MODAL_WORKSPACE"] === "1";
const suite = enabled ? describe : describe.skip;

// The live Modal suite's settings, with Docker standing in for Modal's image builds and sandboxes.
suite("Modal Workspace environment on Docker", () => {
  it("passes the Workspace environment conformance suite on python:3.13-slim at 0.125 CPU and 128 MiB", async () => {
    const world = new DockerModalWorld({
      docker: process.env["SUPERTAG_DOCKER"] ?? "docker",
    });
    const scratch = await mkdtemp(join(tmpdir(), "supertag-docker-modal-workspace-"));
    try {
      const report = await runWorkspaceEnvironmentConformance(async (repository) => {
        const stagingDirectory = join(scratch, "staging");
        await mkdir(stagingDirectory, { recursive: true });
        return {
          environment: new ModalWorkspaceEnvironment({
            appName: "supertag-docker",
            stagingDirectory,
            image: "python:3.13-slim",
            cpu: 0.125,
            memoryMiB: 128,
            sandboxTimeoutMs: 180_000,
            setupTimeoutMs: 180_000,
            ...world.modal(),
          }),
          define: async ({ taskId, trustedCommit, setup }) =>
            workspaceDefinition({
              workspace: repository.workspace,
              source: "https://example.invalid/supertag-conformance.git",
              trustedCommit,
              content: await bundleTrustedCommit({
                repository: repository.path,
                trustedCommit,
                directory: stagingDirectory,
              }),
              ...(setup === undefined ? {} : { setup }),
              harness: { commands: ["sh"] },
              taskId,
            }),
          objects: ({ trustedCommit, head }) =>
            bundleTaskObjects({
              repository: repository.path,
              trustedCommit,
              head,
              directory: stagingDirectory,
            }),
          deliver: async (branch, result) => {
            if (result.objects === undefined) return;
            await git(
              "git",
              [
                "-C",
                repository.path,
                "-c",
                "core.hooksPath=/dev/null",
                "fetch",
                "--no-tags",
                result.objects.bundle,
                `+refs/heads/${branch}:refs/heads/${branch}`,
              ],
              { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
            );
          },
        };
      });
      expect(report.findings).toEqual([]);
    } finally {
      await world.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 900_000);

  it.each([
    ["remoteUser", { remoteUser: "nobody" }],
    ["only the Dockerfile", {}],
  ] as const)(
    "installs Node.js for a stdio server as root under a devcontainer USER set by %s, and keeps that user",
    async (_source, declared) => {
      const docker = process.env["SUPERTAG_DOCKER"] ?? "docker";
      const world = new DockerModalWorld({ docker });
      const scratch = await mkdtemp(join(tmpdir(), "supertag-docker-modal-user-"));
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      const run = (...args: string[]) =>
        git(
          "git",
          [
            "-C",
            repository,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { env },
        );
      const repository = join(scratch, "source");
      try {
        await mkdir(repository, { recursive: true });
        await writeFile(
          join(repository, ".mcp.json"),
          JSON.stringify({ mcpServers: { tools: { command: "node", args: ["server.js"] } } }),
        );
        await writeFile(join(repository, "server.js"), "process.stdin.resume();\n");
        await run("init", "-q", "-b", "main");
        await run("add", "-A");
        await run(
          "-c",
          "user.name=SuperTag",
          "-c",
          "user.email=supertag@localhost",
          "commit",
          "-qm",
          "Trusted",
        );
        const trustedCommit = (await run("rev-parse", "HEAD")).stdout.trim();
        const stagingDirectory = join(scratch, "staging");
        await mkdir(stagingDirectory, { recursive: true });
        const environment = new ModalWorkspaceEnvironment({
          appName: "supertag-docker",
          stagingDirectory,
          image: "python:3.13-slim",
          cpu: 0.125,
          memoryMiB: 128,
          setupTimeoutMs: 180_000,
          ...world.modal(),
        });
        const definition = workspaceDefinition({
          workspace: "app",
          source: "https://example.invalid/supertag-user.git",
          trustedCommit,
          content: await bundleTrustedCommit({
            repository,
            trustedCommit,
            directory: stagingDirectory,
          }),
          mcp: await resolveWorkspaceMcpServers(repository, ["tools"], {}),
          devcontainer: {
            build: {
              dockerfile: "Dockerfile",
              dockerfileContent: "FROM python:3.13-slim\nUSER nobody\n",
              dockerfileDigest: "0".repeat(64),
            },
            ...declared,
          },
          harness: { commands: ["sh"] },
        });
        expect(environment.refuse(definition)).toBeUndefined();
        const prepared = await environment.prepare(definition);
        const { stdout } = await git(docker, [
          "run",
          "--rm",
          "--label",
          world.label,
          "--entrypoint",
          "sh",
          prepared.artifact,
          "-c",
          "id -un && node --version",
        ]);
        const [user, version] = stdout.trim().split("\n");
        expect(user).toBe("nobody");
        expect(Number(/^v(\d+)\./u.exec(version ?? "")?.[1])).toBeGreaterThanOrEqual(18);
      } finally {
        await world.cleanup();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
