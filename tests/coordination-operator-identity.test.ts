import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

it("binds coordination operators to server-side identity and least-privilege scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-operator-identity-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let store: DrizzleStore | undefined;
  try {
    await migrateDatabase({ url: databaseUrl });
    store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const sourceOwner = await store.createTag({ name: "Source owner" });
    const targetOwner = await store.createTag({ name: "Target owner" });
    const deniedOwner = await store.createTag({ name: "Denied owner" });
    const source = await store.createObjective({
      id: "operator-source",
      ownerTagId: sourceOwner.id,
      outcome: "Govern the scoped Team",
    });
    const target = await store.createObjective({
      id: "operator-target",
      ownerTagId: targetOwner.id,
      outcome: "Receive governance",
    });
    const denied = await store.createObjective({
      id: "operator-denied",
      ownerTagId: deniedOwner.id,
      outcome: "Remain isolated",
    });
    const allowedTeam = await store.createTeam({
      id: "operator-team-allowed",
      objectiveId: source.id,
      objectiveIds: [target.id],
      name: "Allowed Team",
      leadTagId: sourceOwner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const deniedTeam = await store.createTeam({
      id: "operator-team-denied",
      objectiveId: source.id,
      objectiveIds: [target.id],
      name: "Denied Team",
      leadTagId: sourceOwner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: "operator-break-glass-token",
      coordinationOperatorCredentials: [
        {
          token: "scoped-reviewer-token",
          operatorId: "operator:alice",
          actions: ["update_team", "read_coordination_inbox", "read_team_history"],
          objectiveIds: [source.id, target.id],
          teamIds: [allowedTeam.id],
        },
        {
          token: "revoked-reviewer-token",
          operatorId: "operator:revoked",
          actions: ["read_coordination_inbox"],
          objectiveIds: [source.id],
          revoked: true,
        },
      ],
    });
    const scopedHeaders = {
      authorization: "Bearer scoped-reviewer-token",
      "content-type": "application/json",
      "x-operator-id": "forged-from-request",
    };
    const update = await fetch(`${runtime.url}/api/v1/coordination/update_team`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({
        objectiveId: source.id,
        teamId: allowedTeam.id,
        expectedRevision: allowedTeam.revision,
        context: { reviewedBy: "scoped operator" },
      }),
    });
    expect(update.status, await update.text()).toBe(200);
    expect((await store.getTeam(allowedTeam.id)).context).toEqual({
      reviewedBy: "scoped operator",
    });

    const history = await fetch(
      `${runtime.url}/api/v1/coordination/teams/${allowedTeam.id}/history?objectiveId=${source.id}`,
      { headers: scopedHeaders },
    );
    const historyText = await history.text();
    expect(history.status, historyText).toBe(200);
    expect(JSON.parse(historyText)).toMatchObject({
      projectionVersion: 1,
      team: { id: allowedTeam.id, revision: 2 },
      changes: [
        { fromRevision: 0, toRevision: 1 },
        {
          fromRevision: 1,
          toRevision: 2,
          actorTagId: null,
          operatorId: "operator:alice",
          changes: {
            context: { previous: {}, next: { reviewedBy: "scoped operator" } },
          },
        },
      ],
    });

    const forbiddenHistory = await fetch(
      `${runtime.url}/api/v1/coordination/teams/${deniedTeam.id}/history?objectiveId=${source.id}`,
      { headers: scopedHeaders },
    );
    expect(forbiddenHistory.status).toBe(403);

    const forbiddenAction = await fetch(`${runtime.url}/api/v1/coordination/read_objective`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ objectiveId: source.id }),
    });
    expect(forbiddenAction.status).toBe(403);

    const forbiddenObjective = await fetch(`${runtime.url}/api/v1/coordination/update_team`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({
        objectiveId: denied.id,
        teamId: allowedTeam.id,
        expectedRevision: allowedTeam.revision + 1,
        context: {},
      }),
    });
    expect(forbiddenObjective.status).toBe(403);

    const forbiddenTeam = await fetch(`${runtime.url}/api/v1/coordination/update_team`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({
        objectiveId: source.id,
        teamId: deniedTeam.id,
        expectedRevision: deniedTeam.revision,
        context: {},
      }),
    });
    expect(forbiddenTeam.status).toBe(403);

    const revoked = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=${source.id}`,
      { headers: { authorization: "Bearer revoked-reviewer-token" } },
    );
    expect(revoked.status).toBe(401);

    const controlPlane = await fetch(`${runtime.url}/api/v1/status`, {
      headers: scopedHeaders,
    });
    expect(controlPlane.status).toBe(403);

    const breakGlass = await fetch(`${runtime.url}/api/v1/coordination/update_team`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-break-glass-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        objectiveId: source.id,
        teamId: deniedTeam.id,
        expectedRevision: deniedTeam.revision,
        context: { reviewedBy: "break glass" },
      }),
    });
    expect(breakGlass.status, await breakGlass.text()).toBe(200);
    expect((await store.getTeam(deniedTeam.id)).context).toEqual({
      reviewedBy: "break glass",
    });
  } finally {
    await runtime?.close();
    await store?.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

it("loads scoped operator credentials from the Control Plane secret file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-operator-file-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  const credentialsPath = join(directory, "coordination-operators.json");
  const previous = process.env["SUPERTAG_COORDINATION_OPERATORS_FILE"];
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  try {
    await migrateDatabase({ url: databaseUrl });
    await writeFile(
      credentialsPath,
      JSON.stringify([
        {
          token: "file-scoped-token",
          operatorId: "operator:file",
          actions: ["read_coordination_inbox"],
        },
      ]),
    );
    process.env["SUPERTAG_COORDINATION_OPERATORS_FILE"] = credentialsPath;
    runtime = await startControlPlaneRuntime({ host: "127.0.0.1", port: 0, databaseUrl });

    const response = await fetch(`${runtime.url}/api/v1/coordination/inbox`, {
      headers: { authorization: "Bearer file-scoped-token" },
    });
    expect(response.status, await response.text()).toBe(200);
  } finally {
    await runtime?.close();
    if (previous === undefined) delete process.env["SUPERTAG_COORDINATION_OPERATORS_FILE"];
    else process.env["SUPERTAG_COORDINATION_OPERATORS_FILE"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
