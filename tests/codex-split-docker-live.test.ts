import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.ts";
import {
  connectExecutionEnvironmentMcpClient,
  type ToolInput,
} from "../packages/runtime/sdk/src/index.ts";
import { repositoryAttempt } from "./support/repository-execution.ts";

const execute = promisify(execFile);
const enabled = process.env["SUPERTAG_CODEX_SPLIT_DOCKER_LIVE"] === "1";
const suite = enabled ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const conformanceScript = join(repositoryRoot, "scripts/codex-native-conformance.ts");
const environmentId = "docker-codex-split";
const adminToken = `docker-codex-${randomUUID()}`;

suite("Codex split execution Docker boundary", () => {
  let directory = "";
  let container = "";
  let image = "";
  let baseUrl = "";
  let codexVersion = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-codex-split-docker-"));
    await execute("mkdir", ["-p", join(directory, "workspace"), join(directory, "state")]);
    codexVersion = await pinnedCodexVersion();
    const suffix = randomUUID().slice(0, 8);
    container = `supertag-codex-split-${suffix}`;
    image = `supertag-codex-split:${suffix}`;
    await execute(
      "docker",
      [
        "build",
        "--build-arg",
        `SUPERTAG_CODEX_VERSION=${codexVersion}`,
        "-t",
        image,
        "packages/runtime/environments/shared-execution",
      ],
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
      `SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID=${environmentId}`,
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
          throw new Error(`Codex execution container exited:\n${logs.stdout}${logs.stderr}`);
        }
        return undefined;
      }
    });
  }, 180_000);

  afterAll(async () => {
    if (container) await execute("docker", ["rm", "-f", container]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("runs local app-server against Docker exec-server with durable split provenance", async () => {
    const output = join(directory, "report");
    const result = await execute(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=development",
        conformanceScript,
        "--live",
        "--split",
        "--backend",
        "shared",
        "--base-url",
        baseUrl,
        "--environment-id",
        environmentId,
        "--output",
        output,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    const report = JSON.parse(result.stdout) as ConformanceReport;
    expect(report).toMatchObject({ backend: "shared", split: true });
    const phase = report.reports[0];
    expect(phase?.verification).toBe("VERIFIED");
    expect(phase?.manifest.type).toBe("runtime-inputs.resolved");
    const manifest = phase?.manifest.manifest;
    expect(manifest).toBeDefined();
    expect(manifest?.harnessRuntime.id).not.toBe(manifest?.executionEnvironment.id);
    expect(manifest?.harnessRuntime.placement).toBe("local");
    expect(manifest?.executionEnvironment).toMatchObject({
      provider: `shared-execution:${environmentId}`,
      placement: "remote",
    });
    expect(manifest?.executionEnvironment.id).toMatch(
      new RegExp(`^${environmentId}:[^:]+:[^:]+$`, "u"),
    );
    expect(manifest?.harness.provenance).toMatchObject({
      protocol: "codex-exec-server",
      protocolVersion: 1,
      executionEnvironmentId: manifest?.executionEnvironment.id,
      execServerVersion: codexVersion,
      transport: "stdio-websocket-bridge",
    });
    expect(manifest?.harness.provenance.execServerSessionId).toMatch(/\S/u);
    expect(await readFile(join(output, "source", "overlap.py"), "utf8")).toContain(
      "return a[0] <= b[1] and b[0] <= a[1]",
    );
    expect(await readFile(join(output, "initial-overlap.py"), "utf8")).toContain(
      "return a[0] < b[1] and b[0] < a[1]",
    );
  }, 240_000);

  it("owns a stdio MCP session inside the Docker execution environment", async () => {
    const attempt = repositoryAttempt("docker-environment-mcp");
    const profile = {
      ref: attempt.workerProfile,
      workerType: "supertag",
      harness: { provider: "codex" },
      execution: { provider: "shared", lifetime: { scope: "attempt" as const } },
    };
    const plan = {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "unrestricted" as const },
    };
    const provider = new SharedExecutionEnvironmentProvider({
      baseUrl,
      adminToken,
      environmentId,
    });
    const environment = await provider.provision({ task: attempt, profile, plan });
    await environment.prepare(plan);
    const server = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "docker-environment", version: "1" } } });
  if (message.method === "tools/list")
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read_shared_state", inputSchema: { type: "object" } }] } });
  if (message.method === "tools/call")
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: process.env.DOCKER_MCP_MARKER + ":" + message.params.arguments.key }] } });
});
`;
    const input: ToolInput = {
      id: "docker-environment-tools",
      kind: "tool",
      required: true,
      capability: {
        id: "docker-environment-tools",
        provider: "test",
        operations: [
          {
            name: "read_shared_state",
            effect: "read",
            actions: ["state:read"],
            resourceArgumentPolicies: [
              { match: "scope", prefix: "key:", components: [{ arguments: ["key"] }] },
            ],
          },
        ],
        authorization: {
          provider: "test",
          resources: [{ surfaceAccountId: "docker", scope: "key:objective" }],
        },
      },
      binding: {
        kind: "mcp-stdio",
        name: "docker-environment-tools",
        command: "node",
        args: ["-e", server],
        runtimeEnvironment: { DOCKER_MCP_MARKER: "inside-docker" },
      },
    };
    let connection: Awaited<ReturnType<typeof connectExecutionEnvironmentMcpClient>> | undefined;
    try {
      connection = await connectExecutionEnvironmentMcpClient(environment, input, {
        nodeCommand: "node",
        timeoutMs: 20_000,
      });
      expect(connection.client).toBe("execution-environment");
      await expect(connection.callTool("read_shared_state", { key: "objective" })).resolves.toEqual(
        { content: [{ type: "text", text: "inside-docker:objective" }] },
      );
    } finally {
      await connection?.close();
      await environment.dispose("completed");
    }
  }, 60_000);
});

interface ConformanceReport {
  readonly backend: string;
  readonly split: boolean;
  readonly reports: readonly {
    readonly verification: string;
    readonly manifest: {
      readonly type: string;
      readonly manifest: {
        readonly harness: {
          readonly provenance: Record<string, unknown> & { readonly execServerSessionId?: string };
        };
        readonly harnessRuntime: { readonly id: string; readonly placement: string };
        readonly executionEnvironment: {
          readonly id: string;
          readonly provider: string;
          readonly placement: string;
        };
      };
    };
  }[];
}

async function pinnedCodexVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.["@openai/codex-sdk"];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Codex Harness must pin an exact SDK version for split conformance");
  return version;
}

async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Docker Codex execution service");
}
