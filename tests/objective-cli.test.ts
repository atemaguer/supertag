import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.ts";
import {
  ControlPlaneClient,
  ControlPlaneRequestError,
} from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { withCurrentRevision } from "../apps/cli/src/revision.ts";
import { generateObjectiveId } from "../packages/core/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

describe("generated Objective IDs", () => {
  it("uses the outcome's first words and a short suffix, always a valid ID", () => {
    expect(generateObjectiveId("Ship SSO for the admin console.", () => "7f3k")).toBe(
      "ship-sso-for-7f3k",
    );
    expect(generateObjectiveId("  Réduire   la latence!! ", () => "ab12")).toBe(
      "reduire-la-latence-ab12",
    );
    expect(generateObjectiveId("日本語だけ", () => "zz99")).toBe("objective-zz99");
    const generated = generateObjectiveId("A".repeat(300));
    expect(generated).toMatch(/^a{40}-[a-z0-9]{4}$/u);
    expect(generateObjectiveId("Same outcome")).not.toBe(generateObjectiveId("Same outcome"));
  });
});

describe("human commands fill in the current revision", () => {
  const conflict = () => new ControlPlaneRequestError("Objective revision changed", 409);

  it("uses an explicit revision as given", async () => {
    const write = vi.fn(async (revision: number) => revision);
    await expect(
      withCurrentRevision({
        explicit: "4",
        resource: "Objective a",
        read: async () => ({ revision: 9 }),
        fields: ["status"],
        write,
      }),
    ).resolves.toBe(4);
    await expect(
      withCurrentRevision({
        explicit: "0",
        resource: "Objective a",
        read: async () => ({ revision: 9 }),
        fields: ["status"],
        write,
      }),
    ).rejects.toThrow("positive integer");
  });

  it("retries once when another writer changed unrelated fields", async () => {
    const reads = [
      { revision: 3, status: "working", deadline: null },
      { revision: 4, status: "working", deadline: "2030-01-01T00:00:00.000Z" },
    ];
    const write = vi.fn(async (revision: number) => {
      if (revision === 3) throw conflict();
      return `wrote ${revision}`;
    });
    await expect(
      withCurrentRevision({
        explicit: undefined,
        resource: "Objective a",
        read: async () => reads.shift() ?? { revision: 4 },
        fields: ["status"],
        write,
      }),
    ).resolves.toBe("wrote 4");
    expect(write.mock.calls.map(([revision]) => revision)).toEqual([3, 4]);
  });

  it("reports a conflict when the other writer changed the same field", async () => {
    const reads = [
      { revision: 3, status: "working" },
      { revision: 4, status: "blocked" },
    ];
    const write = vi.fn(async () => {
      throw conflict();
    });
    await expect(
      withCurrentRevision({
        explicit: undefined,
        resource: "Objective a",
        read: async () => reads.shift() ?? { revision: 4 },
        fields: ["status"],
        write,
      }),
    ).rejects.toThrow("Objective a changed while you were updating it (revision 3 to 4; status");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports ordinary conflicts unchanged and gives up after one retry", async () => {
    const unsettled = new ControlPlaneRequestError("Tasks remain unsettled", 409);
    await expect(
      withCurrentRevision({
        explicit: undefined,
        resource: "Objective a",
        read: async () => ({ revision: 3 }),
        fields: ["status"],
        write: async () => {
          throw unsettled;
        },
      }),
    ).rejects.toBe(unsettled);
    let revision = 3;
    await expect(
      withCurrentRevision({
        explicit: undefined,
        resource: "Team t",
        read: async () => ({ revision: revision++ }),
        fields: ["name"],
        write: async () => {
          throw conflict();
        },
      }),
    ).rejects.toThrow("Team t is changing concurrently");
  });
});

describe("Objective commands", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];
  let errors: string[];
  let databaseUrl: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-objective-cli-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
    databaseUrl = `file:${databasePath}`;
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
    });
    output = [];
    errors = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
    await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    client = new ControlPlaneClient({ url: runtime.url, token });
    await client.createTag({ name: "planner" });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const run = async (...args: string[]) => {
    output.length = 0;
    errors.length = 0;
    await expect(main(args)).resolves.toBe(0);
    return output.join("");
  };
  const fail = async (...args: string[]) => {
    const error = await main(args).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  };

  it("routes message and approve to the Objective commands", () => {
    expect(
      normalizeActionFirstCommand(["message", "objective", "a", "Fix it", "--reopen"]),
    ).toEqual(["objective", "message", "a", "Fix it", "--reopen"]);
    expect(normalizeActionFirstCommand(["approve", "objective", "a"])).toEqual([
      "objective",
      "approve",
      "a",
    ]);
  });

  it("generates an ID, warns about what would hold Tasks, and dry-runs without creating", async () => {
    const dry = JSON.parse(
      await run(
        "create",
        "objective",
        "--outcome",
        "Ship SSO for the admin console",
        "--owner",
        "planner",
        "--budget-minor",
        "0",
        "--dry-run",
        "--output",
        "json",
      ),
    ) as { id: string; warnings?: unknown };
    expect(dry.id).toMatch(/^ship-sso-for-[a-z0-9]{4}$/u);
    expect(dry.warnings).toBeUndefined();
    const noRuntimeActions =
      "Warning: Owner Tag planner's Permission Sets allow no runtime actions; its Tasks cannot edit files or run commands. Grant files:write or commands:execute in a Permission Set on one of the Tag's Roles.\n";
    expect(errors).toEqual([
      noRuntimeActions,
      "Warning: The budget is 0, so no Task can be allocated. Raise it with --budget-minor.\n",
      "Warning: Tag planner has no Worker Host, so its Tasks cannot run. Create an Auth Key and join a host with it: supertag create auth-key NAME --tag planner\n",
      `Dry run: Objective ${dry.id} was checked but not created.\n`,
    ]);
    await expect(
      client.request(`/api/v1/tag-messaging/objectives/${dry.id}`),
    ).rejects.toMatchObject({ status: 404 });
    // Never-satisfiable input is still an error, in a dry run too.
    expect(
      await fail(
        "create",
        "objective",
        "--outcome",
        "Ship",
        "--owner",
        "planner",
        "--workspace",
        "missing",
        "--dry-run",
      ),
    ).toContain("Workspace missing does not exist");

    // People get a one-line summary on stdout; warnings stay on stderr.
    const summary = await run(
      "create",
      "objective",
      "--outcome",
      "Ship SSO for the admin console",
      "--owner",
      "planner",
    );
    const createdId = /^objective\/(ship-sso-for-[a-z0-9]{4}) created\n/u.exec(summary)?.[1];
    expect(createdId).toBeDefined();
    expect(summary).toBe(
      `objective/${createdId} created\nFollow it: supertag watch objective ${createdId}\nSee results: supertag describe objective ${createdId}\n`,
    );
    // The owner without a Worker Host cannot start, so create also says it was not started.
    expect(errors.filter((line) => line.startsWith("Warning: "))).toHaveLength(3);
    expect(errors.at(-1)).toMatch(/^Warning: The owner was not started: /u);
    // --output json prints the full record for scripts.
    const created = JSON.parse(
      await run(
        "create",
        "objective",
        "--outcome",
        "Ship SSO for the admin console",
        "--owner",
        "planner",
        "--output",
        "json",
      ),
    ) as { id: string; status: string };
    expect(created).toMatchObject({ status: "working" });
    expect(created.id).toMatch(/^ship-sso-for-[a-z0-9]{4}$/u);
    expect(errors.at(-1)).toBe(`Created Objective ${created.id}.\n`);

    // Bound to the embedded Worker Host, the owner's Tasks can run; only the missing runtime
    // actions are reported, since they limit rather than hold the Tasks.
    await run("update", "tag", "planner", "--add-worker-host", "control-plane-static-host");
    expect(
      await run("create", "objective", "ready", "--outcome", "Ship", "--owner", "planner"),
    ).toContain("objective/ready created\nStarted planner with Task ready:start.\n");
    expect(errors).toEqual([noRuntimeActions]);
    const described = await run("describe", "objective", "ready");
    expect(described).toContain("Runnable: yes");
    await run("update", "tag", "planner", "--remove-worker-host", "control-plane-static-host");
    // An enrolled host that is not connected; the embedded API only lists its own host.
    const direct = new DrizzleStore({ url: databaseUrl });
    await direct.connect();
    const planner = await direct.findTagByName("planner");
    await direct.bindTagWorkerHost(planner?.id as string, "remote-host");
    await direct.disconnect();
    expect(await run("describe", "objective", "ready")).toContain(
      "Runnable: no. No Worker Host bound to Tag planner is connected (remote-host).",
    );
    const overview = JSON.parse(
      await run("describe", "objective", "ready", "--output", "json"),
    ) as {
      conditions: unknown;
    };
    expect(overview.conditions).toEqual([
      {
        type: "Runnable",
        status: false,
        reasons: [
          "No Worker Host bound to Tag planner is connected (remote-host). Its Tasks wait until one connects.",
        ],
      },
    ]);
  });

  it("starts the owner on create, once, and never on a dry run", async () => {
    const started = async (id: string) => {
      const direct = new DrizzleStore({ url: databaseUrl });
      await direct.connect();
      try {
        const objective = await direct.getObjective(id).catch(() => undefined);
        return {
          startedAt: objective?.executionStartedAt ?? null,
          teams: objective ? (await direct.listTeams(id)).map((team) => team.id) : [],
          tasks: objective ? (await direct.listTaskAssignments(id)).map((task) => task.taskId) : [],
        };
      } finally {
        await direct.disconnect();
      }
    };
    // Without a Worker Host the owner cannot start; the Objective is still created.
    await run("create", "objective", "launch", "--outcome", "Launch", "--owner", "planner");
    expect(errors.filter((line) => line.startsWith("Warning: The owner was not started:"))).toEqual(
      [
        "Warning: The owner was not started: Tag planner cannot accept Tasks because it has no Worker Host binding. Bind a Worker Host to the Tag, then retry. Once that is fixed, run this command again with ID launch to start it.\n",
      ],
    );
    // Like start_objective, the attempt leaves only the empty leadership Team behind.
    expect(await started("launch")).toEqual({
      startedAt: null,
      teams: ["launch:leadership"],
      tasks: [],
    });
    expect(await run("describe", "objective", "launch")).toContain(
      "rerun supertag create objective with this ID and the same definition",
    );

    await run("update", "tag", "planner", "--add-worker-host", "control-plane-static-host");
    await run(
      "create",
      "objective",
      "draft",
      "--outcome",
      "Draft",
      "--owner",
      "planner",
      "--dry-run",
    );
    expect(errors.some((line) => line.startsWith("Started owner"))).toBe(false);
    expect(await started("draft")).toEqual({ startedAt: null, teams: [], tasks: [] });
    // --no-start only creates, for operators who assign the Tasks themselves.
    await run(
      "create",
      "objective",
      "manual",
      "--outcome",
      "Manual",
      "--owner",
      "planner",
      "--no-start",
    );
    expect(errors.some((line) => line.startsWith("Started owner"))).toBe(false);
    expect(await started("manual")).toEqual({ startedAt: null, teams: [], tasks: [] });

    // Rerunning the same create starts the owner, and running it again changes nothing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await run("create", "objective", "launch", "--outcome", "Launch", "--owner", "planner"),
      ).toContain("Started planner with Task launch:start.\n");
    }
    const first = await started("launch");
    expect(first).toMatchObject({
      startedAt: expect.any(String),
      teams: ["launch:leadership"],
      tasks: ["launch:start"],
    });

    // start_objective stays available and returns the existing start Task.
    const input = join(directory, "start.json");
    await writeFile(input, JSON.stringify({ objectiveId: "launch", maxCostMinor: 1000 }));
    expect(JSON.parse(await run("coordinate", "start_objective", "--input", input))).toMatchObject({
      taskId: "launch:start",
    });
    expect(await started("launch")).toEqual(first);
  });

  it("updates, completes, messages, and approves without a revision", async () => {
    await run(
      "create",
      "objective",
      "report",
      "--outcome",
      "Write the report",
      "--owner",
      "planner",
    );
    const deadline = "2031-01-01T00:00:00.000Z";
    expect(await run("update", "objective", "report", "--deadline", deadline)).toBe(
      `objective/report updated: deadline ${deadline} (revision 2).\n`,
    );
    expect(
      JSON.parse(
        await run("update", "objective", "report", "--status", "blocked", "--output", "json"),
      ),
    ).toMatchObject({ status: "blocked", revision: 3 });
    expect(
      await fail("update", "objective", "report", "--status", "working", "--revision", "2"),
    ).toBe("Objective revision changed; reload before updating");

    // Answering a blocked owner returns the Objective to working.
    expect(await run("message", "objective", "report", "Use the 2030 figures.")).toMatch(
      /^Sent message \S+ to the owner of Objective report\.\nThe Objective moved from blocked to working\.\nThe Objective has not started; the owner reads the message once it starts\.\n$/u,
    );
    expect(await fail("approve", "objective", "report")).toContain(
      "Objective report is working, not ready_for_review",
    );
    await run("update", "objective", "report", "--status", "ready_for_review");
    expect(JSON.parse(await run("get", "objective", "report"))).toMatchObject({
      status: "ready_for_review",
    });
    // Unread operator mail holds approval, exactly as it holds completion.
    expect(await fail("approve", "objective", "report")).toContain("Mailbox messages remain");
  });

  it("prints an updated budget limit in major units", async () => {
    await run(
      "create",
      "objective",
      "costed",
      "--outcome",
      "Cost it",
      "--owner",
      "planner",
      "--budget-minor",
      "1000",
      "--budget-currency",
      "USD",
    );
    expect(await run("update", "objective", "costed", "--budget-minor", "1380")).toBe(
      "objective/costed updated: budget limit $13.80 (revision 2).\n",
    );
  });

  it("completes without a revision and reopens a completed Objective only with --reopen", async () => {
    await run("create", "objective", "notes", "--outcome", "Write notes", "--owner", "planner");
    expect(await run("complete", "objective", "notes", "--summary", "Notes written.")).toBe(
      "objective/notes completed (revision 2).\n",
    );
    expect(JSON.parse(await run("get", "objective", "notes"))).toMatchObject({
      status: "completed",
      completionSummary: "Notes written.",
      revision: 2,
    });
    expect(await fail("message", "objective", "notes", "Add a glossary.")).toContain("--reopen");
    expect(await run("message", "objective", "notes", "Add a glossary.", "--reopen")).toContain(
      "The Objective was reopened and is working again.",
    );
    expect(JSON.parse(await run("get", "objective", "notes"))).toMatchObject({
      status: "working",
      completionSummary: null,
      revision: 3,
    });
  });

  it("updates Teams without a revision and reads their channels", async () => {
    await run("create", "objective", "ops", "--outcome", "Run ops", "--owner", "planner");
    const team = await run(
      "create",
      "team",
      "crew",
      "--objective",
      "ops",
      "--name",
      "Crew",
      "--lead",
      "planner",
      "--max-concurrency",
      "1",
    );
    expect(team).toBe("team/crew created.\n");
    expect(
      JSON.parse(
        await run(
          "update",
          "team",
          "crew",
          "--objective",
          "ops",
          "--name",
          "Crew 2",
          "--output",
          "json",
        ),
      ),
    ).toMatchObject({ name: "Crew 2", revision: 2 });
    // The Team's channel was created with it and reads the Team's current name.
    const channel = JSON.parse(await run("get", "workstream", "crew")) as Record<string, unknown>;
    expect(channel).toMatchObject({ id: "crew", objectiveId: "ops", title: "Crew 2" });
    expect(channel).not.toHaveProperty("status");
    expect(channel).not.toHaveProperty("revision");
    const direct = new DrizzleStore({ url: databaseUrl });
    await direct.connect();
    try {
      const planner = await direct.findTagByName("planner");
      await direct.postWorkstream({
        workstreamId: "crew",
        authorTagId: planner?.id as string,
        body: "Which region first?",
        type: "question",
        to: [planner?.id as string],
        idempotencyKey: "region",
      });
      const listing = await run("list", "workstream-post", "--workstream", "crew");
      expect(listing).toMatch(/SEQUENCE\s+AUTHOR\s+TYPE\s+TO\s+TIME\s+MESSAGE/u);
      expect(listing).toContain("question");
      expect(listing).toContain(planner?.id as string);
    } finally {
      await direct.disconnect();
    }
    const tagged = await run("list", "workstream", "--tag", "planner");
    expect(tagged).toMatch(/ID\s+TITLE\s+OBJECTIVE\s+OWNER[\s\S]*crew\s+Crew 2\s+ops\s+\S/u);
    const all = await run("list", "workstream");
    expect(all).toMatch(/ID\s+TITLE\s+OBJECTIVE\s+OWNER[\s\S]*crew\s+Crew 2\s+ops\s+\S/u);
    // Text tables name the owner Tag rather than its ID.
    for (const listing of [tagged, all]) {
      const row = listing.split("\n").find((line) => line.startsWith("crew "));
      expect(row?.trim().split(/\s+/u).at(-1)).toMatch(/^[a-z][\w-]*$/u);
      expect(row).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    }
    await fail("create", "workstream", "stream", "--objective", "ops", "--title", "Stream");
    await fail("update", "workstream", "crew", "--status", "blocked");
    await fail("list", "workstream-message", "--workstream", "crew");
    expect(await run("dissolve", "team", "crew", "--objective", "ops")).toBe(
      "team/crew dissolved (revision 3).\n",
    );
  });
});
