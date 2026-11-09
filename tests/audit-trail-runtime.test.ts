import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApprovalCommand } from "../apps/cli/src/approvals.ts";
import { runAuditCommand } from "../apps/cli/src/audit-command.ts";
import {
  AuditTrail,
  fileAuditSink,
  type ManagementAuditEvent,
} from "../apps/cli/src/audit-trail.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { runObjectiveCommand } from "../apps/cli/src/objectives.ts";
import {
  accessClient,
  hostClient,
  inboxClient,
  objectiveClient,
  organizationClient,
  surfaceClient,
} from "../apps/cli/src/operator-client.ts";
import { auditEntryView } from "../apps/cli/src/organization-protos.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import type { AuditEntry, Store } from "../packages/core/src/index.ts";
import {
  type ListAuditEntriesRequestSchema,
  SurfaceProvider,
} from "../packages/operator-api/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { openTestTask } from "./support/artifact-producer.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { issueOperatorToken } from "./support/operator-access.ts";

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
  const rpc = (token: string, method: string, body: unknown) =>
    call(token, `/supertag.operator.v1.ResourceService/${method}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  /** Applies one manifest as `curl` sends it: a Connect JSON POST. */
  const apply = (token: string, manifest: unknown) =>
    rpc(token, "ApplyManifests", { documents: [{ manifest }] });
  const remove = (token: string, name: string) =>
    rpc(token, "DeleteResource", { kind: "RESOURCE_KIND_TAG", name });
  const tag = (token: string, name: string) =>
    apply(token, { apiVersion: "supertag/v1", kind: "Tag", metadata: { name }, spec: {} });
  const audit = async (
    token = ADMIN,
    request: MessageInitShape<typeof ListAuditEntriesRequestSchema> = {},
  ): Promise<AuditEntry[]> =>
    (await organizationClient({ url: started.url, token }).listAuditEntries(request)).entries.map(
      auditEntryView,
    );
  return { url: started.url, store, events, call, rpc, apply, remove, tag, audit, directory };
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
      const { url, store, events, call, apply, audit, directory } = await runtime(dialect);
      const startedAt = new Date().toISOString();

      // Operator Token management, by the admin token.
      const tokenSecret = await issueOperatorToken(url, ADMIN, "laptop-2");
      const operator = { url, token: tokenSecret };
      const hosts = hostClient(operator);
      const client = new ControlPlaneClient(operator);

      // Applies and deletes, by the Operator Token.
      const manifest = join(directory, "tag.yaml");
      await writeFile(
        manifest,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata:\n  name: reviewer\nspec: {}\n",
      );
      await runResourceCommand(client, "apply", ["-f", manifest]);
      const invalid = await apply(tokenSecret, {
        apiVersion: "supertag/v1",
        kind: "Role",
        metadata: { name: "x" },
      });
      expect(invalid.status).toBe(400);

      // Auth Key management.
      const authKeySecret = (await hosts.createAuthKey({ name: "build-hosts", tags: ["reviewer"] }))
        .secret;
      await hosts.revokeAuthKey({ name: "build-hosts" });

      // A Worker Host credential, issued and rotated.
      const hostToken = (await hosts.enrollWorkerHost({ id: "build-host" })).token;
      const rotatedToken = (
        await hosts.rotateWorkerHostCredential({ id: "build-host", expectedCredentialRevision: 1n })
      ).token;

      // Surface credentials in an enrollment.
      const enrolled = await surfaceClient(operator).setUpSurface({
        provider: SurfaceProvider.SLACK,
        externalAccountId: "T-AUDIT",
        displayName: "Audit",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-audit-secret", appToken: "xapp-audit-secret" },
      });

      // Approvals, Objective messages, approval, and cancellation.
      const fixture = await objectiveFixture(store);
      const approve = await createApproval(store, fixture);
      const deny = await createApproval(store, fixture);
      const decide = await createApproval(store, fixture);
      await runApprovalCommand(operator, ["approve", approve.id]);
      await runApprovalCommand(operator, ["deny", deny.id, "--reason", "Wait for the freeze"]);
      // Deny as `curl` sends it: a Connect JSON POST.
      const decided = await call(tokenSecret, "/supertag.operator.v1.InboxService/Deny", {
        method: "POST",
        body: JSON.stringify({ id: decide.id, reason: "Not now" }),
      });
      expect(decided.status, await decided.clone().text()).toBe(200);
      await runObjectiveCommand(operator, [
        "message",
        fixture.objective.id,
        "Include-the-CSV",
        "--output",
        "json",
      ]);
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
      // A message to an Objective waiting on review puts it back to work instead of approving it.
      await runObjectiveCommand(operator, [
        "message",
        reviewed.id,
        "One-more-change",
        "--output",
        "json",
      ]);
      await store.updateObjectiveStatus(
        reviewed.id,
        {
          status: "ready_for_review",
          expectedRevision: (await store.getObjective(reviewed.id)).revision,
        },
        fixture.owner.id,
      );
      await runObjectiveCommand(operator, ["approve", reviewed.id]);
      await objectiveClient(operator).cancelObjective({
        id: fixture.objective.id,
        reason: "Superseded",
      });
      // A scoped coordination credential is recorded under its configured operator ID.
      await expect(
        objectiveClient({ url, token: SCOPED }).approveObjective({ id: fixture.objective.id }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });

      await runResourceCommand(client, "delete", ["tag", "reviewer"]);
      await accessClient({ url, token: ADMIN }).revokeOperatorToken({ name: "laptop-2" });

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
            status: 200,
          },
          {
            actor: token,
            action: "resource.apply",
            target: "Tag/reviewer",
            outcome: "succeeded",
            status: 200,
          },
          {
            actor: token,
            action: "resource.apply",
            target: "Role",
            outcome: "failed",
            status: 400,
          },
          {
            actor: token,
            action: "auth-key.create",
            target: "AuthKey/build-hosts",
            outcome: "succeeded",
            status: 200,
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
            status: 200,
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
            action: "surface.enroll",
            target: `SurfaceAccount/${enrolled.metadata?.id}`,
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
            action: "objective.message",
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
            status: 400,
          },
          {
            actor: token,
            action: "resource.delete",
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
        "Include-the-CSV",
        "One-more-change",
        "Wait for the freeze",
        "Superseded",
        "Not now",
      ]) {
        expect(stored).not.toContain(secret);
        expect(sunk).not.toContain(secret);
      }
      expect(stored).not.toMatch(/stop_[a-f0-9]{8}|secretDigest|"spec"/u);
    }, 60_000);

    it("records an RPC's method, and only its target's kind once it fails", async () => {
      const { store, events, call, remove, audit } = await runtime(dialect);
      const secret = "unmatched-path-credential-value";
      // No HTTP management route is left to record; unknown paths are refused and not recorded.
      for (const [method, path] of [
        ["POST", `/api/v1/${secret}`],
        ["DELETE", `/api/v1/worker-hosts/${secret}`],
        ["POST", `/api/v1/coordination/approvals/missing/${secret}`],
      ] as const) {
        const response = await call(ADMIN, path, { method, body: "{}" });
        expect(response.status, path).toBeGreaterThanOrEqual(400);
      }
      const denied = await call(ADMIN, "/supertag.operator.v1.InboxService/Deny", {
        method: "POST",
        body: JSON.stringify({ id: "sk_live_missing_approval", reason: "No" }),
      });
      expect(denied.status).toBe(404);
      // A failed call keeps only the target's kind, so a credential-shaped name is never stored.
      expect((await remove(ADMIN, "missing")).status).toBe(404);
      const recognized = "sk_live_recognized_route_credential";
      expect((await remove(ADMIN, recognized)).status).toBe(404);

      const entries = await audit();
      expect(
        entries.map(({ action, target, method, path, outcome }) => ({
          action,
          target,
          method,
          path,
          outcome,
        })),
      ).toEqual([
        {
          action: "resource.delete",
          target: "Tag",
          method: "POST",
          path: "/supertag.operator.v1.ResourceService/DeleteResource",
          outcome: "failed",
        },
        {
          action: "resource.delete",
          target: "Tag",
          method: "POST",
          path: "/supertag.operator.v1.ResourceService/DeleteResource",
          outcome: "failed",
        },
        {
          action: "approval.deny",
          target: "ApprovalRequest",
          method: "POST",
          path: "/supertag.operator.v1.InboxService/Deny",
          outcome: "failed",
        },
      ]);
      const stored = JSON.stringify(await store.listAuditEntries({ limit: 500 }));
      const sunk = events.map((event) => JSON.stringify(event)).join("\n");
      expect(events).toHaveLength(3);
      for (const value of [secret, "sk_live_missing_approval", "missing", recognized]) {
        expect(stored).not.toContain(value);
        expect(sunk).not.toContain(value);
      }
    });
  });

describe("audit reads and sinks", () => {
  it("records nothing for a plan or a dry-run delete, which change nothing", async () => {
    const { store, events, rpc, tag, audit } = await runtime("sqlite");
    const name = "sk_live_dry_run_credential";
    const response = await rpc(ADMIN, "DiffManifests", {
      documents: [
        { manifest: { apiVersion: "supertag/v1", kind: "Tag", metadata: { name }, spec: {} } },
      ],
    });
    expect(response.status).toBe(200);
    expect(await audit()).toEqual([]);
    expect((await tag(ADMIN, "kept")).status).toBe(200);
    const previewed = await rpc(ADMIN, "DeleteResource", {
      kind: "RESOURCE_KIND_TAG",
      name: "kept",
      dryRun: true,
    });
    expect(previewed.status).toBe(200);
    expect((await audit()).map((entry) => entry.target)).toEqual(["Tag/kept"]);
    expect(JSON.stringify(await store.listAuditEntries({ limit: 500 }))).not.toContain(name);
    expect(events.map((event) => JSON.stringify(event)).join("\n")).not.toContain(name);
  });

  it("records each resource an apply changed, failed to change, or pruned", async () => {
    const { url, rpc, audit } = await runtime("sqlite");
    const tag = (name: string, spec: object = {}) => ({
      manifest: { apiVersion: "supertag/v1", kind: "Tag", metadata: { name }, spec },
    });
    const applied = async (body: object) => {
      const response = await rpc(ADMIN, "ApplyManifests", body);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { complete?: boolean };
    };
    const latest = async (count: number) =>
      (await audit())
        .slice(0, count)
        .map(({ action, target, outcome, status, path }) => ({
          action,
          target,
          outcome,
          status,
          path,
        }))
        // One call's entries share a time, so they are listed in no particular order.
        .toSorted((left, right) => left.target.localeCompare(right.target));
    const path = "/supertag.operator.v1.ResourceService/ApplyManifests";

    await applied({ documents: [tag("reviewer"), tag("builder")], applySet: "team" });
    expect(await latest(2)).toEqual(
      ["Tag/builder", "Tag/reviewer"].map((target) => ({
        action: "resource.apply",
        target,
        outcome: "succeeded",
        status: 200,
        path,
      })),
    );

    await applied({ documents: [tag("builder")], applySet: "team", prune: true });
    expect(await latest(2)).toEqual([
      { action: "resource.apply", target: "Tag/builder", outcome: "succeeded", status: 200, path },
      { action: "resource.prune", target: "Tag/reviewer", outcome: "succeeded", status: 200, path },
    ]);

    await surfaceClient({ url, token: ADMIN }).setUpSurface({
      provider: SurfaceProvider.SLACK,
      externalAccountId: "T-AUDIT-APPLY",
      displayName: "Audit apply",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-audit-apply", appToken: "xapp-audit-apply" },
    });
    const location = { locations: [{ provider: "slack", channelId: "C0SHARED" }] };
    await applied({ documents: [tag("holder", location)] });
    const before = (await audit()).length;
    // Only the write finds that another Tag already answers in the channel.
    const partial = await applied({
      documents: [
        {
          manifest: {
            apiVersion: "supertag/v1",
            kind: "Volume",
            metadata: { name: "datasets" },
            spec: { source: "file:///srv/data", credential: "data" },
          },
        },
        tag("taker", location),
        tag("later", { acceptsMessagesFrom: ["taker"] }),
      ],
    });
    expect(partial.complete ?? false).toBe(false);
    expect((await audit()).length - before).toBe(2);
    expect(await latest(2)).toEqual([
      { action: "resource.apply", target: "Tag", outcome: "failed", status: 400, path },
      {
        action: "resource.apply",
        target: "Volume/datasets",
        outcome: "succeeded",
        status: 200,
        path,
      },
    ]);
  });

  it("filters by actor, time, and limit, validates its query, and stays read-only", async () => {
    const { url, tag, audit } = await runtime("sqlite");
    expect((await tag(ADMIN, "first")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const between = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await tag(ADMIN, "second")).status).toBe(200);
    await expect(
      inboxClient({ url, token: SCOPED }).approve({ id: "missing" }),
    ).rejects.toMatchObject({ code: Code.NotFound });

    expect((await audit()).map((entry) => entry.target)).toEqual([
      "ApprovalRequest",
      "Tag/second",
      "Tag/first",
    ]);
    expect((await audit(ADMIN, { since: timestampFromDate(new Date(between)) })).length).toBe(2);
    expect(
      (await audit(ADMIN, { actor: "control-plane-break-glass" })).map((entry) => entry.target),
    ).toEqual(["Tag/second", "Tag/first"]);
    expect((await audit(ADMIN, { pageSize: 1 })).map((entry) => entry.target)).toEqual([
      "ApprovalRequest",
    ]);
    // Pages continue where the last ended.
    const first = await organizationClient({ url, token: ADMIN }).listAuditEntries({
      pageSize: 2,
    });
    expect(first.entries.map((entry) => entry.target)).toEqual(["ApprovalRequest", "Tag/second"]);
    // A change recorded between pages neither repeats nor shifts the next page.
    expect((await tag(ADMIN, "third")).status).toBe(200);
    const next = await organizationClient({ url, token: ADMIN }).listAuditEntries({
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(next.entries.map((entry) => entry.target)).toEqual(["Tag/first"]);
    expect(next.nextPageToken).toBe("");
    const list = (body: unknown, token?: string) =>
      fetch(`${url}/supertag.operator.v1.OrganizationService/ListAuditEntries`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    for (const body of [
      { pageSize: -1 },
      { pageSize: "ten" },
      { since: "yesterday" },
      { actor: "x".repeat(201) },
      { pageToken: "not-a-token" },
    ]) {
      const response = await list(body, ADMIN);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await list({})).status).toBe(401);
    // Scoped coordination credentials reach only the coordination API.
    expect((await list({}, SCOPED)).status).toBe(403);
    // Reading the audit trail adds nothing to it.
    expect(await audit()).toHaveLength(4);
  });

  it("supertag audit prints entries as text or JSON and validates its flags", async () => {
    const { url, tag } = await runtime("sqlite");
    expect((await tag(ADMIN, "cli")).status).toBe(200);
    const client = new ControlPlaneClient({ url, token: ADMIN });
    const text = await runAuditCommand(client, []);
    const [header, row] = text.trimEnd().split("\n");
    expect(header).toMatch(/^TIME\s+ACTOR\s+ACTION\s+TARGET\s+OUTCOME$/u);
    expect(row).toMatch(
      /control-plane-break-glass\s+resource\.apply\s+Tag\/cli\s+succeeded \(200\)$/u,
    );
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
        action: "resource.apply",
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
    const { url, remove, audit, store } = await runtime("sqlite", { sink: fileAuditSink(file) });
    const secret = await issueOperatorToken(url, ADMIN, "file-sink");
    expect((await remove(ADMIN, "missing")).status).toBe(404);
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
      action: "resource.delete",
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
    const { tag, audit } = await runtime("sqlite", {
      sink: fileAuditSink(missing, (error) => reported.push(error)),
    });
    expect((await tag(ADMIN, "kept")).status).toBe(200);
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
    const { tag, remove } = await runtime("sqlite", { sink: thrown("sink is full") });
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

    expect((await tag(ADMIN, "kept")).status).toBe(200);
    expect((await remove(ADMIN, "kept")).status).toBe(200);
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
    expect((await remove(ADMIN, "kept")).status).toBe(404);
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
  await store.enrollWorkerHost({
    id: "audited-host",
    credentialId: "credential/audited-host",
    enrolledAt: new Date().toISOString(),
  });
  await store.bindTagWorkerHost(owner.id, "audited-host");
  const team = await store.createTeam({
    id: "audited-team",
    name: "Export Team",
    memberTagIds: [owner.id],
    maxConcurrency: 1,
  });
  const objective = await store.createObjective({
    id: "audited",
    ownerTagId: owner.id,
    teamId: team.id,
    outcome: "Ship the export",
  });
  const { task } = await openTestTask(store as never, {
    tagId: owner.id,
    tagName: owner.name,
    objectiveId: objective.id,
    requestText: "Export the report",
  });
  return { owner, objective, team, task };
}

function createApproval(store: Store, fixture: Awaited<ReturnType<typeof objectiveFixture>>) {
  return store.createApprovalRequest({
    objectiveId: fixture.objective.id,
    taskId: fixture.task.id,
    requestingTagId: fixture.owner.id,
    kind: "surface-action",
    actions: [{ target: "runtime", action: "deploy" }],
    summary: "Deploy after merge",
    ruleSources: ["release"],
    approvers: [],
  });
}
