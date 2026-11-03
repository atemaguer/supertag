import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  generateCoordinationTls,
  startCoordinationTls,
} from "../examples/shared-organization/coordination-tls.mjs";
import { stageWorkerAuth } from "../examples/shared-organization/worker-auth.mjs";
import type { TaskAttemptEvent } from "../packages/runtime/sdk/src/index.js";

const run = promisify(execFile);

/** Fresh Linux containers with isolated subscription homes and exact per-Attempt input. */
export async function createDockerSessionWorkers(
  directory: string,
  root: string,
  provider: string,
  mode: string,
) {
  const build = join(directory, "docker-build");
  await mkdir(build, { mode: 0o700 });
  const image = `supertag-session-worker:${randomUUID()}`;
  await run("pnpm", ["--filter", "supertag-ai", "pack", "--pack-destination", build], {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const archives = (await readdir(build)).filter((path) => path.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = archives[0];
  assert(archive);
  await copyFile(join(build, archive), join(build, "supertag-ai.tgz"));
  await copyFile(
    join(root, "scripts/session-persistence-docker-worker.mjs"),
    join(build, "worker.mjs"),
  );
  await writeFile(
    join(build, "Dockerfile"),
    [
      "FROM node:22-bookworm-slim",
      "RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git && rm -rf /var/lib/apt/lists/*",
      "WORKDIR /app",
      "COPY supertag-ai.tgz /app/supertag-ai.tgz",
      "RUN npm install --omit=dev --no-audit --no-fund /app/supertag-ai.tgz && rm /app/supertag-ai.tgz",
      "COPY worker.mjs /app/worker.mjs",
      'ENTRYPOINT ["node", "/app/worker.mjs"]',
    ].join("\n"),
  );
  let certificates: Awaited<ReturnType<typeof generateCoordinationTls>>;
  try {
    await run("docker", ["build", "-t", image, build], {
      timeout: 300_000,
      maxBuffer: 30 * 1024 * 1024,
    });
    certificates = await generateCoordinationTls(join(directory, "docker-tls"));
  } catch (error) {
    await run("docker", ["image", "rm", image], { timeout: 30_000 }).catch(() => undefined);
    throw error;
  }
  let proxy: Awaited<ReturnType<typeof startCoordinationTls>> | undefined;
  return {
    async setUpstream(targetUrl: string): Promise<string> {
      await proxy?.close();
      proxy = await startCoordinationTls({ targetUrl, ...certificates });
      return proxy.url.replace(
        "127.0.0.1",
        process.platform === "linux" ? "localhost" : "host.docker.internal",
      );
    },
    async execute(
      specPath: string,
      source: string,
      runtime: string,
    ): Promise<{ pid: number; containerId: string; events: TaskAttemptEvent[] }> {
      const homeDirectory = join(runtime, "home");
      await stageWorkerAuth({ name: provider === "codex" ? "codex" : "claude", homeDirectory });
      const name = `supertag-session-${randomUUID()}`;
      const environment = {
        HOME: "/worker-home",
        NODE_EXTRA_CA_CERTS: "/run/supertag/ca.pem",
        SUPERTAG_SESSION_LIVE_PROVIDER: provider,
        SUPERTAG_SESSION_LIVE_MODE: mode,
        ...(provider === "codex"
          ? { CODEX_HOME: "/worker-home/.codex" }
          : {
              CLAUDE_CONFIG_DIR: "/worker-home/.claude",
              CLAUDE_SECURESTORAGE_CONFIG_DIR: "/worker-home/.claude",
            }),
      };
      let containerId: string | undefined;
      try {
        const created = await run(
          "docker",
          [
            "create",
            "--name",
            name,
            "--init",
            "--read-only",
            "--cap-drop",
            "ALL",
            // The Docker default seccomp profile blocks the namespace calls used
            // by Codex's native bwrap sandbox. Keep that sandbox enabled and permit
            // its setup in this nonroot, capability-free test container only.
            ...(provider === "codex" ? ["--security-opt", "seccomp=unconfined"] : []),
            "--tmpfs",
            "/tmp:rw,nosuid,nodev",
            "--user",
            `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            ...(process.platform === "linux" ? ["--network", "host"] : []),
            "--mount",
            `type=bind,src=${specPath},dst=/run/supertag/spec.json,readonly`,
            "--mount",
            `type=bind,src=${certificates.caFile},dst=/run/supertag/ca.pem,readonly`,
            "--mount",
            `type=bind,src=${source},dst=/source,readonly`,
            "--mount",
            `type=bind,src=${runtime},dst=/runtime`,
            "--mount",
            `type=bind,src=${homeDirectory},dst=/worker-home`,
            ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
            image,
          ],
          { timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        containerId = created.stdout.trim();
        const result = await run("docker", ["start", "--attach", containerId], {
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { ...JSON.parse(result.stdout), containerId };
      } finally {
        // The known randomized name also covers a create response lost before the ID arrived.
        try {
          await run("docker", ["rm", "--force", containerId ?? name], { timeout: 15_000 }).catch(
            (error: unknown) => {
              if (!String((error as { stderr?: string }).stderr).includes("No such container"))
                throw error;
            },
          );
        } finally {
          await rm(homeDirectory, { recursive: true, force: true });
        }
      }
    },
    async close() {
      await proxy?.close();
      await run("docker", ["image", "rm", image], { timeout: 30_000 });
    },
  };
}
