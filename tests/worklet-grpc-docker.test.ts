import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";

const execute = promisify(execFile);
const suite = process.env["SUPERTAG_DOCKER_GRPC_WORKLETS"] === "1" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const adminToken = randomUUID();
const credentials = {
  ...process.env,
  SUPERTAG_TEST_ADMIN_TOKEN: randomUUID(),
  SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
};
interface Host {
  id: string;
  connectionGeneration: number;
  connectionStatus: string;
}
interface TaskState {
  assignment: { status: string; result?: { text?: string }; attemptCount: number };
  attempts: Array<{
    id: string;
    status: string;
    workerProfile: { id: string; revision: string };
    workerSnapshot: {
      placement?: {
        workerHostId?: string;
        workletId?: string;
        workerId?: string;
        reservation?: { id: string; expiresAt: string };
      };
    };
  }>;
  events: Array<{ payload?: { journalSequence?: number; text?: string } }>;
}
interface Placement {
  workerHostId: string;
  workletId: string;
  workerId: string;
  workerProfile: { id: string; revision: string };
  reservation?: { id: string; expiresAt: string };
}

suite("Control Plane with two Docker Worklets over gRPC", () => {
  let directory = "",
    network = "",
    image = "",
    apiUrl = "";
  const containers: string[] = [];
  const workerCredentials = new Map<string, string>();
  const name = (service: string) => `${network}-${service}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-worklet-grpc-"));
    network = `supertag-wgrpc-${randomUUID().slice(0, 8)}`;
    image = `${network}:test`;
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
      "/CN=control-plane",
      "-addext",
      "subjectAltName=DNS:control-plane,DNS:execution",
    ]);
    await execute(
      "pnpm",
      [
        "exec",
        "esbuild",
        "tests/fixtures/worklet-grpc-docker-worker.ts",
        "tests/fixtures/worklet-grpc-docker-control-plane.ts",
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
    await cp(join(repositoryRoot, "packages/store/drizzle"), join(directory, "drizzle"), {
      recursive: true,
    });
    await writeFile(
      join(directory, "Dockerfile"),
      [
        "FROM node:24-bookworm-slim",
        "WORKDIR /app",
        "RUN npm install --omit=dev better-sqlite3@12.11.1 ws@8.19.0 && groupadd -g 10001 workload && useradd -u 10001 -g workload workload",
        'RUN echo \'{"type":"module"}\' > package.json',
        "COPY app/ /app/",
        "COPY drizzle/ /drizzle/",
      ].join("\n"),
    );
    await execute("docker", ["build", "-t", image, directory], { maxBuffer: 20 * 1024 * 1024 });
    await execute("docker", ["network", "create", network]);
    await launch("execution", "shared-execution-grpc-service.js");
    await ready("execution", "shared gRPC execution ready");
    await launch("control-plane", "worklet-grpc-docker-control-plane.js", [
      "-p",
      "127.0.0.1::8790",
    ]);
    await ready("control-plane", "Control Plane fixture ready");
    const port = (
      await execute("docker", ["port", name("control-plane"), "8790/tcp"])
    ).stdout.match(/:(\d+)\s*$/u)?.[1];
    if (!port) throw new Error("Missing Control Plane published port");
    apiUrl = `http://127.0.0.1:${port}`;
    for (const host of ["worker-a", "worker-b"]) {
      workerCredentials.set(host, (await api<{ token: string }>("enroll", { id: host })).token);
      await launchWorker(host);
    }
    await eventually(
      async () =>
        (await api<Host[]>("hosts")).filter((host) => host.connectionStatus === "connected")
          .length === 2,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      containers.map((container) =>
        execute("docker", ["rm", "-f", container]).catch(() => undefined),
      ),
    );
    if (network) await execute("docker", ["network", "rm", network]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("schedules shared work, resumes journals after a connection restart, and preserves crash uncertainty", async () => {
    onTestFailed(async () => {
      for (const container of containers) {
        const logs = await execute("docker", ["logs", "--tail", "25", container]);
        process.stderr.write(`${container}: ${logs.stdout}${logs.stderr}\n`);
      }
    });
    const held = await api<Placement>("select", {
      host: "worker-a",
      profile: "worker-a-specialist",
    });
    expect(held).toMatchObject({
      workerHostId: "worker-a",
      workletId: "worker-a-worklet",
      workerId: "worker-a-worker",
      workerProfile: { id: "worker-a-specialist", revision: "1" },
      reservation: { id: expect.any(String), expiresAt: expect.any(String) },
    });
    expect(
      await api<Placement | null>("select", {
        host: "worker-a",
        profile: "worker-a-specialist",
      }),
    ).toBeNull();
    await api("release", { placement: held });
    const afterRelease = await api<Placement>("select", {
      host: "worker-a",
      profile: "worker-a-specialist",
    });
    expect(afterRelease.reservation?.id).not.toBe(held.reservation?.id);
    await api("release", { placement: afterRelease });

    await assign("profile-task", "worker-a", "worker-a-specialist");
    const profiled = await completed("profile-task");
    expect(profiled.assignment.result?.text).toBe("profile:worker-a-specialist");
    expect(profiled.attempts).toHaveLength(1);
    expect(profiled.attempts[0]).toMatchObject({
      workerProfile: { id: "worker-a-specialist", revision: "1" },
      workerSnapshot: {
        placement: {
          workerHostId: "worker-a",
          workletId: "worker-a-worklet",
          workerId: "worker-a-worker",
          reservation: { id: expect.any(String), expiresAt: expect.any(String) },
        },
      },
    });

    await assign("writer-task", "worker-a");
    await completed("writer-task");
    await assign("reader-task", "worker-b");
    expect((await completed("reader-task")).assignment.result?.text).toBe("pooled conclusion");
    for (const host of ["worker-a", "worker-b"])
      await execute("docker", ["exec", name(host), "test", "!", "-e", "/data/pooled.txt"]);

    const before = await api<Host[]>("hosts");
    await assign("reconnect-task", "worker-a");
    await eventually(async () => (await effects()).includes("reconnect"));
    await api("restart-frontend");
    await eventually(async () => {
      const hosts = await api<Host[]>("hosts");
      return hosts.every(
        (host) =>
          host.connectionStatus === "connected" &&
          host.connectionGeneration >
            (before.find((item) => item.id === host.id)?.connectionGeneration ?? 0),
      );
    });
    const beforeRestart = await api<Host[]>("hosts");
    await execute("docker", ["kill", "--signal", "KILL", name("control-plane")]);
    await execute("docker", ["start", name("control-plane")]);
    const restartedPort = (
      await execute("docker", ["port", name("control-plane"), "8790/tcp"])
    ).stdout.match(/:(\d+)\s*$/u)?.[1];
    if (!restartedPort) throw new Error("Missing restarted Control Plane port");
    apiUrl = `http://127.0.0.1:${restartedPort}`;
    await eventually(async () => {
      const hosts = await api<Host[]>("hosts").catch(() => []);
      return (
        hosts.length === 2 &&
        hosts.every(
          (host) =>
            host.connectionStatus === "connected" &&
            host.connectionGeneration >
              (beforeRestart.find((item) => item.id === host.id)?.connectionGeneration ?? 0),
        )
      );
    });
    const recovered = await completed("reconnect-task");
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.assignment.result?.text).toContain("resumed");
    expect((await effects()).filter((line) => line === "reconnect")).toHaveLength(1);
    const sequences = recovered.events.flatMap((event) =>
      event.payload?.journalSequence === undefined ? [] : [event.payload.journalSequence],
    );
    expect(sequences.length).toBeGreaterThan(100);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));

    await assign("cancelled-task", "worker-a");
    await assign("survivor-task", "worker-b");
    await eventually(async () => (await effects()).includes("cancelled"));
    await api("cancel", { taskId: "cancelled-task" });
    expect((await completed("survivor-task")).assignment.result?.text).toBe("survived");
    expect((await state("cancelled-task")).assignment.status).toBe("cancelled");
    await eventually(async () =>
      (await api<Host[]>("hosts")).some(
        (host) => host.id === "worker-a" && host.connectionStatus === "connected",
      ),
    );

    await assign("crash-task", "worker-b");
    await eventually(async () => (await effects()).includes("crash"));
    const crashed = await state("crash-task");
    const attemptId = crashed.attempts[0]?.id;
    expect(attemptId).toBeTruthy();
    const beforeCrash =
      (await api<Host[]>("hosts")).find((host) => host.id === "worker-b")?.connectionGeneration ??
      0;
    await execute("docker", ["kill", "--signal", "KILL", name("worker-b")]);
    await execute("docker", ["start", name("worker-b")]);
    await eventually(async () =>
      (await api<Host[]>("hosts")).some(
        (host) =>
          host.id === "worker-b" &&
          host.connectionStatus === "connected" &&
          host.connectionGeneration > beforeCrash,
      ),
    );
    await eventually(
      async () =>
        (await api<{ status: string } | null>("inspect", { attemptId }))?.status === "unknown",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    expect((await state("crash-task")).attempts).toHaveLength(1);
    expect((await effects()).filter((line) => line === "crash")).toHaveLength(1);
    // Killing a Harness host cannot prove that remote effects stopped. The durable receipt
    // stays unknown and the coordinator must not automatically execute a replacement.
    expect((await api<{ status: string }>("inspect", { attemptId })).status).toBe("unknown");
  }, 120_000);

  async function launch(
    service: string,
    entrypoint: string,
    options: string[] = [],
    environment: NodeJS.ProcessEnv = credentials,
  ) {
    containers.push(name(service));
    await execute(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name(service),
        "--hostname",
        name(service),
        "--network",
        network,
        "--network-alias",
        service,
        "-v",
        service.startsWith("worker-")
          ? `${join(directory, "certificates/server.crt")}:/certificates/server.crt:ro`
          : `${join(directory, "certificates")}:/certificates:ro`,
        "-e",
        service === "control-plane"
          ? "SUPERTAG_TEST_ADMIN_TOKEN"
          : "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
        ...options,
        image,
        "node",
        `/app/${entrypoint}`,
      ],
      { env: environment },
    );
  }
  async function launchWorker(host: string) {
    await launch(
      host,
      "worklet-grpc-docker-worker.js",
      ["-e", "WORKER_ID", "-e", "SUPERTAG_WORKLET_CREDENTIAL"],
      {
        ...credentials,
        WORKER_ID: host,
        SUPERTAG_WORKLET_CREDENTIAL: workerCredentials.get(host),
      },
    );
    await ready(host, '"ready":true');
  }
  async function ready(service: string, marker: string) {
    await eventually(async () => {
      const logs = await execute("docker", ["logs", name(service)]);
      const running = (
        await execute("docker", ["inspect", "-f", "{{.State.Running}}", name(service)])
      ).stdout.trim();
      if (running !== "true") throw new Error(`${service} exited: ${logs.stderr}`);
      return logs.stdout.includes(marker);
    });
  }
  async function api<T = unknown>(route: string, body: object = {}): Promise<T> {
    const response = await fetch(`${apiUrl}/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.SUPERTAG_TEST_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`Fixture ${route}: ${JSON.stringify(value)}`);
    return value as T;
  }
  async function assign(taskId: string, host: string, profile = host) {
    await api("assign", { taskId, host, profile });
  }
  async function state(taskId: string) {
    return api<TaskState>("task", { taskId });
  }
  async function completed(taskId: string) {
    let current: TaskState | undefined;
    await eventually(async () => {
      current = await state(taskId);
      if (current.assignment.status === "failed")
        throw new Error(`Task ${taskId} failed: ${JSON.stringify(current)}`);
      return current.attempts.some((attempt) => attempt.status === "completed");
    }, 60_000);
    return current as TaskState;
  }
  async function effects() {
    return (
      await execute("docker", ["exec", name("execution"), "cat", "/data/effects.txt"]).catch(
        () => ({ stdout: "" }),
      )
    ).stdout
      .trim()
      .split("\n");
  }
});

async function eventually(probe: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for distributed fixture state");
}
