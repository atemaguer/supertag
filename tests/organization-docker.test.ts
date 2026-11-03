import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { CONTROL_PLANE_API_VERSION } from "../apps/cli/src/control-plane-resources.js";

const execute = promisify(execFile);
const suite = process.env["SUPERTAG_DOCKER_ORGANIZATION"] === "1" ? describe : describe.skip;
const root = resolve(import.meta.dirname, "..");
const credentials = {
  ...process.env,
  SUPERTAG_TEST_ADMIN_TOKEN: randomUUID(),
  SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: randomUUID(),
};
type Row = Record<string, unknown>;
suite("organization collaboration through production APIs on distributed Docker Workers", () => {
  let directory = "",
    network = "",
    image = "",
    apiUrl = "",
    tlsCa = "";
  const containers: string[] = [];
  const name = (service: string) => `${network}-${service}`;
  let research = "",
    reviewer = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-organization-"));
    network = `supertag-org-${randomUUID().slice(0, 8)}`;
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
        "tests/fixtures/organization-docker-worker.ts",
        "tests/fixtures/organization-docker-control-plane.ts",
        "tests/fixtures/organization-docker-execution.ts",
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
        "RUN npm install --omit=dev better-sqlite3@12.11.1 ws@8.19.0 && groupadd -g 10001 workload && useradd -u 10001 -g workload workload",
        'RUN echo \'{"type":"module"}\' > package.json',
        "COPY app/ /app/",
        "COPY drizzle/ /drizzle/",
      ].join("\n"),
    );
    await execute("docker", ["build", "-t", image, directory], { maxBuffer: 20 * 1024 * 1024 });
    await execute("docker", ["network", "create", network]);
    await launch("execution", "Organization execution ready");
    await launch("control-plane", "Organization API ready", ["-p", "127.0.0.1::8790"]);
    await refreshPort();
    for (const host of ["worker-a", "worker-b"]) {
      const issuance = await api("POST", "/api/v1/worker-hosts", {
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "WorkerHostEnrollment",
        metadata: { id: host },
        spec: {},
      });
      const token = (issuance["credential"] as { token: string }).token;
      await launch(
        host,
        "Organization Worker ready",
        [
          "-e",
          "WORKER_ID",
          "-e",
          "SUPERTAG_WORKLET_CREDENTIAL",
          "-e",
          "NODE_EXTRA_CA_CERTS=/certificates/server.crt",
        ],
        { ...credentials, WORKER_ID: host, SUPERTAG_WORKLET_CREDENTIAL: token },
      );
    }
    const makeTag = async (label: string) =>
      (
        await api("POST", "/api/v1/tags", {
          apiVersion: CONTROL_PLANE_API_VERSION,
          kind: "Tag",
          metadata: { name: label },
          spec: {},
        })
      )["metadata"] as { id: string };
    research = (await makeTag("Research manager"))["id"];
    reviewer = (await makeTag("Review manager"))["id"];
    await api("POST", "/api/v1/tag-messaging/objectives", {
      id: "pooled-objective",
      ownerTagId: research,
      outcome: "Independently verify one shared conclusion",
      runtimeActions: [],
      budgetLimitMinor: 100,
    });
    await command("start_objective", {
      taskId: "organization-bootstrap",
      execution: { profile: { id: "worker-a", revision: "1" } },
      maxCostMinor: 0,
    });
    await command("update_team", {
      teamId: "pooled-objective:leadership",
      expectedRevision: 1,
      name: "Research",
    });
    await command("create_team", {
      id: "review-team",
      name: "Review",
      leadTagId: reviewer,
      memberTagIds: [reviewer],
      maxConcurrency: 1,
    });
    await eventually(async () =>
      (await snapshot()).assignments.some(
        (row) => row["taskId"] === "organization-bootstrap" && row["status"] === "submitted",
      ),
    );
    for (const [senderTagId, recipientTagId] of [
      [research, reviewer],
      [reviewer, research],
    ])
      await api("PUT", "/api/v1/tag-messaging/grants", {
        senderTagId,
        recipientTagId,
        messageTypes: ["result.submitted", "progress.updated"],
      });
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

  it("preserves Team authority and artifact admission while managers finish their Objective after a Control Plane restart", async () => {
    onTestFailed(async () => {
      for (const container of containers) {
        const logs = await execute("docker", ["logs", "--tail", "20", container]);
        process.stderr.write(`${container}: ${logs.stdout}${logs.stderr}\n`);
      }
      const debug = await snapshot();
      process.stderr.write(
        `${JSON.stringify({ assignments: debug.assignments, failures: debug.events.filter((row) => row["type"] === "execution.failed") })}\n`,
      );
    });
    await command("assign_task", {
      taskId: "review-bootstrap",
      teamId: "review-team",
      assignedTagId: reviewer,
      instruction: "Receive future work through the Team Mailbox",
      acceptanceCriteria: ["Manager ready"],
      execution: { profile: { id: "worker-b", revision: "1" } },
      maxCostMinor: 0,
    });
    await eventually(async () =>
      (await snapshot()).assignments.some(
        (row) => row["taskId"] === "review-bootstrap" && row["status"] === "submitted",
      ),
    );
    await command("assign_task", {
      taskId: "research-produce",
      teamId: "pooled-objective:leadership",
      assignedTagId: research,
      instruction: "Produce shared evidence and coordinate independent review",
      acceptanceCriteria: ["Artifact produced and review requested"],
      execution: { profile: { id: "worker-a", revision: "1" } },
      maxCostMinor: 0,
    });
    await eventually(async () => {
      try {
        await execute("docker", ["exec", name("execution"), "test", "-f", "/data/started.txt"]);
        return true;
      } catch {
        return false;
      }
    });
    const before = (await snapshot()).hosts;
    await execute("docker", ["kill", "--signal", "KILL", name("control-plane")]);
    await execute("docker", ["start", name("control-plane")]);
    await refreshPort();
    await eventually(async () => {
      try {
        const state = await snapshot();
        return (
          state.hosts.length === 2 &&
          state.hosts.every(
            (host) =>
              host["connectionStatus"] === "connected" &&
              Number(host["connectionGeneration"]) >
                Number(before.find((row) => row["id"] === host["id"])?.["connectionGeneration"]),
          )
        );
      } catch {
        return false;
      }
    });
    await eventually(async () => {
      const state = await snapshot();
      const failed = state.assignments.find((row) => row["status"] === "failed");
      if (failed) throw new Error(`Manager failed: ${JSON.stringify(failed)}`);
      // The manager can complete the Objective before its containing Attempt is
      // settled and its incoming Mailbox message is marked processed.
      return (
        state.objectives[0]?.["status"] === "completed" &&
        state.messages.length === 3 &&
        state.messages.every((row) => row["status"] === "processed")
      );
    }, 100_000);
    const state = await snapshot();
    expect(state.teams.map((row) => row["leadTagId"]).sort()).toEqual([research, reviewer].sort());
    expect(state.objectives[0]).toMatchObject({ ownerTagId: research, status: "completed" });
    expect(state.assignments.find((row) => row["taskId"] === "review-evidence")).toMatchObject({
      teamId: "review-team",
      assignedTagId: reviewer,
      requestedByTagId: research,
      status: "accepted",
    });
    expect(state.attempts.filter((row) => row["taskId"] === "research-produce")).toHaveLength(1);
    expect(
      (await execute("docker", ["exec", name("execution"), "cat", "/data/effects.txt"])).stdout,
    ).toBe("produce\n");
    expect(state.messages).toHaveLength(3);
    expect(state.messages.every((row) => row["status"] === "processed")).toBe(true);
    expect(
      state.messages.find((row) => row["idempotencyKey"] === "research-artifact"),
    ).toMatchObject({
      senderTagId: research,
      recipientTagId: reviewer,
      recipientTeamId: "review-team",
    });
    expect(
      state.messages.find((row) => row["idempotencyKey"] === "review-admission-request"),
    ).toMatchObject({
      senderTagId: reviewer,
      recipientTagId: research,
      recipientTeamId: "pooled-objective:leadership",
    });
    const reviewTask = state.tasks.find((row) => row["id"] === "review-evidence");
    const trigger = JSON.parse(String(reviewTask?.["trigger"]));
    const content = "Reviewed shared conclusion: the pooled result is 42.\n";
    const digest = createHash("sha256").update(content).digest("hex");
    expect(trigger.inputArtifacts).toEqual([
      expect.objectContaining({
        provenance: {
          taskId: "research-produce",
          attemptId: expect.any(String),
          attemptCount: 1,
          statusAtAdmission: "submitted",
        },
        uri: `supertag-artifact:sha256:${digest}`,
        digest: `sha256:${digest}`,
      }),
    ]);
    const authorization = JSON.parse(String(reviewTask?.["authorizationSnapshot"]));
    expect(authorization.tag["id"]).toBe(reviewer);
    expect(authorization.runtimeActions).toEqual([]);
    const permissionEvidence = JSON.parse(
      (
        await execute("docker", [
          "exec",
          name("worker-b"),
          "cat",
          "/state/permission-evidence.json",
        ])
      ).stdout,
    );
    expect(permissionEvidence).toMatchObject({
      tagId: reviewer,
      nonOwnerToolAbsent: true,
      unadmittedArtifactStatus: 403,
      forgedSenderDenied: true,
    });
    expect(
      (await execute("docker", ["exec", name("execution"), "cat", "/data/review.txt"])).stdout,
    ).toContain("42");
  }, 130_000);

  async function launch(
    service: string,
    marker: string,
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
        `/app/organization-docker-${service.startsWith("worker-") ? "worker" : service}.js`,
      ],
      { env: environment },
    );
    await eventually(async () => {
      const logs = await execute("docker", ["logs", name(service)]);
      const running = (
        await execute("docker", ["inspect", "-f", "{{.State.Running}}", name(service)])
      ).stdout.trim();
      if (running !== "true") throw new Error(`${service} exited: ${logs.stderr}`);
      return logs.stdout.includes(marker);
    });
  }
  async function refreshPort() {
    const port = (
      await execute("docker", ["port", name("control-plane"), "8790/tcp"])
    ).stdout.match(/:(\d+)\s*$/u)?.[1];
    if (!port) throw new Error("Missing API port");
    apiUrl = `https://127.0.0.1:${port}`;
  }
  async function api(method: string, path: string, body?: object): Promise<Row> {
    return new Promise((resolveRequest, reject) => {
      const call = request(
        `${apiUrl}${path}`,
        {
          method,
          ca: tlsCa,
          headers: {
            authorization: `Bearer ${credentials.SUPERTAG_TEST_ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          timeout: 15000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString());
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
  async function command(name: string, input: object) {
    return api("POST", `/api/v1/coordination/${name}`, {
      objectiveId: "pooled-objective",
      ...input,
    });
  }
  async function snapshot(): Promise<
    Record<
      | "assignments"
      | "attempts"
      | "tasks"
      | "teams"
      | "objectives"
      | "messages"
      | "hosts"
      | "events",
      Row[]
    >
  > {
    const script =
      "const db=require('better-sqlite3')('/state/control-plane.db',{readonly:true});const tables={assignments:'TaskAssignment',attempts:'TaskAttempt',tasks:'Task',teams:'Team',objectives:'Objective',messages:'TagMessage',hosts:'WorkerHost',events:'TaskEvent'};console.log(JSON.stringify(Object.fromEntries(Object.entries(tables).map(([key,table])=>[key,db.prepare('SELECT * FROM '+table).all()]))));";
    return JSON.parse(
      (await execute("docker", ["exec", name("control-plane"), "node", "-e", script])).stdout,
    );
  }
});
async function eventually(probe: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for organization state");
}
