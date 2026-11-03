import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApprovalCommand } from "../apps/cli/src/approvals.ts";
import { runAuditCommand } from "../apps/cli/src/audit-command.ts";
import {
  AuditTrail,
  classifyManagementRequest,
  fileAuditSink,
  type ManagementAuditEvent,
  noteCoordinationCommand,
  noteRequestBody,
} from "../apps/cli/src/audit-trail.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { runObjectiveCommand } from "../apps/cli/src/objectives.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import type { AdmitTaskAssignmentInput, AuditEntry, Store } from "../packages/core/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const ADMIN = "audit-admin-token-value";
const SCOPED = "audit-scoped-coordination-token";
const postgres = process.env["SUPERTAG_POSTGRES_URL"];

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runtime(
  dialect: "sqlite" | "postgresql",
  options: { readonly sink?: (event: ManagementAuditEvent) => void } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-audit-runtime-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let databaseUrl = `file:${join(directory, "state.db")}`;
  if (dialect === "postgresql") {
    const isolated = await createIsolatedPostgresDatabase(postgres as string);
    databaseUrl = isolated.url;
    cleanups.push(isolated.cleanup);
  }
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  cleanups.push(() => store.disconnect());
  const events: ManagementAuditEvent[] = [];
  const started = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl,
    stateDirectory: directory,
    adminToken: ADMIN,
    coordinationOperatorCredentials: [
      { token: SCOPED, operatorId: "release-coordinator", actions: ["*"] },
    ],
    audit: options.sink ?? ((event) => events.push(event)),
    reply: async () => {},
  });
  cleanups.push(() => started.close());
  const call = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${started.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  const audit = async (token = ADMIN, query = "") => {
    const response = await call(token, `/api/v1/audit${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: AuditEntry[] }).items;
  };
  return { url: started.url, store, events, call, audit, directory };
}

const summary = ({ actor, action, target, outcome, status }: AuditEntry) => ({
  actor,
  action,
  target,
  outcome,
  status,
});

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`audit trail (${dialect})`, () => {
    it("records every operator change with actor, action, target, time, and outcome, and never a secret", async () => {
      const { url, store, events, call, audit, directory } = await runtime(dialect);
      const startedAt = new Date().toISOString();

      // Operator Token management, by the admin token.
      const created = await call(ADMIN, "/api/v1/operator-tokens", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "OperatorToken",
          metadata: { name: "laptop-2" },
          spec: {},
        }),
      });
      expect(created.status).toBe(201);
      const tokenSecret = ((await created.json()) as { secret: string }).secret;
      const operator = { url, token: tokenSecret };
      const client = new ControlPlaneClient(operator);

      // Applies and deletes, by the Operator Token.
      const manifest = join(directory, "tag.yaml");
      await writeFile(
        manifest,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata:\n  name: reviewer\nspec: {}\n",
      );
      await runResourceCommand(client, "apply", ["-f", manifest]);
      const invalid = await call(tokenSecret, "/api/v1/roles", {
        method: "POST",
        body: JSON.stringify({ apiVersion: "supertag/v1", kind: "Role", metadata: { name: "x" } }),
      });
      expect(invalid.status).toBeGreaterThanOrEqual(400);

      // Auth Key management.
      const authKey = await call(tokenSecret, "/api/v1/auth-keys", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "AuthKey",
          metadata: { name: "build-hosts" },
          spec: { tags: ["reviewer"] },
        }),
      });
      expect(authKey.status, await authKey.clone().text()).toBe(201);
      const authKeySecret = ((await authKey.json()) as { secret: string }).secret;
      expect(
        (await call(tokenSecret, "/api/v1/auth-keys/build-hosts/revoke", { method: "POST" }))
          .status,
      ).toBe(200);

      // A Worker Host credential, issued and rotated.
      const enrolled = await call(tokenSecret, "/api/v1/worker-hosts", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "WorkerHostEnrollment",
          metadata: { id: "build-host" },
          spec: {},
        }),
      });
      expect(enrolled.status, await enrolled.clone().text()).toBe(201);
      const hostToken = ((await enrolled.json()) as { credential: { token: string } }).credential
        .token;
      const rotated = await call(tokenSecret, "/api/v1/worker-hosts/build-host/credential", {
        method: "POST",
      });
      expect(rotated.status).toBe(200);
      const rotatedToken = ((await rotated.json()) as { credential: { token: string } }).credential
        .token;

      // Surface credentials in an enrollment.
      const enrollment = await call(tokenSecret, "/api/v1/surface-enrollments", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "SurfaceEnrollment",
          metadata: { id: "enroll-1" },
          spec: {
            provider: "slack",
            externalAccountId: "T-AUDIT",
            displayName: "Audit",
            authMethod: "slack-socket-mode",
            configuration: { transport: "socket" },
            secrets: { botToken: "xoxb-audit-secret", appToken: "xapp-audit-secret" },
          },
        }),
      });
      expect(enrollment.status, await enrollment.clone().text()).toBe(200);

      // Approvals, Objective messages, approval, and cancellation.
      const fixture = await objectiveFixture(store);
      const approve = await createApproval(store, fixture);
      const deny = await createApproval(store, fixture);
      const decide = await createApproval(store, fixture);
      await runApprovalCommand(operator, ["approve", approve.id]);
      await runApprovalCommand(operator, ["deny", deny.id, "--reason", "Wait for the freeze"]);
      const decided = await call(tokenSecret, "/api/v1/coordination/decide_approval", {
        method: "POST",
        body: JSON.stringify({
          objectiveId: fixture.objective.id,
          requestId: decide.id,
          decision: "deny",
          reason: "Not now",
        }),
      });
      expect(decided.status, await decided.clone().text()).toBe(200);
      await runObjectiveCommand(operator, ["message", fixture.objective.id, "Include the CSV"]);
      // An Objective without open Tasks, which its owner submitted for review.
      const reviewed = await store.createObjective({
        id: "reviewed",
        ownerTagId: fixture.owner.id,
        outcome: "Write the notes",
      });
      await store.updateObjectiveStatus(
        reviewed.id,
        { status: "ready_for_review", expectedRevision: reviewed.revision },
        fixture.owner.id,
      );
      await runObjectiveCommand(operator, ["approve", reviewed.id]);
      await runObjectiveCommand(operator, ["message", reviewed.id, "One more change", "--reopen"]);
      const cancelled = await call(
        tokenSecret,
        `/api/v1/objectives/${fixture.objective.id}/cancel`,
        { method: "POST", body: JSON.stringify({ reason: "Superseded" }) },
      );
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      // A scoped coordination credential is recorded under its configured operator ID.
      expect(
        (
          await call(SCOPED, `/api/v1/coordination/objectives/${fixture.objective.id}/approve`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(409);

      await runResourceCommand(client, "delete", ["tag", "reviewer"]);
      expect(
        (await call(ADMIN, "/api/v1/operator-tokens/laptop-2/revoke", { method: "POST" })).status,
      ).toBe(200);

      const entries = await audit();
      const token = "token:laptop-2";
      const objective = `Objective/${fixture.objective.id}`;
      expect(entries.map(summary)).toEqual(
        expect.arrayContaining([
          {
            actor: "control-plane-break-glass",
            action: "operator-token.create",
            target: "OperatorToken/laptop-2",
            outcome: "succeeded",
            status: 201,
          },
          {
            actor: token,
            action: "apply",
            target: "Tag/reviewer",
            outcome: "succeeded",
            status: 201,
          },
          {
            actor: token,
            action: "apply",
            target: "Role",
            outcome: "failed",
            status: expect.any(Number),
          },
          {
            actor: token,
            action: "auth-key.create",
            target: "AuthKey/build-hosts",
            outcome: "succeeded",
            status: 201,
          },
          {
            actor: token,
            action: "auth-key.revoke",
            target: "AuthKey/build-hosts",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "worker-host.enroll",
            target: "WorkerHost/build-host",
            outcome: "succeeded",
            status: 201,
          },
          {
            actor: token,
            action: "worker-host.credential.rotate",
            target: "WorkerHost/build-host",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "approval.approve",
            target: `ApprovalRequest/${approve.id}`,
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "approval.deny",
            target: `ApprovalRequest/${deny.id}`,
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "approval.deny",
            target: `ApprovalRequest/${decide.id}`,
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "objective.message",
            target: objective,
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "objective.approve",
            target: "Objective/reviewed",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "objective.reopen",
            target: "Objective/reviewed",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "objective.cancel",
            target: objective,
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: "release-coordinator",
            action: "objective.approve",
            target: "Objective",
            outcome: "failed",
            status: 409,
          },
          {
            actor: token,
            action: "delete",
            target: "Tag/reviewer",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: "control-plane-break-glass",
            action: "operator-token.revoke",
            target: "OperatorToken/laptop-2",
            outcome: "succeeded",
            status: 200,
          },
        ]),
      );
      for (const entry of entries) {
        expect(entry.at >= startedAt).toBe(true);
        expect(entry.source).toBe("api");
      }
      // Newest first.
      expect(entries.map((entry) => entry.at)).toEqual(
        entries
          .map((entry) => entry.at)
          .toSorted()
          .toReversed(),
      );
      // Reads are not recorded.
      expect(entries.some((entry) => entry.method === "GET")).toBe(false);

      // No secret, digest, or request body reaches the database or the sink.
      const stored = JSON.stringify(await store.listAuditEntries({ limit: 500 }));
      const sunk = events.map((event) => JSON.stringify(event)).join("\n");
      expect(events).toHaveLength(entries.length);
      for (const secret of [
        ADMIN,
        SCOPED,
        tokenSecret,
        digest(tokenSecret),
        authKeySecret,
        digest(authKeySecret),
        hostToken,
        rotatedToken,
        "xoxb-audit-secret",
        "xapp-audit-secret",
        "Include the CSV",
        "One more change",
        "Wait for the freeze",
        "Superseded",
        "Not now",
      ]) {
        expect(stored).not.toContain(secret);
        expect(sunk).not.toContain(secret);
      }
      expect(stored).not.toMatch(/stop_[a-f0-9]{8}|secretDigest|"spec"/u);
    }, 60_000);

    it("keeps no part of an unmatched path and records route templates, never request paths", async () => {
      const { store, events, call, audit } = await runtime(dialect);
      const secret = "unmatched-path-credential-value";
      const underscored = "sk_live_unmatched_path_credential";
      for (const [method, path] of [
        ["POST", `/api/v1/${secret}`],
        ["POST", `/api/v1/${underscored}?dryRun=true`],
        ["DELETE", `/api/v1/no-such-kind/${secret}`],
        ["PUT", `/api/v1/tags/${secret}/extra/${underscored}`],
        ["POST", `/api/v1/coordination/${secret.replaceAll("-", "_")}`],
        ["POST", `/api/v1/coordination/approvals/missing/${secret}`],
        ["DELETE", `/api/v1/${encodeURIComponent(`${secret}/${underscored}`)}`],
      ] as const) {
        const response = await call(ADMIN, path, { method, body: "{}" });
        expect(response.status, path).toBeGreaterThanOrEqual(400);
      }
      // A known route records its template. A failed request keeps only the target's kind, so a
      // credential-shaped name in a recognized route is never stored either.
      expect((await call(ADMIN, "/api/v1/tags/missing", { method: "DELETE" })).status).toBe(404);
      const recognized = "sk_live_recognized_route_credential";
      expect((await call(ADMIN, `/api/v1/tags/${recognized}`, { method: "DELETE" })).status).toBe(
        404,
      );

      const entries = await audit();
      expect(entries).toHaveLength(9);
      expect(
        entries.map(({ action, target, method, path, outcome }) => ({
          action,
          target,
          method,
          path,
          outcome,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            action: "delete",
            target: "Tag",
            method: "DELETE",
            path: "/api/v1/tags/{name}",
            outcome: "failed",
          },
          {
            action: "coordination.command",
            target: "Objective",
            method: "POST",
            path: "/api/v1/coordination/{command}",
            outcome: "failed",
          },
        ]),
      );
      const unmatched = entries.filter((entry) => entry.target === "UnknownRoute");
      expect(unmatched).toHaveLength(6);
      for (const entry of unmatched) {
        expect(entry.action).toBe("request");
        expect(entry.path).toBeUndefined();
        expect(entry.outcome).toBe("failed");
      }
      const stored = JSON.stringify(await store.listAuditEntries({ limit: 500 }));
      const sunk = events.map((event) => JSON.stringify(event)).join("\n");
      expect(events).toHaveLength(9);
      for (const value of [
        secret,
        underscored,
        secret.replaceAll("-", "_"),
        "no-such-kind",
        "missing",
        recognized,
      ]) {
        expect(stored).not.toContain(value);
        expect(sunk).not.toContain(value);
      }
    });
  });

describe("audit reads and sinks", () => {
  it("keeps only the target kind for a dry run, which creates nothing", async () => {
    const { store, events, call, audit } = await runtime("sqlite");
    const name = "sk_live_dry_run_credential";
    const response = await call(ADMIN, "/api/v1/tags?dryRun=true", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name },
        spec: {},
      }),
    });
    expect(response.status).toBeLessThan(400);
    const entries = await audit();
    expect(entries.map(({ action, target, outcome }) => ({ action, target, outcome }))).toEqual([
      { action: "apply.dry-run", target: "Tag", outcome: "succeeded" },
    ]);
    expect(JSON.stringify(await store.listAuditEntries({ limit: 500 }))).not.toContain(name);
    expect(events.map((event) => JSON.stringify(event)).join("\n")).not.toContain(name);
  });

  it("filters by actor, time, and limit, validates its query, and stays read-only", async () => {
    const { url, call, audit } = await runtime("sqlite");
    const tag = (token: string, name: string) =>
      call(token, "/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name },
          spec: {},
        }),
      });
    expect((await tag(ADMIN, "first")).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const between = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await tag(ADMIN, "second")).status).toBe(201);
    expect(
      (
        await call(SCOPED, "/api/v1/coordination/approvals/missing/approve", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);

    expect((await audit()).map((entry) => entry.target)).toEqual([
      "ApprovalRequest",
      "Tag/second",
      "Tag/first",
    ]);
    expect((await audit(ADMIN, `?since=${encodeURIComponent(between)}`)).length).toBe(2);
    expect(
      (await audit(ADMIN, "?actor=control-plane-break-glass")).map((entry) => entry.target),
    ).toEqual(["Tag/second", "Tag/first"]);
    expect((await audit(ADMIN, "?limit=1")).map((entry) => entry.target)).toEqual([
      "ApprovalRequest",
    ]);
    for (const query of [
      "?limit=0",
      "?limit=501",
      "?limit=ten",
      "?since=yesterday",
      "?actor=",
      "?other=1",
      "?limit=1&limit=2",
    ]) {
      const response = await call(ADMIN, `/api/v1/audit${query}`);
      expect(response.status, query).toBe(400);
    }
    expect((await fetch(`${url}/api/v1/audit`)).status).toBe(401);
    // Scoped coordination credentials reach only the coordination API.
    expect((await call(SCOPED, "/api/v1/audit")).status).toBe(403);
    // Reading the audit trail adds nothing to it.
    expect(await audit()).toHaveLength(3);
  });

  it("supertag audit prints entries as text or JSON and validates its flags", async () => {
    const { url, call } = await runtime("sqlite");
    const response = await call(ADMIN, "/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "cli" },
        spec: {},
      }),
    });
    expect(response.status).toBe(201);
    const client = new ControlPlaneClient({ url, token: ADMIN });
    const text = await runAuditCommand(client, []);
    const [header, row] = text.trimEnd().split("\n");
    expect(header).toMatch(/^TIME\s+ACTOR\s+ACTION\s+TARGET\s+OUTCOME$/u);
    expect(row).toMatch(/control-plane-break-glass\s+apply\s+Tag\/cli\s+succeeded \(201\)$/u);
    const json = JSON.parse(
      await runAuditCommand(client, [
        "--output",
        "json",
        "--actor",
        "control-plane-break-glass",
        "--limit",
        "5",
      ]),
    ) as { kind: string; items: AuditEntry[] };
    expect(json.kind).toBe("AuditEntryList");
    expect(json.items).toEqual([
      expect.objectContaining({
        actor: "control-plane-break-glass",
        action: "apply",
        target: "Tag/cli",
      }),
    ]);
    expect(await runAuditCommand(client, ["--actor", "token:nobody"])).toBe(
      "No audit entries match.\n",
    );
    expect(
      await runAuditCommand(client, ["--since", new Date(Date.now() + 60_000).toISOString()]),
    ).toBe("No audit entries match.\n");
    await expect(runAuditCommand(client, ["--limit", "0"])).rejects.toThrow(/--limit must be/u);
    await expect(runAuditCommand(client, ["--since", "last week"])).rejects.toThrow(
      /--since must be/u,
    );
    await expect(runAuditCommand(client, ["--output", "yaml"])).rejects.toThrow(/--output/u);
    await expect(runAuditCommand(client, ["extra"])).rejects.toThrow(/Usage/u);
  });

  it("appends each entry to the logging.audit file as one JSON line besides the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-audit-file-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "audit.jsonl");
    const { call, audit, store } = await runtime("sqlite", { sink: fileAuditSink(file) });
    const created = await call(ADMIN, "/api/v1/operator-tokens", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "OperatorToken",
        metadata: { name: "file-sink" },
        spec: {},
      }),
    });
    expect(created.status).toBe(201);
    const secret = ((await created.json()) as { secret: string }).secret;
    expect((await call(ADMIN, "/api/v1/tags/missing", { method: "DELETE" })).status).toBe(404);
    const [newest, oldest] = await audit();
    // The file catches up asynchronously; wait until both lines are written.
    let lines: string[] = [];
    for (let attempt = 0; attempt < 50 && lines.length < 2; attempt++) {
      lines = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
      if (lines.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const parsed = lines.map((line) => JSON.parse(line) as ManagementAuditEvent);
    expect(parsed).toEqual([
      { type: "supertag.audit", ...oldest },
      { type: "supertag.audit", ...newest },
    ]);
    expect(parsed[1]).toMatchObject({
      action: "delete",
      target: "Tag",
      outcome: "failed",
      status: 404,
    });
    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(digest(secret));
    expect(contents).not.toContain(ADMIN);
    expect(await store.listAuditEntries()).toHaveLength(2);
  });

  it("never fails a request when the file sink or the database cannot record it", async () => {
    const reported: unknown[] = [];
    const missing = join(tmpdir(), `supertag-missing-${Date.now()}`, "audit.jsonl");
    const { call, audit } = await runtime("sqlite", {
      sink: fileAuditSink(missing, (error) => reported.push(error)),
    });
    const response = await call(ADMIN, "/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "kept" },
        spec: {},
      }),
    });
    expect(response.status).toBe(201);
    // The database still has the entry the file could not take.
    expect((await audit()).map((entry) => entry.target)).toEqual(["Tag/kept"]);
    for (let attempt = 0; attempt < 50 && reported.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toHaveLength(1);

    const failures: unknown[] = [];
    const broken: Pick<Store, "recordAuditEntry"> = {
      recordAuditEntry: async () => {
        throw new Error("database is down");
      },
    };
    const trail = new AuditTrail(
      broken,
      () => {
        throw new Error("sink is full");
      },
      (error) => failures.push(error),
    );
    await expect(
      trail.record({
        at: new Date().toISOString(),
        actor: "token:laptop-2",
        action: "apply",
        target: "Tag/builder",
        outcome: "succeeded",
        source: "api",
      }),
    ).resolves.toBeUndefined();
    await trail.settled();
    expect(failures.map((error) => (error as Error).message)).toEqual([
      "sink is full",
      "database is down",
    ]);
  });

  it("never throws when the store throws synchronously, the sink throws, or the reporter throws", async () => {
    const attempted: string[] = [];
    const trail = new AuditTrail(
      {
        recordAuditEntry: (entry) => {
          attempted.push(entry.target);
          throw new Error("database is down");
        },
      },
      thrown("sink is full"),
      thrown("reporter is down"),
    );
    const entry = {
      at: new Date().toISOString(),
      actor: "token:laptop-2",
      action: "apply",
      target: "Tag/builder",
      outcome: "succeeded",
      source: "api",
    } as const;
    expect(() => trail.record(entry)).not.toThrow();
    await expect(trail.record(entry)).resolves.toBeUndefined();
    await expect(trail.settled()).resolves.toBeUndefined();
    expect(attempted).toEqual(["Tag/builder", "Tag/builder"]);

    // A file sink whose reporter throws keeps writing later lines.
    const directory = await mkdtemp(join(tmpdir(), "supertag-audit-reporter-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const missing = join(directory, "missing", "audit.jsonl");
    const reported: unknown[] = [];
    const sink = fileAuditSink(missing, (error) => {
      reported.push(error);
      throw new Error("reporter is down");
    });
    const event = { type: "supertag.audit", id: "e", ...entry } as const;
    sink(event);
    sink(event);
    for (let attempt = 0; attempt < 50 && reported.length < 2; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toHaveLength(2);
  });

  it("answers management requests when recording and its error reporter throw synchronously", async () => {
    const { call } = await runtime("sqlite", { sink: thrown("sink is full") });
    const record = vi
      .spyOn(DrizzleStore.prototype, "recordAuditEntry")
      .mockImplementation(thrown("database is down"));
    const reported: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: never[]
    ) => {
      if (String(chunk).startsWith("Could not record the audit entry")) {
        reported.push(String(chunk));
        throw new Error("standard error is closed");
      }
      return write(chunk, ...rest);
    }) as typeof process.stderr.write);
    cleanups.push(() => {
      record.mockRestore();
      stderr.mockRestore();
    });

    const created = await call(ADMIN, "/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "kept" },
        spec: {},
      }),
    });
    expect(created.status).toBe(201);
    expect((await call(ADMIN, "/api/v1/tags/kept", { method: "DELETE" })).status).toBe(200);
    // The Control Plane keeps serving after both recordings failed.
    for (let attempt = 0; attempt < 50 && reported.length < 4; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([
      expect.stringContaining("sink is full"),
      expect.stringContaining("database is down"),
      expect.stringContaining("sink is full"),
      expect.stringContaining("database is down"),
    ]);
    expect((await call(ADMIN, "/api/v1/tags/kept", { method: "DELETE" })).status).toBe(404);
  });
});

describe("audit classification", () => {
  const classify = (method: string, path: string) =>
    classifyManagementRequest(method, new URL(path, "http://control-plane"));

  it("names a meaningful action and target for each management write", () => {
    expect(classify("DELETE", "/api/v1/permission-sets/release?dryRun=true")).toEqual({
      action: "delete.dry-run",
      target: "PermissionSet/release",
      route: "/api/v1/permission-sets/{name}",
    });
    expect(classify("POST", "/api/v1/apply-sets/platform/prune")).toEqual({
      action: "prune",
      target: "ApplySet/platform",
      route: "/api/v1/apply-sets/{name}/prune",
    });
    expect(classify("POST", "/api/v1/tasks/t-1/cancel")).toEqual({
      action: "task.cancel",
      target: "Task/t-1",
      route: "/api/v1/tasks/{id}/cancel",
    });
    // A path segment that is not a plain name or ID is left out of the target.
    expect(classify("POST", "/api/v1/tasks/task%20one/cancel")).toEqual({
      action: "task.cancel",
      target: "Task",
      route: "/api/v1/tasks/{id}/cancel",
    });
    expect(classify("POST", "/api/v1/worker-hosts/build/drain")).toEqual({
      action: "worker-host.drain",
      target: "WorkerHost/build",
      route: "/api/v1/worker-hosts/{id}/drain",
    });
    expect(classify("DELETE", "/api/v1/worker-hosts/build/credential")).toEqual({
      action: "worker-host.credential.revoke",
      target: "WorkerHost/build",
      route: "/api/v1/worker-hosts/{id}/credential",
    });
    expect(classify("PATCH", "/api/v1/tag-messaging/objectives/launch")).toEqual({
      action: "objective.update",
      target: "Objective/launch",
      route: "/api/v1/tag-messaging/objectives/{id}",
    });
    // An unmatched path is the caller's and might hold a credential, so none of it is kept.
    for (const [method, path] of [
      ["POST", "/api/v1/somewhere-new"],
      ["POST", "/api/v1/sk_live_secret"],
      ["DELETE", "/api/v1/unknown-kind/st_op_secret"],
      ["PATCH", "/api/v1/tags/builder"],
      ["POST", "/other/st_op_secret"],
    ])
      expect(classify(method as string, path as string), path).toEqual({
        action: "request",
        target: "UnknownRoute",
      });
    // A coordination command is named only once the handler recognizes it.
    expect(classify("POST", "/api/v1/coordination/st_op_secret")).toEqual({
      action: "coordination.command",
      target: "Objective",
      route: "/api/v1/coordination/{command}",
    });

    const command = classify("POST", "/api/v1/coordination/update_task");
    noteCoordinationCommand(command, "update_task", { objectiveId: "o", taskId: "t-1" });
    expect(command).toEqual({
      action: "coordination.update_task",
      target: "Task/t-1",
      route: "/api/v1/coordination/{command}",
    });
    const decision = classify("POST", "/api/v1/coordination/decide_approval");
    noteCoordinationCommand(decision, "decide_approval", { requestId: "r-1", decision: "approve" });
    expect(decision).toEqual({
      action: "approval.approve",
      target: "ApprovalRequest/r-1",
      route: "/api/v1/coordination/{command}",
    });
  });

  it("never names a Tag operation's or surface enrollment's target from its request ID", () => {
    const operation = classifyManagementRequest(
      "POST",
      new URL("http://localhost/api/v1/tag-operations"),
    );
    noteRequestBody(operation, { metadata: { id: "sk_live_tag_operation_credential" } });
    expect(operation).toMatchObject({ action: "tag.operation", target: "Tag" });
    const enrollment = classifyManagementRequest(
      "POST",
      new URL("http://localhost/api/v1/surface-enrollments"),
    );
    noteRequestBody(enrollment, { metadata: { id: "sk_live_enrollment_credential" } });
    expect(enrollment).toMatchObject({ action: "surface.enroll", target: "SurfaceAccount" });
  });

  it("reads only a well-formed name from a body and nothing else", () => {
    const apply = classify("POST", "/api/v1/tags");
    noteRequestBody(apply, { metadata: { name: "builder" }, spec: { secret: "s3cret" } });
    expect(apply).toEqual({ action: "apply", target: "Tag/builder", route: "/api/v1/tags" });
    const odd = classify("POST", "/api/v1/auth-keys");
    noteRequestBody(odd, { metadata: { name: "has spaces and\nnewlines" } });
    expect(odd).toEqual({
      action: "auth-key.create",
      target: "AuthKey",
      route: "/api/v1/auth-keys",
    });
  });
});

function thrown(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function objectiveFixture(store: Store) {
  const owner = await store.createTag({ name: "owner" });
  const objective = await store.createObjective({
    id: "audited",
    ownerTagId: owner.id,
    outcome: "Ship the export",
  });
  const team = await store.createTeam({
    id: "audited-team",
    objectiveId: objective.id,
    name: "Export Team",
    leadTagId: owner.id,
    memberTagIds: [],
    maxConcurrency: 1,
  });
  await store.admitTaskAssignment(assignment(objective.id, team.id, owner));
  return { owner, objective, team };
}

function createApproval(store: Store, fixture: Awaited<ReturnType<typeof objectiveFixture>>) {
  return store.createApprovalRequest({
    objectiveId: fixture.objective.id,
    taskId: "audited-task",
    requestingTagId: fixture.owner.id,
    kind: "plan",
    actions: [{ target: "runtime", action: "deploy" }],
    summary: "Deploy after merge",
    ruleSources: ["release"],
    approvers: [],
  });
}

function assignment(
  objectiveId: string,
  teamId: string,
  owner: { readonly id: string; readonly name: string },
): AdmitTaskAssignmentInput {
  return {
    taskId: "audited-task",
    objectiveId,
    teamId,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "Export the report",
    acceptanceCriteria: ["done"],
    execution: {},
    authorizationSnapshot: {
      version: 4,
      capturedAt: new Date().toISOString(),
      tag: { id: owner.id, name: owner.name },
      origin: { kind: "internal", objectiveId, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
    workspacePlan: { version: 1, status: "none" },
  };
}
