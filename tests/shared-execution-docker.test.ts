import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const enabled = process.env["SUPERTAG_DOCKER_SHARED_EXECUTION"] === "1";
const suite = enabled ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const fixturePath = join(repositoryRoot, "tests/fixtures/shared-execution-worker.ts");
const adminToken = "docker-shared-execution-admin-token";

suite("shared execution Docker boundary", () => {
  let directory = "";
  let container = "";
  let image = "";
  let baseUrl = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-shared-docker-"));
    await execute("mkdir", ["-p", join(directory, "workspace"), join(directory, "state")]);
    const suffix = randomUUID().slice(0, 8);
    container = `supertag-shared-${suffix}`;
    image = `supertag-shared-execution:${suffix}`;
    await execute(
      "docker",
      ["build", "-t", image, "packages/runtime/environments/shared-execution"],
      { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    await execute("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::8787",
      "-e",
      `SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN=${adminToken}`,
      "-e",
      "SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID=docker-shared",
      "-v",
      `${join(directory, "workspace")}:/data`,
      "-v",
      `${join(directory, "state")}:/state`,
      image,
    ]);
    const port = await execute("docker", ["port", container, "8787/tcp"]);
    const match = /:(\d+)\s*$/u.exec(port.stdout.trim());
    if (!match) throw new Error(`Could not parse Docker port: ${port.stdout}`);
    baseUrl = `http://127.0.0.1:${match[1]}`;
    await eventually(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok ? true : undefined;
      } catch {
        const inspection = await execute("docker", [
          "inspect",
          "-f",
          "{{.State.Running}}",
          container,
        ]);
        if (inspection.stdout.trim() !== "true") {
          const logs = await execute("docker", ["logs", container]);
          throw new Error(`Shared execution container exited:\n${logs.stdout}${logs.stderr}`);
        }
        return undefined;
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (container) await execute("docker", ["rm", "-f", container]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("lets independent Workers share state and isolates Attempt cancellation", async () => {
    const writer = await runWorker("writer", "attempt-writer");
    expect(writer.events).toContainEqual(
      expect.objectContaining({
        type: "output.message",
        message: { role: "teammate", text: "wrote pooled.txt" },
      }),
    );
    const reader = await runWorker("reader", "attempt-reader");
    expect(terminal(reader.events)?.message.text).toBe("worker-a");

    const [cancelled, survivor] = await Promise.all([
      runWorker("cancelled", "attempt-cancelled"),
      runWorker("survivor", "attempt-survivor"),
    ]);
    expect(cancelled.events.at(-1)?.type).toBe("execution.failed");
    expect(terminal(survivor.events)?.message.text).toBe("survived");
    expect(await readFile(join(directory, "workspace", "survivor.txt"), "utf8")).toBe("worker-b");

    const state = await readFile(join(directory, "state", "state.json"), "utf8");
    expect(state).not.toContain(adminToken);
    expect(state).not.toContain("stx_");
  }, 30_000);

  async function runWorker(mode: string, attemptId: string) {
    const result = await execute(
      "pnpm",
      ["exec", "tsx", "--conditions=development", fixturePath, mode, attemptId],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          SUPERTAG_SHARED_EXECUTION_URL: baseUrl,
          SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout) as {
      events: Array<{ type: string; message?: { text: string } }>;
    };
  }
});

function terminal(events: Array<{ type: string; message?: { text: string } }>) {
  return events.findLast((event) => event.type === "output.message");
}

async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Docker shared execution service");
}
