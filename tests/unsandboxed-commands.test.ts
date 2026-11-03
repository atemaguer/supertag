import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { describeTask } from "../apps/cli/src/resources.js";
import { commandPlacement, placeTask } from "../packages/control-plane/src/label-placement.js";
import { objectiveRunnableReasons } from "../packages/control-plane/src/objective-runnable.js";
import {
  hostCommandSupport,
  unsandboxedCommandsReason,
  type WorkerHost,
} from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { createCursorWorker } from "../packages/runtime/harnesses/cursor/src/index.js";
import { createOpenCodeWorker } from "../packages/runtime/harnesses/opencode/src/index.js";
import {
  COMMANDS_EXECUTE_CAPABILITY,
  LocalWorklet,
  type TaskAttemptSpec,
  UNSANDBOXED_COMMANDS_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const COORDINATION = { id: "supertag.coordination", version: 1 };
const REASON =
  "Worker Host laptop runs claude-code without a sandbox; add claude-code to allow-unsandboxed-commands in its supertag.yaml service to let it run commands.";

/** A host snapshot with one Worker per harness, each reporting the given capabilities. */
function snapshot(
  profiles: readonly { readonly harness: string; readonly capabilities: readonly unknown[] }[],
): Readonly<Record<string, unknown>> {
  return {
    workers: profiles.map(({ harness, capabilities }) => {
      const profile = { id: `local-${harness}`, revision: "1" };
      return {
        id: `local-${harness}`,
        profiles: [profile],
        capabilities,
        profileCapabilities: [{ profile, harness, capabilities, contextTypes: [] }],
      };
    }),
  };
}

type PlacementHost = Pick<WorkerHost, "id" | "enrollmentStatus" | "labels" | "workerSnapshot">;
const host = (id: string, workerSnapshot: Readonly<Record<string, unknown>>): PlacementHost => ({
  id,
  enrollmentStatus: "active",
  labels: [],
  workerSnapshot,
});
const unsandboxedClaude = {
  harness: "claude-code",
  capabilities: [UNSANDBOXED_COMMANDS_CAPABILITY],
};
const allowedClaude = {
  harness: "claude-code",
  capabilities: [UNSANDBOXED_COMMANDS_CAPABILITY, COMMANDS_EXECUTE_CAPABILITY],
};
const codex = { harness: "codex", capabilities: [COMMANDS_EXECUTE_CAPABILITY] };

describe("unsandboxed harness advertisement", () => {
  it("reports Claude Code and OpenCode as unsandboxed, and lets them run commands only when allowed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "supertag-unsandboxed-"));
    try {
      const capabilities = async (worker: Worker) =>
        (await worker.describe()).profileCapabilities?.[0]?.capabilities ?? [];
      expect(await capabilities(createClaudeCodeWorker({ workspace }))).toContainEqual(
        UNSANDBOXED_COMMANDS_CAPABILITY,
      );
      expect(await capabilities(createClaudeCodeWorker({ workspace }))).not.toContainEqual(
        COMMANDS_EXECUTE_CAPABILITY,
      );
      expect(
        await capabilities(createClaudeCodeWorker({ workspace, allowUnsandboxedCommands: true })),
      ).toEqual(
        expect.arrayContaining([UNSANDBOXED_COMMANDS_CAPABILITY, COMMANDS_EXECUTE_CAPABILITY]),
      );
      const opencode = (allowUnsandboxedCommands: boolean) =>
        createOpenCodeWorker({ model: "provider/model", workspace, allowUnsandboxedCommands });
      expect(await capabilities(opencode(false))).not.toContainEqual(COMMANDS_EXECUTE_CAPABILITY);
      expect(await capabilities(opencode(true))).toContainEqual(COMMANDS_EXECUTE_CAPABILITY);
      // Codex sandboxes its commands, so it may run them without an opt-in.
      const sandboxed = await capabilities(createCodexWorker({ workspace }));
      expect(sandboxed).toContainEqual(COMMANDS_EXECUTE_CAPABILITY);
      expect(sandboxed).not.toContainEqual(UNSANDBOXED_COMMANDS_CAPABILITY);
      const cursor = await capabilities(createCursorWorker({ workspace }));
      expect(cursor).toContainEqual(UNSANDBOXED_COMMANDS_CAPABILITY);
      expect(cursor).not.toContainEqual(COMMANDS_EXECUTE_CAPABILITY);
      const allowedCursor = await capabilities(
        createCursorWorker({ workspace, allowUnsandboxedCommands: true }),
      );
      expect(allowedCursor).toEqual(
        expect.arrayContaining([UNSANDBOXED_COMMANDS_CAPABILITY, COMMANDS_EXECUTE_CAPABILITY]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads a host's command support from its descriptor", () => {
    expect(hostCommandSupport(snapshot([unsandboxedClaude, codex]))).toEqual({
      reported: true,
      permitted: true,
      refused: ["claude-code"],
    });
    expect(hostCommandSupport(snapshot([unsandboxedClaude, codex]), "claude-code")).toEqual({
      reported: true,
      permitted: false,
      refused: ["claude-code"],
    });
    expect(hostCommandSupport(snapshot([{ harness: "custom", capabilities: [] }]))).toEqual({
      reported: false,
      permitted: false,
      refused: [],
    });
    expect(
      unsandboxedCommandsReason({ workerHostId: "laptop", harnesses: ["claude-code", "opencode"] }),
    ).toBe(
      "Worker Host laptop runs claude-code and opencode without a sandbox; add them to allow-unsandboxed-commands in its supertag.yaml service to let them run commands.",
    );
  });
});

describe("placement of Tasks that run commands", () => {
  const plan = { status: "none" } as const;
  const place = (
    hosts: readonly PlacementHost[],
    runtimeActions: readonly string[],
    harness?: string,
  ) =>
    placeTask(
      hosts.map((entry) => entry.id),
      [],
      plan as never,
      () => Promise.resolve(hosts),
      [],
      commandPlacement({
        authorizationSnapshot: { runtimeActions },
        execution: harness === undefined ? {} : { harness },
      }),
    );

  it("refuses an unsandboxed harness without the opt-in, naming the setting", async () => {
    expect(
      await place([host("laptop", snapshot([unsandboxedClaude]))], ["commands:execute"]),
    ).toEqual({
      status: "unmet",
      requirement: "allow-unsandboxed-commands:laptop",
      unsandboxedCommands: [{ workerHostId: "laptop", harnesses: ["claude-code"] }],
    });
    expect(unsandboxedCommandsReason({ workerHostId: "laptop", harnesses: ["claude-code"] })).toBe(
      REASON,
    );
  });

  it("places it with the opt-in, on a profile that may run commands", async () => {
    expect(await place([host("laptop", snapshot([allowedClaude]))], ["commands:execute"])).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["laptop"], requires: [COMMANDS_EXECUTE_CAPABILITY] }],
    });
  });

  it("falls back to a sandboxed Codex Worker on the same host, unless the Task names claude-code", async () => {
    const studio = host("studio", snapshot([unsandboxedClaude, codex]));
    expect(await place([studio], ["commands:execute", "files:write"])).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["studio"], requires: [COMMANDS_EXECUTE_CAPABILITY] }],
    });
    expect(await place([studio], ["commands:execute"], "claude-code")).toMatchObject({
      status: "unmet",
      unsandboxedCommands: [{ workerHostId: "studio", harnesses: ["claude-code"] }],
    });
    // Another bound host that may run commands keeps the Task placeable.
    expect(
      await place(
        [host("laptop", snapshot([unsandboxedClaude])), host("server", snapshot([codex]))],
        ["commands:execute"],
      ),
    ).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["server"], requires: [COMMANDS_EXECUTE_CAPABILITY] }],
    });
  });

  it("leaves Tasks without commands:execute, and hosts that report nothing, unaffected", async () => {
    const laptop = host("laptop", snapshot([unsandboxedClaude]));
    expect(await place([laptop], ["files:write"])).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["laptop"], requires: [] }],
    });
    // A custom Worker that reports neither capability is not checked.
    expect(
      await place(
        [host("custom", snapshot([{ harness: "custom", capabilities: [] }]))],
        ["commands:execute"],
      ),
    ).toEqual({ status: "eligible", tiers: [{ allowedWorkerHostIds: ["custom"], requires: [] }] });
  });

  it("explains the hold in the Objective's Runnable condition", () => {
    const facts = (runtimeActions: readonly string[], workerSnapshot: Record<string, unknown>) => ({
      objective: { status: "active" as const, runtimeActions },
      owner: { id: "lead", name: "lead" },
      boundHostIds: ["laptop"],
      hosts: [
        {
          id: "laptop",
          enrollmentStatus: "active" as const,
          connectionStatus: "connected" as const,
          labels: [],
          workerSnapshot,
        },
      ],
      directHosts: [],
    });
    const at = new Date().toISOString();
    expect(
      objectiveRunnableReasons(
        facts(["commands:execute"], snapshot([unsandboxedClaude])) as never,
        at,
      ),
    ).toEqual([REASON]);
    expect(
      objectiveRunnableReasons(facts(["commands:execute"], snapshot([allowedClaude])) as never, at),
    ).toEqual([]);
    expect(
      objectiveRunnableReasons(facts(["files:write"], snapshot([unsandboxedClaude])) as never, at),
    ).toEqual([]);
    // Codex on the same host runs the owner's commands, unless the owner names claude-code.
    const mixed = facts(["commands:execute"], snapshot([unsandboxedClaude, codex]));
    expect(objectiveRunnableReasons(mixed as never, at)).toEqual([]);
    expect(objectiveRunnableReasons({ ...mixed, harness: "claude-code" } as never, at)).toEqual([
      REASON,
    ]);
  });
});

it("holds a claude-code Task that runs commands until its host opts in, and runs others", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-unsandboxed-placement-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const connections = new Map<string, Awaited<ReturnType<typeof connectDurableTestWorklet>>>();
  const observed: { spec: TaskAttemptSpec; workerId: string }[] = [];
  const worker = (harness: string, capabilities: readonly unknown[]): Worker => ({
    async describe() {
      const profile = { id: `local-${harness}`, revision: "1" };
      const all = [COORDINATION, ...(capabilities as { id: string; version: number }[])];
      return {
        id: `local-${harness}`,
        type: "deterministic",
        profiles: [profile],
        capabilities: all,
        contextTypes: [],
        profileCapabilities: [{ profile, harness, capabilities: all, contextTypes: [] }],
        maxConcurrency: 1,
      };
    },
    async *execute(spec) {
      observed.push({ spec, workerId: `local-${harness}` });
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      yield { ...identity, at: new Date().toISOString(), type: "execution.started", workerId: "w" };
      yield {
        ...identity,
        at: new Date().toISOString(),
        type: "output.message",
        message: { role: "teammate", text: `Done on ${harness}` },
      };
      yield { ...identity, at: new Date().toISOString(), type: "execution.completed" };
    },
  });
  const connect = async (workerHostId: string, credential: string, workers: Worker[]) => {
    await connections.get(workerHostId)?.stop();
    connections.set(
      workerHostId,
      await connectDurableTestWorklet({
        url: `${(runtime?.url ?? "").replace(/^http/u, "ws")}/worklets`,
        credential,
        worklet: new LocalWorklet(`${workerHostId}-worklet`, workerHostId, workers, {}),
      }),
    );
  };
  const grant = async (tagId: string, actions: readonly string[]) => {
    const set = await store.createTagPermissionSet({ name: `runtime-${randomUUID()}` });
    for (const action of actions)
      await store.addTagPermission({ permissionSetId: set.id, target: "runtime", action });
    const role = await store.createRole({
      name: `Builder ${randomUUID()}`,
      purpose: "Build.",
      instructions: "Build carefully.",
      contextSetIds: [],
      permissionSetIds: [set.id],
    });
    await store.assignRole({ roleId: role.id, tagId });
  };
  try {
    const lead = await store.createTag({ name: "lead" });
    const builder = await store.createTag({ name: "builder" });
    const reader = await store.createTag({ name: "reader" });
    const mixed = await store.createTag({ name: "mixed" });
    await grant(builder.id, ["commands:execute", "files:write"]);
    await grant(mixed.id, ["commands:execute", "files:write"]);
    await grant(reader.id, ["files:write"]);
    // Tasks take their runtime actions from their Objective.
    for (const [id, runtimeActions] of [
      ["commands", ["commands:execute", "files:write"]],
      ["files", ["files:write"]],
    ] as const) {
      await store.createObjective({ id, ownerTagId: lead.id, outcome: "Ship", runtimeActions });
      await store.createTeam({
        id: `${id}-team`,
        objectiveId: id,
        name: `Shipping ${id}`,
        leadTagId: lead.id,
        memberTagIds: [builder.id, reader.id, mixed.id],
        maxConcurrency: 4,
      });
    }
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "sandbox-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const laptop = await enrollWorkerHost(runtime.url, "sandbox-admin", "laptop");
    const studio = await enrollWorkerHost(runtime.url, "sandbox-admin", "studio");
    for (const tag of [builder, reader]) await store.bindTagWorkerHost(tag.id, "laptop");
    await store.bindTagWorkerHost(mixed.id, "studio");
    await connect("laptop", laptop, [worker("claude-code", [UNSANDBOXED_COMMANDS_CAPABILITY])]);
    await connect("studio", studio, [
      worker("claude-code", [UNSANDBOXED_COMMANDS_CAPABILITY]),
      worker("codex", [COMMANDS_EXECUTE_CAPABILITY]),
    ]);
    await expect
      .poll(async () => (await store.findWorkerHostById("studio"))?.labels ?? [])
      .toContain("harness:codex");

    const assign = async (taskId: string, assignedTagId: string, objectiveId = "commands") => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/assign_task`, {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-admin", "Content-Type": "application/json" },
        body: JSON.stringify({
          objectiveId,
          taskId,
          teamId: `${objectiveId}-team`,
          assignedTagId,
          instruction: "Run the tests",
          acceptanceCriteria: ["Tests ran"],
        }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    await assign("commands-task", builder.id);
    await assign("files-task", reader.id, "files");
    await assign("mixed-task", mixed.id);

    // A Task without commands:execute runs on the unsandboxed harness as before.
    await expect
      .poll(async () => (await store.getTaskAssignment("files-task"))?.status, { timeout: 10000 })
      .toBe("submitted");
    // A sandboxed Codex Worker on the same host takes the Task that runs commands.
    await expect
      .poll(async () => (await store.getTaskAssignment("mixed-task"))?.status, { timeout: 10000 })
      .toBe("submitted");
    expect(observed.find((entry) => entry.spec.taskId === "mixed-task")?.workerId).toBe(
      "local-codex",
    );

    // Without the opt-in, the claude-code Task stays queued and says why.
    await expect
      .poll(
        async () =>
          (await store.listTaskEvents("commands-task")).findLast(
            (event) => event.type === "task.scheduling-incompatible",
          )?.payload,
        { timeout: 10000 },
      )
      .toMatchObject({
        unmetRequirements: ["allow-unsandboxed-commands:laptop"],
        unsandboxedCommands: [{ workerHostId: "laptop", harnesses: ["claude-code"] }],
      });
    expect(observed.some((entry) => entry.spec.taskId === "commands-task")).toBe(false);
    const resource = await (
      await fetch(`${runtime.url}/api/v1/tasks/commands-task`, {
        headers: { Authorization: "Bearer sandbox-admin" },
      })
    ).json();
    expect(describeTask(resource)).toContain(REASON);

    // With the opt-in, the host reports that claude-code may run commands, and the Task runs.
    await connect("laptop", laptop, [
      worker("claude-code", [UNSANDBOXED_COMMANDS_CAPABILITY, COMMANDS_EXECUTE_CAPABILITY]),
    ]);
    await expect
      .poll(async () => (await store.getTaskAssignment("commands-task"))?.status, {
        timeout: 15000,
      })
      .toBe("submitted");
    expect(observed.find((entry) => entry.spec.taskId === "commands-task")?.workerId).toBe(
      "local-claude-code",
    );
  } finally {
    for (const connection of connections.values()) await connection.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
