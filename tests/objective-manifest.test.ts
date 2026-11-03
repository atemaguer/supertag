import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

const HOST = "control-plane-static-host";

const organization = `${header("Workspace", "app")}spec:
  delivery: branch
---
${header("PermissionSet", "build")}spec:
  permissions:
    - target: runtime
      action: commands:execute
    - target: runtime
      action: files:write
---
${header("Role", "Maintainer")}spec:
  purpose: Keep the project healthy.
  instructions: Keep changes small.
  permissionSets: [build]
---
${header("Tag", "maintainer")}spec:
  roles: [Maintainer]
  workerHosts: [${HOST}]
---
${header("Tag", "builder")}spec:
  roles: [Maintainer]
  workerHosts: [${HOST}]
---
${header("Tag", "reviewer")}spec:
  roles: [Maintainer]
  workerHosts: [${HOST}]
`;

const OUTCOME =
  "Keep dependencies current and the build green. Open a pull request for each upgrade.";

const upkeep = (
  options: {
    readonly name?: string;
    readonly outcome?: string;
    readonly extra?: string;
    readonly teams?: string;
  } = {},
) => `${header("Objective", options.name ?? "dependency-upkeep")}spec:
  owner: maintainer
  outcome: ${options.outcome ?? OUTCOME}
  ongoing: true
  workspaces: [app]
${options.extra ?? ""}  teams:
${options.teams ?? "    upkeep: { lead: maintainer, members: [builder], maxConcurrency: 2 }\n"}`;

interface ObjectiveRecord {
  readonly id: string;
  readonly status: string;
  readonly ongoing?: boolean;
  readonly outcome: string;
  readonly deadline: string | null;
  readonly budgetLimitMinor: number | null;
  readonly budgetCurrency: string | null;
  readonly runtimeActions: readonly string[];
  readonly workspaces: readonly string[];
  readonly executionStartedAt: string | null;
}

interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly leadTagId: string;
  readonly memberTagIds: readonly string[];
  readonly maxConcurrency: number;
}

describe("declarative Objectives", () => {
  let directory: string;
  let databasePath: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];
  let errors: string[];
  const token = "objective-manifest-admin";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-objective-manifest-"));
    const serverState = join(directory, "server");
    databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
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
  });

  afterEach(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const write = async (name: string, content: string) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  const run = async (...args: string[]) => {
    output.length = 0;
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
  const objective = (id: string) =>
    client.request<ObjectiveRecord>(`/api/v1/tag-messaging/objectives/${id}`);
  const teams = async (id: string): Promise<readonly TeamRecord[]> => {
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    try {
      return (await store.listTeams(id)).toSorted((left, right) => left.id.localeCompare(right.id));
    } finally {
      await store.disconnect();
    }
  };
  const tagId = async (name: string) => (await client.getTag(name)).metadata.id;
  const applyAll = async (...documents: string[]) =>
    run("apply", "-f", await write("all.yaml", [organization, ...documents].join("---\n")));

  it("creates and starts a declared Objective with its Teams, and re-applies as a no-op", async () => {
    const applied = await applyAll(upkeep());
    expect(applied).toContain("Objective/dependency-upkeep configured");
    expect(applied).toMatch(/Objective\/dependency-upkeep started its owner with Task \S+/);
    const record = await objective("dependency-upkeep");
    expect(record).toMatchObject({
      status: "working",
      ongoing: true,
      outcome: OUTCOME,
      workspaces: ["app"],
    });
    expect(record.executionStartedAt).not.toBeNull();
    // Runtime actions default to what the owner's Permission Sets allow.
    expect([...record.runtimeActions].sort()).toEqual(["commands:execute", "files:write"]);
    const formed = await teams("dependency-upkeep");
    expect(formed.map((team) => team.id)).toEqual([
      "dependency-upkeep:leadership",
      "dependency-upkeep:upkeep",
    ]);
    expect(formed[1]).toMatchObject({
      name: "upkeep",
      status: "active",
      leadTagId: await tagId("maintainer"),
      maxConcurrency: 2,
    });
    expect([...(formed[1]?.memberTagIds ?? [])].sort()).toEqual(
      [await tagId("maintainer"), await tagId("builder")].sort(),
    );

    expect(await run("diff", "-f", join(directory, "all.yaml"))).toContain(
      "No changes. The Control Plane matches the input.",
    );
    const again = await applyAll(upkeep());
    expect(again).not.toContain("started its owner");
    expect((await objective("dependency-upkeep")).executionStartedAt).toBe(
      record.executionStartedAt,
    );
  });

  it("updates the deadline, budget, and runtime actions in place", async () => {
    await applyAll(
      upkeep({
        extra:
          "  budget: { minor: 50000, currency: USD }\n  deadline: 2027-01-01T00:00:00Z\n  runtimeActions: [files:write, commands:execute]\n",
      }),
    );
    expect(await objective("dependency-upkeep")).toMatchObject({
      deadline: "2027-01-01T00:00:00.000Z",
      budgetLimitMinor: 50000,
      budgetCurrency: "USD",
    });
    const changed = upkeep({
      extra:
        "  budget: { minor: 80000, currency: USD }\n  deadline: 2027-06-01T00:00:00Z\n  runtimeActions: [files:write]\n",
    });
    const plan = await run(
      "diff",
      "-f",
      await write("changed.yaml", [organization, changed].join("---\n")),
    );
    expect(plan).toMatch(/~ Objective dependency-upkeep\s+spec\.budget:/);
    expect(plan).toContain("spec.deadline: 2027-01-01T00:00:00.000Z -> 2027-06-01T00:00:00.000Z");
    expect(plan).toContain("Plan: 0 to create, 1 to update, 0 to delete, 0 conflicts.");
    await applyAll(changed);
    expect(await objective("dependency-upkeep")).toMatchObject({
      deadline: "2027-06-01T00:00:00.000Z",
      budgetLimitMinor: 80000,
      runtimeActions: ["files:write"],
    });
    // A budget only increases; a smaller one is refused before anything changes.
    const smaller = upkeep({
      extra:
        "  budget: { minor: 100, currency: USD }\n  deadline: 2027-06-01T00:00:00Z\n  runtimeActions: [files:write]\n",
    });
    expect(
      await fail("apply", "-f", await write("smaller.yaml", [organization, smaller].join("---\n"))),
    ).toContain(
      "Objective/dependency-upkeep: spec.budget: a budget can only increase above its current limit, $800.00",
    );
    // Dropping optional fields releases them: the Objective keeps its values.
    await applyAll(upkeep());
    expect(await objective("dependency-upkeep")).toMatchObject({
      deadline: "2027-06-01T00:00:00.000Z",
      budgetLimitMinor: 80000,
      runtimeActions: ["files:write"],
    });
  });

  it("refuses an outcome change and suggests a new name", async () => {
    await applyAll(upkeep());
    const changed = upkeep({ outcome: "Keep only security patches current." });
    const path = await write("changed.yaml", [organization, changed].join("---\n"));
    expect(await run("diff", "-f", path)).toMatch(
      /! Objective dependency-upkeep\s+spec\.outcome: outcome changed; an Objective's outcome is fixed once it exists\. Give the declaration a new name to create a new Objective, then cancel dependency-upkeep or let --prune cancel it/,
    );
    const message = await fail("apply", "-f", path);
    expect(message).toContain("Nothing was applied. The input changes what cannot change:");
    expect(message).toContain("Objective/dependency-upkeep: spec.outcome: outcome changed;");
    expect((await objective("dependency-upkeep")).outcome).toBe(OUTCOME);
    // A new name is a new Objective.
    await applyAll(
      upkeep({ name: "security-upkeep", outcome: "Keep only security patches current." }),
    );
    expect((await objective("security-upkeep")).status).toBe("working");
  });

  it("reconciles nested Teams under field ownership", async () => {
    await applyAll(upkeep(), "");
    // A Team created imperatively under the Objective is not the manifest's to dissolve.
    await run(
      "create",
      "team",
      "dependency-upkeep:manual",
      "--objective",
      "dependency-upkeep",
      "--name",
      "Manual",
      "--lead",
      "reviewer",
      "--max-concurrency",
      "1",
    );
    const next = upkeep({
      teams:
        "    upkeep: { lead: builder, members: [maintainer, reviewer], maxConcurrency: 3 }\n    review: { lead: reviewer, maxConcurrency: 1 }\n",
    });
    const plan = await run(
      "diff",
      "-f",
      await write("next.yaml", [organization, next].join("---\n")),
    );
    expect(plan).toMatch(/~ Objective dependency-upkeep\s+spec\.teams: ~ upkeep, \+ review/);
    await applyAll(next);
    let current = await teams("dependency-upkeep");
    expect(current.map((team) => [team.id, team.status])).toEqual([
      ["dependency-upkeep:leadership", "active"],
      ["dependency-upkeep:manual", "active"],
      ["dependency-upkeep:review", "active"],
      ["dependency-upkeep:upkeep", "active"],
    ]);
    expect(current[3]).toMatchObject({ leadTagId: await tagId("builder"), maxConcurrency: 3 });

    // Dropping a declared Team dissolves it; the imperative Team stays.
    await applyAll(upkeep({ teams: "    review: { lead: reviewer, maxConcurrency: 1 }\n" }));
    current = await teams("dependency-upkeep");
    expect(current.map((team) => [team.id, team.status])).toEqual([
      ["dependency-upkeep:leadership", "active"],
      ["dependency-upkeep:manual", "active"],
      ["dependency-upkeep:review", "active"],
      ["dependency-upkeep:upkeep", "dissolved"],
    ]);

    // A Team changed with the CLI belongs to cli until apply takes ownership.
    await run(
      "update",
      "team",
      "dependency-upkeep:review",
      "--objective",
      "dependency-upkeep",
      "--max-concurrency",
      "2",
    );
    const reclaim = upkeep({ teams: "    review: { lead: reviewer, maxConcurrency: 1 }\n" });
    const reclaimPath = await write("reclaim.yaml", [organization, reclaim].join("---\n"));
    expect(await fail("apply", "-f", reclaimPath)).toContain(
      "Objective/dependency-upkeep: spec.teams[review] is owned by cli",
    );
    await run("apply", "-f", reclaimPath, "--force-conflicts");
    expect((await teams("dependency-upkeep"))[2]).toMatchObject({ maxConcurrency: 1 });

    // A dissolved Team's name cannot return.
    const revived = upkeep({
      teams:
        "    review: { lead: reviewer, maxConcurrency: 1 }\n    upkeep: { lead: maintainer, maxConcurrency: 1 }\n",
    });
    expect(
      await fail("apply", "-f", await write("revived.yaml", [organization, revived].join("---\n"))),
    ).toContain("Team dependency-upkeep:upkeep was dissolved, and dissolved Teams cannot return");
  });

  it("cancels Objectives that leave a set only with --prune, keeping their history", async () => {
    const both = [organization, upkeep(), upkeep({ name: "docs-upkeep" })].join("---\n");
    await run("apply", "-f", await write("set.yaml", both), "--set", "upkeep");
    const fewer = await write("fewer.yaml", [organization, upkeep()].join("---\n"));
    expect(await run("diff", "-f", fewer, "--set", "upkeep", "--prune")).toMatch(
      /- Objective docs-upkeep\s+cancel; its history is kept[\s\S]*Plan: 0 to create, 0 to update, 0 to delete, 1 to cancel, 0 conflicts\./,
    );
    // Without --prune the Objective keeps running.
    await run("apply", "-f", fewer, "--set", "upkeep");
    expect((await objective("docs-upkeep")).status).toBe("working");
    const pruned = await run("apply", "-f", fewer, "--set", "upkeep", "--prune");
    expect(pruned).toContain("Objective/docs-upkeep cancelled; its history is kept");
    const cancelled = await objective("docs-upkeep");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outcome).toBe(OUTCOME);
    expect((await objective("dependency-upkeep")).status).toBe("working");
    // The cancelled Objective left the set; a second prune has nothing to do.
    expect(await run("apply", "-f", fewer, "--set", "upkeep", "--prune")).not.toContain(
      "docs-upkeep",
    );
    // Its name cannot come back as a new Objective; the declaration changes nothing.
    const back = await write("back.yaml", both);
    expect(await run("diff", "-f", back, "--set", "upkeep")).toMatch(
      /= Objective docs-upkeep\s+Objective docs-upkeep was cancelled and cannot run again; remove it from the input, or give the declaration a new name/,
    );
    errors.length = 0;
    await run("apply", "-f", back, "--set", "upkeep");
    expect(errors.join("")).toContain(
      "Warning: Objective/docs-upkeep: Objective docs-upkeep was cancelled and cannot run again",
    );
    expect((await objective("docs-upkeep")).status).toBe("cancelled");
  });

  it("starts the owner on a later apply when the first apply could not", async () => {
    const solo = `${header("Tag", "solo")}spec: {}\n`;
    const declared = `${header("Objective", "solo-upkeep")}spec:
  owner: solo
  outcome: Keep the changelog tidy.
`;
    const path = await write("solo.yaml", [organization, solo, declared].join("---\n"));
    const first = await run("apply", "-f", path);
    expect(first).not.toContain("started its owner");
    expect(errors.join("")).toContain(
      "Warning: Objective/solo-upkeep: the owner was not started: Tag solo cannot accept Tasks because it has no Worker Host binding.",
    );
    expect((await objective("solo-upkeep")).executionStartedAt).toBeNull();
    expect(await run("diff", "-f", path)).toMatch(
      /~ Objective solo-upkeep\s+starts the owner\nPlan: 0 to create, 1 to update/,
    );
    await run("update", "tag", "solo", "--add-worker-host", HOST);
    expect(await run("apply", "-f", path)).toMatch(
      /Objective\/solo-upkeep started its owner with Task/,
    );
    expect(await run("diff", "-f", path)).toContain("No changes.");
  });

  it("prunes an Objective before its owner Tag, so one prune removes both", async () => {
    const temp = `${header("Tag", "temp")}spec:\n  workerHosts: [${HOST}]\n`;
    const declared = `${header("Objective", "temp-upkeep")}spec:
  owner: temp
  outcome: Keep the temporary branch rebased.
  teams:
    crew: { lead: temp, members: [builder], maxConcurrency: 1 }
`;
    await run(
      "apply",
      "-f",
      await write("temp.yaml", [organization, temp, declared].join("---\n")),
      "--set",
      "ops",
    );
    const rest = await write("rest.yaml", organization);
    const plan = await run("diff", "-f", rest, "--set", "ops", "--prune");
    expect(plan).toMatch(/- Objective temp-upkeep\s+cancel; its history is kept/);
    expect(plan).toMatch(/- Tag temp\n/);
    const pruned = await run("apply", "-f", rest, "--set", "ops", "--prune");
    expect(pruned).toContain("Objective/temp-upkeep cancelled; its history is kept");
    expect(pruned).toContain("Tag/temp deleted");
    expect((await objective("temp-upkeep")).status).toBe("cancelled");
  });

  it("exports an Objective manifest that applies back without changes", async () => {
    await applyAll(
      upkeep({
        extra: "  budget: { minor: 50000, currency: USD }\n  deadline: 2027-01-01T00:00:00Z\n",
      }),
    );
    const exported = await run("get", "objective", "dependency-upkeep", "--output", "yaml");
    expect(exported).toContain("kind: Objective");
    expect(exported).toContain("name: dependency-upkeep");
    expect(exported).toContain("owner: maintainer");
    expect(exported).toContain("upkeep:");
    expect(exported).not.toContain("status");
    const path = await write("exported.yaml", exported);
    expect(await run("diff", "-f", path)).toContain(
      "No changes. The Control Plane matches the input.",
    );
    // The JSON form still comes from the Objective reader.
    expect(JSON.parse(await run("get", "objective", "dependency-upkeep"))).toMatchObject({
      id: "dependency-upkeep",
    });
  });

  it("protects Tags and Workspaces a declared open Objective uses, and never deletes Objectives", async () => {
    await applyAll(upkeep());
    expect(await fail("delete", "workspace", "app")).toBe(
      "workspace app is in use by Objective dependency-upkeep (working).",
    );
    expect(await fail("delete", "tag", "builder")).toContain(
      "Team dependency-upkeep:upkeep of Objective dependency-upkeep (member)",
    );
    expect(await fail("delete", "tag", "maintainer")).toContain(
      "Objective dependency-upkeep (owner)",
    );
    expect(await fail("delete", "objective", "dependency-upkeep")).toBe(
      "Objectives are cancelled, not deleted, so their history stays: supertag cancel objective dependency-upkeep",
    );
  });

  it("rejects declared status and unknown fields", async () => {
    const withStatus = `${header("Objective", "bad")}spec:
  owner: maintainer
  outcome: Do it.
  status: completed
`;
    expect(await fail("apply", "-f", await write("bad.yaml", withStatus))).toContain(
      "spec.status: an Objective's status is observed, not declared",
    );
    const leadership = upkeep({
      teams: "    leadership: { lead: maintainer, maxConcurrency: 1 }\n",
    });
    expect(await fail("apply", "-f", await write("lead.yaml", leadership))).toContain(
      "leadership is the owner's own Team",
    );
  });
});
