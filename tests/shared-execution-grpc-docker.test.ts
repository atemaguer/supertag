import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const suite = process.env["SUPERTAG_DOCKER_GRPC_EXECUTION"] === "1" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const adminToken = randomUUID();
const credentialEnvironment = {
  ...process.env,
  SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
};

type WorkerResult = {
  hostname: string;
  events: Array<{ type: string; message?: { text: string } }>;
};

suite("gRPC execution across Docker Worker Hosts", () => {
  let directory = "";
  let network = "";
  let image = "";
  const containers: string[] = [];
  let server = "";
  let workerA = "";
  let workerB = "";
  let tlsCa = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-grpc-hosts-"));
    const suffix = randomUUID().slice(0, 8);
    network = `supertag-grpc-${suffix}`;
    image = `supertag-grpc-hosts:${suffix}`;
    server = `${network}-execution`;
    workerA = `${network}-worker-a`;
    workerB = `${network}-worker-b`;
    await mkdir(join(directory, "certificates"));
    await execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(directory, "certificates/server.key"),
      "-out",
      join(directory, "certificates/server.crt"),
      "-subj",
      "/CN=execution",
      "-addext",
      "subjectAltName=DNS:execution",
    ]);
    tlsCa = await readFile(join(directory, "certificates/server.crt"), "utf8");
    await execute(
      "pnpm",
      [
        "exec",
        "esbuild",
        "tests/fixtures/shared-execution-grpc-worker.ts",
        "tests/fixtures/shared-execution-grpc-service.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--conditions=development",
        `--outdir=${join(directory, "app")}`,
        "--external:better-sqlite3",
        "--external:ws",
        '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      ],
      { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    await writeFile(
      join(directory, "Dockerfile"),
      [
        "FROM node:24-bookworm-slim",
        "WORKDIR /app",
        "RUN npm install --omit=dev better-sqlite3@12.11.1 && groupadd -g 10001 workload && useradd -u 10001 -g workload workload",
        'RUN echo \'{"type":"module"}\' > package.json',
        "COPY app/ /app/",
        'CMD ["node", "-e", "setInterval(() => {}, 1000)"]',
      ].join("\n"),
    );
    await execute("docker", ["build", "-t", image, directory], { maxBuffer: 20 * 1024 * 1024 });
    await execute("docker", ["network", "create", network]);
    for (const name of [server, workerA, workerB]) {
      containers.push(name);
      await execute(
        "docker",
        [
          "run",
          "-d",
          "--name",
          name,
          "--hostname",
          name,
          "--network",
          network,
          ...(name === server
            ? [
                "--network-alias",
                "execution",
                "-e",
                "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
                "-v",
                `${join(directory, "certificates")}:/certificates:ro`,
                image,
                "node",
                "--input-type=module",
                "-e",
                'await import("/app/shared-execution-grpc-service.js")',
              ]
            : [image]),
        ],
        { env: credentialEnvironment },
      );
    }
    await eventually(async () => {
      const logs = await execute("docker", ["logs", server]);
      if (logs.stdout.includes("shared gRPC execution ready")) return true;
      const state = await execute("docker", ["inspect", "-f", "{{.State.Running}}", server]);
      if (state.stdout.trim() !== "true")
        throw new Error(`Execution service failed: ${logs.stderr}`);
      return undefined;
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      containers.map((name) => execute("docker", ["rm", "-f", name]).catch(() => undefined)),
    );
    if (network) await execute("docker", ["network", "rm", network]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("shares files between two Worker containers and isolates cancellation across Attempts", async () => {
    const writer = await runWorker(workerA, "writer", "attempt-writer");
    expect(terminal(writer)?.message?.text).toBe("wrote pooled.txt");
    const reader = await runWorker(workerB, "reader", "attempt-reader");
    expect(terminal(reader)?.message?.text).toBe("worker-a");
    expect(writer.hostname).toBe(workerA);
    expect(reader.hostname).toBe(workerB);
    expect(writer.hostname).not.toBe(reader.hostname);
    await Promise.all(
      [workerA, workerB].map((host) =>
        execute("docker", ["exec", host, "test", "!", "-e", "/data/pooled.txt"]),
      ),
    );

    const [cancelled, survivor] = await Promise.all([
      runWorker(workerA, "cancelled", "attempt-cancelled"),
      runWorker(workerB, "survivor", "attempt-survivor"),
    ]);
    expect(cancelled.events.at(-1)?.type).toBe("execution.failed");
    expect(terminal(survivor)?.message?.text).toBe("survived");
    expect(
      terminal(await runWorker(workerA, "survivor-reader", "attempt-read-survivor"))?.message?.text,
    ).toBe("worker-b");

    const state = (await execute("docker", ["exec", server, "cat", "/state/state.json"])).stdout;
    expect(state).not.toContain(adminToken);
    expect(state).not.toContain("stx_");
    const journal = JSON.parse(state) as {
      accesses: Record<string, { attemptId: string; revokedAt?: string }>;
      operations: Record<string, { status: string; result?: { signal?: string } }>;
    };
    expect(
      Object.values(journal.accesses)
        .map((access) => access.attemptId)
        .sort(),
    ).toEqual([
      "attempt-cancelled",
      "attempt-read-survivor",
      "attempt-reader",
      "attempt-survivor",
      "attempt-writer",
    ]);
    expect(Object.values(journal.accesses).every((access) => access.revokedAt)).toBe(true);
    expect(
      Object.values(journal.operations).some((operation) => operation.result?.signal === "SIGTERM"),
    ).toBe(true);
  }, 60_000);

  async function runWorker(host: string, mode: string, attemptId: string): Promise<WorkerResult> {
    const result = await execute(
      "docker",
      [
        "exec",
        "-e",
        "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
        "-e",
        "SUPERTAG_SHARED_EXECUTION_URL",
        "-e",
        "SUPERTAG_SHARED_EXECUTION_TLS_CA",
        host,
        "node",
        "--input-type=module",
        "-e",
        'await import("/app/shared-execution-grpc-worker.js")',
        "worker",
        mode,
        attemptId,
      ],
      {
        env: {
          ...credentialEnvironment,
          SUPERTAG_SHARED_EXECUTION_URL: "https://execution:8788",
          SUPERTAG_SHARED_EXECUTION_TLS_CA: tlsCa,
        },
        timeout: 20_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout) as WorkerResult;
  }
});

function terminal(result: WorkerResult) {
  return result.events.findLast((event) => event.type === "output.message");
}

async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Docker execution service");
}
