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
    const deniedOwner = await store.createTag({ name: "Denied owner" });
    for (const tag of [sourceOwner, deniedOwner])
      await store.bindTagWorkerHost(tag.id, "control-plane-static-host");
    const source = await store.createObjective({
      id: "operator-source",
      ownerTagId: sourceOwner.id,
      outcome: "Govern the scoped work",
    });
    const denied = await store.createObjective({
      id: "operator-denied",
      ownerTagId: deniedOwner.id,
      outcome: "Remain isolated",
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
          actions: ["message_objective", "read_coordination_inbox"],
          objectiveIds: [source.id],
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
    const message = (token: string, objectiveId: string, text: string) =>
      fetch(`${runtime?.url}/api/v1/coordination/objectives/${objectiveId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });

    // The server's own identity is used, never the one the request claims.
    const sent = await fetch(
      `${runtime.url}/api/v1/coordination/objectives/${source.id}/messages`,
      { method: "POST", headers: scopedHeaders, body: JSON.stringify({ text: "Reviewed" }) },
    );
    const sentText = await sent.text();
    expect(sent.status, sentText).toBe(200);
    const turn = await store.findTaskById((JSON.parse(sentText) as { taskId: string }).taskId);
    expect(turn?.actor).toMatchObject({ id: "operator:alice" });

    // An Objective outside the credential's scope is refused.
    expect((await message("scoped-reviewer-token", denied.id, "Reviewed")).status).toBe(403);

    // An action the credential does not carry is refused, even on an Objective it may read.
    const forbiddenAction = await fetch(
      `${runtime.url}/api/v1/coordination/objectives/${source.id}/overview`,
      { headers: scopedHeaders },
    );
    expect(forbiddenAction.status).toBe(403);

    const revoked = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=${source.id}`,
      { headers: { authorization: "Bearer revoked-reviewer-token" } },
    );
    expect(revoked.status).toBe(401);

    // A coordination credential is not a management credential.
    const controlPlane = await fetch(`${runtime.url}/api/v1/status`, { headers: scopedHeaders });
    expect(controlPlane.status).toBe(403);

    // Break glass reaches the Objective the scoped credential may not.
    const breakGlass = await message("operator-break-glass-token", denied.id, "Reviewed");
    const breakGlassText = await breakGlass.text();
    expect(breakGlass.status, breakGlassText).toBe(200);
    const glassTurn = await store.findTaskById(
      (JSON.parse(breakGlassText) as { taskId: string }).taskId,
    );
    expect(glassTurn?.actor).toMatchObject({ id: "control-plane-break-glass" });
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
