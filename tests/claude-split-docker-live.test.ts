import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  collectTaskAttemptEvents,
  FileSessionStateStore,
  LocalHarnessRuntimeProvider,
  type TaskAttemptSpec,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";
import { runClaudeSessionPhase } from "./support/claude-session-live.js";

const execute = promisify(execFile);
const enabled = process.env["SUPERTAG_CLAUDE_SPLIT_DOCKER_LIVE"] === "1";
const suite = enabled ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const environmentId = "docker-claude-split";
const adminToken = `docker-claude-${randomUUID()}`;

suite("Claude split execution Docker boundary", () => {
  let directory = "";
  let source = "";
  let container = "";
  let image = "";
  let baseUrl = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-claude-split-docker-"));
    source = join(directory, "source");
    await Promise.all([
      mkdir(source),
      mkdir(join(directory, "workspace")),
      mkdir(join(directory, "state")),
    ]);
    await writeFile(join(source, "input.txt"), "shared evidence\n");
    const suffix = randomUUID().slice(0, 8);
    container = `supertag-claude-split-${suffix}`;
    image = `supertag-claude-split:${suffix}`;
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
        return undefined;
      }
    });
  }, 180_000);

  afterAll(async () => {
    if (container) await execute("docker", ["rm", "-f", container]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("restores a native Session on a fresh local Harness while tools still execute in Docker", async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("Subscription authentication is required for this live test");
    const nonce = randomUUID();
    await writeFile(join(source, "effects.log"), "");
    const stateDirectory = join(directory, "session-states");
    const provider = new SharedExecutionEnvironmentProvider({ baseUrl, adminToken, environmentId });
    const first = await runClaudeSessionPhase({
      directory,
      source,
      runtime: join(directory, "runtime-a"),
      phase: "shared-first",
      sessionStateStore: new FileSessionStateStore(stateDirectory),
      executionEnvironment: provider,
      prompt: `Remember the private nonce ${nonce} without writing it to any file. Append exactly the ASCII text executed followed by a newline to effects.log using the remote workspace tools. The entire file must be exactly "executed\\n" (9 bytes). No timestamps, prefixes or suffixes. Reply INITIAL_DONE. Do not spawn helpers.`,
    });
    expect(first.events.at(-1), JSON.stringify(first.events.at(-1))).toMatchObject({
      type: "execution.completed",
    });
    const state = first.events.findLast((event) => event.type === "session.updated");
    if (state?.type !== "session.updated") throw new Error("Missing saved native state");
    const nativeId = (await new FileSessionStateStore(stateDirectory).load(state.sessionState))
      ?.data["claudeSessionId"];
    expect(await readFile(join(directory, "workspace", "workspace", "effects.log"), "utf8")).toBe(
      "executed\n",
    );
    await rm(join(directory, "runtime-a"), { recursive: true, force: true });
    await writeFile(join(source, "effects.log"), "executed\n");
    const second = await runClaudeSessionPhase({
      directory,
      source,
      runtime: join(directory, "runtime-b"),
      phase: "shared-second",
      sessionStateStore: new FileSessionStateStore(stateDirectory),
      executionEnvironment: provider,
      priorState: state.sessionState,
      prompt:
        "Recall the exact private nonce from our previous turn. Do not append to effects.log again; read it with the remote tools and confirm exactly one executed line remains. Do not spawn helpers.",
    });
    expect(second.events.at(-1), JSON.stringify(second.events.at(-1))).toMatchObject({
      type: "execution.completed",
    });
    expect(terminalOutputText(second.events)).toContain(nonce);
    const resumed = second.events.findLast((event) => event.type === "session.updated");
    if (resumed?.type !== "session.updated") throw new Error("Missing resumed state");
    expect(
      (await new FileSessionStateStore(stateDirectory).load(resumed.sessionState))?.data[
        "claudeSessionId"
      ],
    ).toBe(nativeId);
    expect(await readFile(join(directory, "workspace", "workspace", "effects.log"), "utf8")).toBe(
      "executed\n",
    );
    expect(second.events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
      manifest: {
        harnessRuntime: { placement: "local" },
        executionEnvironment: { placement: "remote" },
      },
    });
  }, 300_000);

  it("keeps subscription authentication local while Claude changes the shared workspace", async () => {
    const worker = createClaudeCodeWorker({
      workspace: source,
      maxTurns: 8,
      timeoutMs: 180_000,
      harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
      executionEnvironment: new SharedExecutionEnvironmentProvider({
        baseUrl,
        adminToken,
        environmentId,
      }),
    });
    const events = await collectTaskAttemptEvents(worker.execute(attempt()));
    const failed = events.find((event) => event.type === "execution.failed");
    expect(failed, JSON.stringify(failed)).toBeUndefined();
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalOutputText(events)).toContain("CLAUDE_SHARED_EXECUTION_VERIFIED");
    expect(await readFile(join(directory, "workspace", "workspace", "created.txt"), "utf8")).toBe(
      "shared evidence verified\n",
    );
    expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
      manifest: {
        harness: {
          id: "claude-code",
          provenance: { protocol: "claude-split-execution-bridge", protocolVersion: 1 },
        },
        harnessRuntime: { placement: "local" },
        executionEnvironment: {
          provider: `shared-execution:${environmentId}`,
          placement: "remote",
          provenance: {
            environmentId,
            incarnationId: expect.any(String),
            accessId: expect.any(String),
            expiresAt: expect.any(String),
          },
        },
      },
    });
  }, 240_000);
});

function attempt(): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 1,
    taskId: `task-${randomUUID()}`,
    attemptId: `attempt-${randomUUID()}`,
    tag: { id: "tag-engineering", name: "Engineering" },
    input: {
      origin: {
        surface: "cli",
        accountId: "local",
        scope: "terminal",
        sessionKey: "claude-split-live",
        occurredAt: capturedAt,
      },
      messages: [
        {
          id: "request",
          role: "requester",
          text: [
            "Use the provided workspace tools to read input.txt.",
            "Write created.txt containing exactly: shared evidence verified followed by a newline.",
            "Read created.txt to verify it, then reply exactly CLAUDE_SHARED_EXECUTION_VERIFIED.",
          ].join(" "),
        },
      ],
    },
    execution: {},
    workerProfile: { id: "local-claude-code", revision: "1" },
    contextPlan: { version: 1, capturedAt, sets: [] },
    authorization: {
      version: 1,
      capturedAt,
      tag: { id: "tag-engineering", name: "Engineering" },
      origin: {
        tagRouteId: "route",
        surfaceAccountId: "local",
        provider: "cli",
        scope: "terminal",
      },
      requester: { id: "user", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:write", "commands:execute", "web:fetch"],
    },
  };
}

async function eventually(check: () => Promise<true | undefined>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Shared execution service did not become healthy");
}
