import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureLocalAdminToken } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import {
  type Clock,
  DOWN_WAIT_MS,
  DRAIN_CAP_MS,
  drainBoundMs,
  waitForAttempts,
} from "../apps/cli/src/drain.ts";
import { hostSlot, runningProcess, writeStatus } from "../apps/cli/src/local-state.ts";
import { provisionControlPlane } from "../apps/cli/src/provision.ts";
import {
  type ControlPlaneService,
  controlPlaneOf,
  loadServicesFile,
} from "../apps/cli/src/supertag-yaml.ts";
import { runDownCommand } from "../apps/cli/src/up.ts";
import type { VerifiedSurfaceAccount } from "../packages/surfaces/sdk/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { api, repository, useServicesContext, writeServices } from "./support/services.ts";

const context = useServicesContext();

/** A clock that moves only when the code under test sleeps. */
function fakeClock(start = Date.parse("2026-10-01T12:00:00Z")) {
  let now = start;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms, signal) => {
      if (!signal?.aborted) now += ms;
    },
  };
  return { clock, advance: (ms: number) => (now += ms), now: () => now };
}

describe("draining a host", () => {
  const minute = 60_000;

  it("waits at most the longest remaining Task Attempt time limit plus 30 seconds, capped at 30 minutes", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const startedAgo = (ms: number) => ({
      attemptId: `a${ms}`,
      taskId: "t",
      startedAt: new Date(now - ms).toISOString(),
    });
    expect(drainBoundMs([], 5 * minute, now)).toBe(0);
    // Two minutes into a five-minute limit: three minutes left, plus the grace.
    expect(drainBoundMs([startedAgo(2 * minute), startedAgo(4 * minute)], 5 * minute, now)).toBe(
      3 * minute + 30_000,
    );
    // Past its limit already: only the grace.
    expect(drainBoundMs([startedAgo(9 * minute)], 5 * minute, now)).toBe(30_000);
    expect(drainBoundMs([startedAgo(0)], 120 * minute, now)).toBe(DRAIN_CAP_MS);
  });

  it("returns at once when idle, and when the Task Attempts finish", async () => {
    const { clock } = fakeClock();
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => ({ attempts: [], timeLimitMs: 300_000 }),
        write,
        clock,
      }),
    ).resolves.toBe("idle");
    expect(lines).toEqual([]);

    let reads = 0;
    const attempt = {
      attemptId: "a1",
      taskId: "t1",
      startedAt: new Date(clock.now()).toISOString(),
    };
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => {
          reads += 1;
          return { attempts: reads < 4 ? [attempt] : [], timeLimitMs: 300_000 };
        },
        write,
        clock,
      }),
    ).resolves.toBe("finished");
    expect(lines.join("")).toBe(
      "Draining host service laptop: waiting for 1 Task Attempt to finish, at most 330 seconds. Task t1, Attempt a1. Press Ctrl-C or pass --force to stop waiting.\nTask Attempts on host service laptop finished.\n",
    );
  });

  it("prints progress every 10 seconds and stops waiting at the bound", async () => {
    const { clock } = fakeClock();
    const lines: string[] = [];
    const attempts = [
      {
        attemptId: "a1",
        taskId: "t1",
        startedAt: new Date(clock.now() - 4 * minute).toISOString(),
      },
      {
        attemptId: "a2",
        taskId: "t2",
        startedAt: new Date(clock.now() - 1 * minute).toISOString(),
      },
    ];
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => ({ attempts, timeLimitMs: 5 * minute }),
        write: (line) => lines.push(line),
        clock,
      }),
    ).resolves.toBe("timeout");
    // Four minutes left on the newer one, plus 30 seconds.
    expect(lines[0]).toContain("waiting for 2 Task Attempts to finish, at most 270 seconds");
    expect(lines.filter((line) => line.startsWith("Still waiting"))).toHaveLength(26);
    expect(lines[1]).toBe(
      "Still waiting for 2 Task Attempts on host service laptop, at most 260 more seconds...\n",
    );
    expect(lines.at(-1)).toBe(
      "Stopped waiting for host service laptop after 270 seconds; 2 Task Attempts still running: Task t1, Attempt a1; Task t2, Attempt a2. Pass --force to stop now.\n",
    );
  });

  it("lists the Task and Attempt IDs, gives the force hint, and caps down at five minutes", async () => {
    const { clock, now } = fakeClock();
    const started = now();
    const lines: string[] = [];
    const attempts = [
      { attemptId: "a1", taskId: "t1", startedAt: new Date(started).toISOString() },
      { attemptId: "a2", taskId: "t2", startedAt: new Date(started).toISOString() },
    ];
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => ({ attempts, timeLimitMs: 60 * minute }),
        write: (line) => lines.push(line),
        clock,
        maxWaitMs: DOWN_WAIT_MS,
      }),
    ).resolves.toBe("timeout");
    expect(now() - started).toBe(DOWN_WAIT_MS);
    expect(lines.join("")).toContain("Task t1, Attempt a1");
    expect(lines.join("")).toContain("Task t2, Attempt a2");
    expect(lines.join("")).toContain("supertag down laptop --force");
    expect(lines.at(-1)).toContain("Task t1, Attempt a1");
    expect(lines.at(-1)).toContain("Task t2, Attempt a2");
  });

  it("returns promptly when attempts finish before the down bound", async () => {
    const { clock, now } = fakeClock();
    const started = now();
    let reads = 0;
    const attempt = { attemptId: "a1", taskId: "t1", startedAt: new Date(started).toISOString() };
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => ({ attempts: ++reads < 4 ? [attempt] : [], timeLimitMs: 60 * minute }),
        write: () => {},
        clock,
        maxWaitMs: DOWN_WAIT_MS,
      }),
    ).resolves.toBe("finished");
    expect(now() - started).toBe(3_000);
  });

  it("stops waiting on --force or Ctrl-C", async () => {
    const { clock } = fakeClock();
    const attempt = {
      attemptId: "a1",
      taskId: "t1",
      startedAt: new Date(clock.now()).toISOString(),
    };
    const lines: string[] = [];
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => ({ attempts: [attempt], timeLimitMs: 300_000 }),
        write: (line) => lines.push(line),
        clock,
        force: true,
      }),
    ).resolves.toBe("forced");
    expect(lines).toEqual([
      "Not waiting for 1 Task Attempt on host service laptop (--force); they follow the recovery rules.\n",
    ]);
    const controller = new AbortController();
    let reads = 0;
    await expect(
      waitForAttempts({
        service: "laptop",
        read: async () => {
          reads += 1;
          if (reads === 3) controller.abort();
          return { attempts: [attempt], timeLimitMs: 300_000 };
        },
        write: (line) => lines.push(line),
        clock,
        signal: controller.signal,
      }),
    ).resolves.toBe("stopped");
    expect(lines.at(-1)).toBe(
      "Stopped waiting for host service laptop; running Task Attempts follow the recovery rules.\n",
    );
  });

  it("down drains a host, then leaves running Attempts and the host alone at the bound", async () => {
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
    await writeServices(
      context,
      "services:\n  laptop: { type: host, control-plane: 'https://supertag.example.com', harnesses: [codex] }\n",
    );
    // A host process that reports two running Task Attempts and never finishes them.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
    context.cleanups.push(async () => {
      sleeper.kill("SIGKILL");
    });
    const slot = hostSlot("laptop");
    await mkdir(join(context.state, "hosts", "laptop"), { recursive: true });
    await writeFile(join(context.state, "hosts", "laptop", "pid"), `${sleeper.pid}\n`);
    const { clock } = fakeClock(Date.now());
    await writeStatus(slot, {
      pid: sleeper.pid ?? 0,
      mode: "background",
      state: "ready",
      startedAt: new Date().toISOString(),
      configuration: "",
      kind: "host",
      service: "laptop",
      connected: true,
      attemptTimeLimitMs: 60 * minute,
      attempts: [
        { attemptId: "a1", taskId: "t1", startedAt: new Date(clock.now() - 60_000).toISOString() },
      ],
    });
    await expect(runDownCommand(["laptop"], { clock })).resolves.toBe(1);
    const printed = context.printed();
    expect(printed).toContain(
      "Draining host service laptop: waiting for 1 Task Attempt to finish, at most 300 seconds.",
    );
    expect(printed).toContain("Task t1, Attempt a1");
    expect(printed).toContain("supertag down laptop --force");
    expect(printed).toContain("Stopped waiting for host service laptop after 300 seconds");
    expect(printed).not.toContain("Stopped host service laptop");
    await expect(runningProcess(slot)).resolves.toEqual({ pid: sleeper.pid });
  });
});

describe("provision", () => {
  it("creates missing resources on every up, never changes existing ones, and records them in the provision set", async () => {
    const database = join(context.directory, "provision.db");
    await migrateSqlite(database);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${database}`,
      adminToken: await ensureLocalAdminToken(),
      coordinationOperatorCredentials: [],
      workletTransport: "remote",
      stateDirectory: join(context.directory, "provision-state"),
      reply: async () => {},
    });
    context.cleanups.push(() => runtime.close());
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", runtime.url);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", await ensureLocalAdminToken());
    const shop = await repository(context, "shop", "git@github.com:acme/shop.git");
    const org = join(context.directory, "org");
    await mkdir(org);
    await writeFile(
      join(org, "roles.yaml"),
      "apiVersion: supertag/v1\nkind: PermissionSet\nmetadata: { name: tools }\nspec: { permissions: [] }\n---\napiVersion: supertag/v1\nkind: Role\nmetadata: { name: Lead }\nspec: { purpose: Lead the work., instructions: Be careful., contextSets: [], permissionSets: [tools] }\n",
    );
    await writeServices(
      context,
      `services:
  control-plane:
    type: control-plane
    provision:
      - ${org}
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec: { roles: [Lead] }
      - apiVersion: supertag/v1
        kind: SurfaceAccount
        metadata: { name: acme-slack }
        spec:
          provider: slack
          configuration: { transport: socket }
          secrets: { botToken: { secretRef: slack-bot }, appToken: { secretRef: slack-app } }
  laptop:
    type: host
    harnesses: [codex]
    workspaces: { shop: ${shop} }
secrets:
  slack-bot: { environment: SLACK_BOT }
  slack-app: { file: slack-app.txt }
`,
    );
    vi.stubEnv("SLACK_BOT", "xoxb-from-environment");
    await writeFile(join(context.state, "slack-app.txt"), "xapp-from-file\n");
    const file = await loadServicesFile();
    const service = controlPlaneOf(file) as ControlPlaneService;
    const verified: Record<string, string>[] = [];
    const verifySurface = async (
      _manifest: unknown,
      secrets: Readonly<Record<string, string>>,
    ): Promise<VerifiedSurfaceAccount> => {
      verified.push({ ...secrets });
      return {
        provider: "slack",
        externalAccountId: "T777",
        displayName: "Acme",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket", botId: "B1", botUserId: "U1" },
        secrets: { ...secrets },
      };
    };
    const lines = await provisionControlPlane(file, service, runtime.url, { verifySurface });
    expect(lines).toEqual([
      expect.stringMatching(
        /^SurfaceAccount\/acme-slack created \(provision\); verified slack account/,
      ),
      "PermissionSet/tools created (provision)",
      "Role/Lead created (provision)",
      "Tag/lead created (provision)",
      "Workspace/shop created for host service laptop",
    ]);
    // secretRef resolved through supertag.yaml's secrets map; values never in the output.
    expect(verified).toEqual([{ botToken: "xoxb-from-environment", appToken: "xapp-from-file" }]);
    expect(lines.join("")).not.toContain("xoxb-from-environment");
    expect((await api("/api/v1/workspaces/shop")).spec).toMatchObject({
      source: "git@github.com:acme/shop.git",
      ref: "main",
      delivery: "branch",
    });

    // An existing resource is never changed by up: a later edit survives.
    await api("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "lead" },
        spec: { roles: ["Lead"], runsOn: ["harness:codex"] },
      }),
    });
    await expect(
      provisionControlPlane(file, service, runtime.url, { verifySurface }),
    ).resolves.toEqual([]);
    expect((await api("/api/v1/tags/lead")).spec).toMatchObject({ runsOn: ["harness:codex"] });
    expect(verified).toHaveLength(1);

    // A resource added later, or deleted, is created on the next up.
    await writeFile(
      join(org, "context.yaml"),
      "apiVersion: supertag/v1\nkind: ContextSet\nmetadata: { name: handbook }\nspec: { items: [] }\n",
    );
    const created = await provisionControlPlane(file, service, runtime.url, { verifySurface });
    expect(created).toEqual(["ContextSet/handbook created (provision)"]);

    // Membership in the provision set lets apply --set provision --prune take over.
    const prune = (await api("/api/v1/apply-sets/provision/prune?dryRun=true", {
      method: "POST",
      body: JSON.stringify({ keep: [] }),
    })) as unknown as { items: { kind: string; name: string }[] };
    expect(prune.items.map((item) => `${item.kind}/${item.name}`).toSorted()).toEqual(
      expect.arrayContaining(["ContextSet/handbook", "PermissionSet/tools", "Role/Lead"]),
    );
    expect(prune.items.map((item) => item.name)).not.toContain("shop");
  }, 120_000);

  it("reports a missing manifest path and an unknown secret without creating anything", async () => {
    const database = join(context.directory, "provision.db");
    await migrateSqlite(database);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${database}`,
      adminToken: await ensureLocalAdminToken(),
      coordinationOperatorCredentials: [],
      workletTransport: "remote",
      stateDirectory: join(context.directory, "provision-state"),
      reply: async () => {},
    });
    context.cleanups.push(() => runtime.close());
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", runtime.url);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", await ensureLocalAdminToken());
    await writeServices(
      context,
      `services:
  control-plane:
    type: control-plane
    provision:
      - missing-dir
      - { apiVersion: supertag/v1, kind: Tag, metadata: { name: lead }, spec: {} }
`,
    );
    const file = await loadServicesFile();
    await expect(
      provisionControlPlane(file, controlPlaneOf(file) as ControlPlaneService, runtime.url),
    ).rejects.toThrow(/supertag\.yaml provision: .*missing-dir: /);
    expect((await api("/api/v1/tags")).items).toEqual([]);
  });

  describe("admin token", () => {
    const FILE_TOKEN = "env-file-admin-token-0123456789abcdef";
    const PROCESS_TOKEN = "process-admin-token-0123456789abcdef";
    const OPERATOR_TOKEN = "process-operator-token-0123456789abcdef";

    /** A Control Plane that accepts `adminToken`, and a supertag.yaml beside an env_file. */
    async function setUp(adminToken: string, envFile?: string) {
      const database = join(context.directory, "provision.db");
      await migrateSqlite(database);
      const runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: `file:${database}`,
        adminToken,
        coordinationOperatorCredentials: [],
        workletTransport: "remote",
        stateDirectory: join(context.directory, "provision-state"),
        reply: async () => {},
      });
      context.cleanups.push(() => runtime.close());
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    provision:
      - { apiVersion: supertag/v1, kind: Tag, metadata: { name: lead }, spec: {} }
`,
      );
      if (envFile !== undefined) await writeFile(join(context.state, ".env"), envFile);
      const file = await loadServicesFile();
      return {
        provision: () =>
          provisionControlPlane(file, controlPlaneOf(file) as ControlPlaneService, runtime.url),
      };
    }

    /** Every file in the state directory except env_file, which the operator wrote. */
    async function stateFiles(): Promise<string> {
      const entries = await readdir(context.state, { recursive: true, withFileTypes: true });
      const texts = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name !== ".env")
          .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
      );
      return texts.join("\n");
    }

    it("reads SUPERTAG_ADMIN_TOKEN from env_file when the process environment lacks it", async () => {
      const { provision } = await setUp(FILE_TOKEN, `SUPERTAG_ADMIN_TOKEN=${FILE_TOKEN}\n`);
      const lines = await provision();
      expect(lines).toEqual(["Tag/lead created (provision)"]);
      expect(lines.join("\n")).not.toContain(FILE_TOKEN);
      expect(context.printed()).not.toContain(FILE_TOKEN);
      // Nothing copies it into the state directory, the local credential file included.
      expect(await stateFiles()).not.toContain(FILE_TOKEN);
    });

    it("prefers SUPERTAG_ADMIN_TOKEN in the process environment over env_file", async () => {
      const { provision } = await setUp(PROCESS_TOKEN, `SUPERTAG_ADMIN_TOKEN=${FILE_TOKEN}\n`);
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", PROCESS_TOKEN);
      await expect(provision()).resolves.toEqual(["Tag/lead created (provision)"]);
    });

    it("prefers SUPERTAG_OPERATOR_TOKEN in the process environment over env_file", async () => {
      const { provision } = await setUp(PROCESS_TOKEN, `SUPERTAG_ADMIN_TOKEN=${FILE_TOKEN}\n`);
      vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", PROCESS_TOKEN);
      await expect(provision()).resolves.toEqual(["Tag/lead created (provision)"]);
    });

    it("prefers SUPERTAG_OPERATOR_TOKEN over SUPERTAG_ADMIN_TOKEN in the environment and env_file", async () => {
      // The Control Plane accepts only the Operator Token, so either admin token would fail.
      const { provision } = await setUp(OPERATOR_TOKEN, `SUPERTAG_ADMIN_TOKEN=${FILE_TOKEN}\n`);
      vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", OPERATOR_TOKEN);
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", PROCESS_TOKEN);
      const lines = await provision();
      expect(lines).toEqual(["Tag/lead created (provision)"]);
      for (const token of [OPERATOR_TOKEN, PROCESS_TOKEN, FILE_TOKEN]) {
        expect(lines.join("\n")).not.toContain(token);
        expect(context.printed()).not.toContain(token);
        expect(await stateFiles()).not.toContain(token);
      }
    });

    it("uses the local operator credential when neither the environment nor env_file sets one", async () => {
      const { provision } = await setUp(await ensureLocalAdminToken(), "OTHER=value\n");
      await expect(provision()).resolves.toEqual(["Tag/lead created (provision)"]);
    });

    it("never puts the token in an error", async () => {
      const { provision } = await setUp(PROCESS_TOKEN, `SUPERTAG_ADMIN_TOKEN=${FILE_TOKEN}\n`);
      const error = await provision().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).stack)).not.toContain(FILE_TOKEN);
      expect(String((error as Error).message)).not.toContain(PROCESS_TOKEN);
      expect(context.printed()).not.toContain(FILE_TOKEN);
      expect(await stateFiles()).not.toContain(FILE_TOKEN);
    });
  });
});
