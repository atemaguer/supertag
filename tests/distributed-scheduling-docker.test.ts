import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { CONTROL_PLANE_API_VERSION } from "../apps/cli/src/control-plane-resources.js";

const execute = promisify(execFile);
const suite = process.env["SUPERTAG_DOCKER_SCHEDULING"] === "1" ? describe : describe.skip;
const root = resolve(import.meta.dirname, "..");
const adminToken = randomUUID();
type Row = Record<string, unknown>;

suite("distributed scheduling across Docker Worker Hosts", () => {
  let directory = "",
    network = "",
    image = "",
    apiUrl = "",
    tlsCa = "";
  const taskIds = new Map<string, string>();
  const containers: string[] = [];
  const name = (service: string) => `${network}-${service}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-scheduling-"));
    network = `supertag-scheduling-${randomUUID().slice(0, 8)}`;
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
      "subjectAltName=DNS:control-plane,IP:127.0.0.1",
    ]);
    tlsCa = await readFile(join(directory, "certificates/server.crt"), "utf8");
    await execute(
      "pnpm",
      [
        "exec",
        "esbuild",
        "tests/fixtures/organization-docker-control-plane.ts",
        "tests/fixtures/distributed-scheduling-docker-worker.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--conditions=development",
        `--outdir=${join(directory, "app")}`,
        "--external:better-sqlite3",
        "--external:ws",
        '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;',
      ],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    await cp(join(root, "packages/store/drizzle"), join(directory, "drizzle"), { recursive: true });
    await writeFile(
      join(directory, "Dockerfile"),
      [
        "FROM node:24-bookworm-slim",
        "WORKDIR /app",
        "RUN npm install --omit=dev better-sqlite3@12.11.1 ws@8.19.0",
        'RUN echo \'{"type":"module"}\' > package.json',
        "COPY app/ /app/",
        "COPY drizzle/ /drizzle/",
      ].join("\n"),
    );
    await execute("docker", ["build", "-t", image, directory], { maxBuffer: 20 * 1024 * 1024 });
    await execute("docker", ["network", "create", network]);
    await launchControlPlane();
    for (const host of [
      { id: "host-a", profile: "general", capacity: "1" },
      { id: "host-b", profile: "general", capacity: "2" },
      { id: "host-c", profile: "special", capacity: "1" },
    ])
      await enrollAndLaunch(host);

    // The Tag's harness pins its turns to the general Worker Hosts.
    const tag = await api("POST", "/api/v1/tags", {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "Tag",
      metadata: { name: "Scheduler manager" },
      spec: { execution: { harness: "fixture-general" } },
    });
    expect(String((tag["metadata"] as Row)["id"])).not.toHaveLength(0);
    for (const hostId of ["host-a", "host-b", "host-c"])
      await api(
        "PUT",
        `/api/v1/tags/${encodeURIComponent("Scheduler manager")}/worker-hosts/${hostId}`,
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

  it("honors capacity, draining, observability, and uncertain disconnect recovery", async () => {
    onTestFailed(async () => {
      for (const container of containers) {
        const logs = await execute("docker", ["logs", "--tail", "30", container]).catch(
          () => undefined,
        );
        if (logs) process.stderr.write(`${container}: ${logs.stdout}${logs.stderr}\n`);
      }
      process.stderr.write(`${JSON.stringify(await snapshot())}\n`);
    });

    await Promise.all(
      ["load-1", "load-2", "load-3"].map((session) =>
        start(session, "Run capacity probe hold=1800"),
      ),
    );
    const loadTaskIds = ["load-1", "load-2", "load-3"].map(taskOf);
    await eventually(async () => {
      const rows = await attempts();
      return rows.filter((row) => loadTaskIds.includes(String(row["taskId"]))).length === 3;
    });
    const loadAttempts = (await attempts()).filter((row) =>
      loadTaskIds.includes(String(row["taskId"])),
    );
    const hosts = loadAttempts.map(selectedHost);
    expect(hosts.filter((host) => host === "host-a")).toHaveLength(1);
    expect(hosts.filter((host) => host === "host-b")).toHaveLength(2);
    expect(hosts).not.toContain("host-c");
    const loadMetrics = await api("GET", "/api/v1/metrics");
    expect(loadMetrics).toMatchObject({
      values: {
        scheduling: {
          placedAttempts: 3,
          reservations: { consumed: 3 },
          workerHosts: expect.arrayContaining([
            expect.objectContaining({ id: "host-a", activeAttempts: 1, utilization: 1 }),
            expect.objectContaining({ id: "host-b", activeAttempts: 2, utilization: 1 }),
          ]),
        },
      },
    });
    await eventually(async () =>
      (await Promise.all(loadTaskIds.map(taskRow))).every((row) => row?.["status"] === "completed"),
    );

    await api("POST", "/api/v1/worker-hosts/host-a/drain");
    const drained = await start("drained-placement", "Run while host-a drains hold=25");
    await eventually(async () => (await taskRow(drained))?.["status"] === "completed");
    expect(selectedHost((await attempts()).find((row) => row["taskId"] === drained))).toBe(
      "host-b",
    );

    const disconnect = await start("disconnect", "Hold while Worker Host disconnects hold=15000");
    await eventually(async () =>
      (await attempts()).some(
        (row) => row["taskId"] === disconnect && selectedHost(row) === "host-b",
      ),
    );
    await execute("docker", ["kill", "--signal", "KILL", name("host-b")]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    expect((await attempts()).filter((row) => row["taskId"] === disconnect)).toHaveLength(1);
    expect((await taskRow(disconnect))?.["status"]).toBe("running");

    const taskResource = await api("GET", `/api/v1/tasks/${drained}`);
    expect(taskResource).toMatchObject({
      status: {
        attempt: {
          workerHostId: "host-b",
          workletId: "host-b-worklet",
          selection: {
            allowedWorkerHostIds: expect.arrayContaining(["host-b"]),
            reservation: { phase: "consumed" },
          },
        },
      },
    });
  }, 60_000);

  async function launchControlPlane() {
    containers.push(name("control-plane"));
    await execute("docker", [
      "run",
      "-d",
      "--name",
      name("control-plane"),
      "--hostname",
      name("control-plane"),
      "--network",
      network,
      "--network-alias",
      "control-plane",
      "-p",
      "127.0.0.1::8790",
      "-v",
      `${join(directory, "certificates")}:/certificates:ro`,
      "-e",
      `SUPERTAG_TEST_ADMIN_TOKEN=${adminToken}`,
      image,
      "node",
      "/app/organization-docker-control-plane.js",
    ]);
    await ready(name("control-plane"), "Organization API ready");
    const port = (
      await execute("docker", ["port", name("control-plane"), "8790/tcp"])
    ).stdout.match(/:(\d+)\s*$/u)?.[1];
    if (!port) throw new Error("Missing Control Plane API port");
    apiUrl = `https://127.0.0.1:${port}`;
  }

  async function enrollAndLaunch(host: { id: string; profile: string; capacity: string }) {
    const issuance = await api("POST", "/api/v1/worker-hosts", {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "WorkerHostEnrollment",
      metadata: { id: host.id },
      spec: {},
    });
    const token = String((issuance["credential"] as Row)["token"]);
    containers.push(name(host.id));
    await execute("docker", [
      "run",
      "-d",
      "--name",
      name(host.id),
      "--hostname",
      name(host.id),
      "--network",
      network,
      "-v",
      `${join(directory, "certificates/server.crt")}:/certificates/server.crt:ro`,
      "-e",
      `WORKER_HOST_ID=${host.id}`,
      "-e",
      `WORKER_PROFILE_ID=${host.profile}`,
      "-e",
      `WORKER_CAPACITY=${host.capacity}`,
      "-e",
      `SUPERTAG_WORKLET_CREDENTIAL=${token}`,
      "-e",
      "NODE_EXTRA_CA_CERTS=/certificates/server.crt",
      image,
      "node",
      "/app/distributed-scheduling-docker-worker.js",
    ]);
    await ready(name(host.id), `Scheduling Worker ready: ${host.id}`);
  }

  async function ready(container: string, marker: string) {
    await eventually(async () => {
      const logs = await execute("docker", ["logs", container]);
      const running = (
        await execute("docker", ["inspect", "-f", "{{.State.Running}}", container])
      ).stdout.trim();
      if (running !== "true") throw new Error(`${container} exited: ${logs.stderr}`);
      return logs.stdout.includes(marker);
    });
  }

  async function api(method: string, path: string, body?: object): Promise<Row> {
    return new Promise((resolveRequest, reject) => {
      const call = request(
        `${apiUrl}${path}`,
        {
          method,
          ca: tlsCa,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          timeout: 15_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString();
              const value = text ? JSON.parse(text) : {};
              if ((response.statusCode ?? 500) >= 400)
                reject(new Error(`${method} ${path}: ${JSON.stringify(value)}`));
              else resolveRequest(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      call.on("timeout", () => call.destroy(new Error("API request timeout")));
      call.on("error", reject);
      call.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  /**
   * One turn of the Tag, in its own CLI conversation so turns run concurrently: a Session takes
   * one turn at a time. Returns the Task id.
   */
  const start = async (session: string, text: string) => {
    const record = await api("POST", "/supertag.operator.v1.ConversationService/SendMessage", {
      tag: "Scheduler manager",
      conversation: session,
      text,
    });
    const taskId = String(record["taskId"]);
    taskIds.set(session, taskId);
    return taskId;
  };
  const taskOf = (session: string) => taskIds.get(session) as string;
  async function snapshot(): Promise<{ tasks: Row[]; attempts: Row[] }> {
    const script =
      "const db=require('better-sqlite3')('/state/control-plane.db',{readonly:true});console.log(JSON.stringify({tasks:db.prepare('SELECT * FROM Task').all(),attempts:db.prepare('SELECT * FROM TaskAttempt').all()}));";
    return JSON.parse(
      (await execute("docker", ["exec", name("control-plane"), "node", "-e", script])).stdout,
    );
  }
  const attempts = async () => (await snapshot()).attempts;
  const taskRow = async (taskId: string) =>
    (await snapshot()).tasks.find((row) => row["id"] === taskId);
});

function selectedHost(row: Row | undefined): string | undefined {
  if (!row) return undefined;
  const snapshot = JSON.parse(String(row["workerSnapshot"])) as Row;
  return String((snapshot["placement"] as Row)?.["workerHostId"] ?? "") || undefined;
}

async function eventually(probe: () => Promise<boolean>, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for distributed scheduling state");
}
