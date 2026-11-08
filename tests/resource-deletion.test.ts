import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { surfaceTools } from "../apps/cli/src/coordination-http.ts";
import { main } from "../apps/cli/src/index.ts";
import { artifactVolumeLabel } from "../packages/core/src/index.js";
import { DrizzleStore } from "../packages/store/src/index.js";
import { artifactProducer } from "./support/artifact-producer.js";
import { migrateSqlite } from "./support/database.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

const organization = `${header("Workspace", "api")}spec:
  delivery: branch
---
${header("ContextSet", "guides")}spec:
  items:
    - itemKey: skill:review
      type: supertag/skill
      version: 1
      required: true
      config:
        reference: review-guidelines
---
${header("PermissionSet", "deploy")}spec:
  permissions:
    - target: runtime
      action: commands:execute
---
${header("Role", "Engineer")}spec:
  purpose: Ship reviewed changes.
  instructions: Keep changes small.
  contextSets: [guides]
  permissionSets: [deploy]
---
${header("Tag", "release")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C01
      permissionSets: [deploy]
      contextSets: [guides]
  acceptsMessagesFrom: [lead]
---
${header("Tag", "lead")}spec:
  locations:
    - provider: slack
      channelId: C02
      permissionSets: [deploy]
`;

const HOST = "control-plane-static-host";

describe("supertag delete", () => {
  let directory: string;
  let databasePath: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-delete-"));
    const serverState = join(directory, "server");
    databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
      coordinationOperatorCredentials: [
        { token: "coordination-only", operatorId: "coordinator", actions: ["*"] },
      ],
    });
    output = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
    await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    client = new ControlPlaneClient({ url: runtime.url, token });
    await client.setupSurface({
      provider: "slack",
      externalAccountId: "T_ORG",
      displayName: "Org Slack",
      authMethod: "slack-bot-token",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
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
  const exists = (path: string) =>
    client.request(path).then(
      () => true,
      () => false,
    );
  const phase = async (path: string) =>
    (await client.request<{ status: { phase: string } }>(path)).status.phase;

  it("reports artifact Volume conflicts in apply, delete dry runs, and prune plans", async () => {
    const manifest = `${header("Volume", "artifacts")}spec:\n  source: file:///srv/artifacts\n  credential: artifacts\n`;
    await run("apply", "-f", await write("volume.yaml", manifest), "--set", "artifacts");
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    try {
      const volume = await store.findVolumeByName("artifacts");
      if (!volume) throw new Error("Missing test Volume");
      const at = new Date().toISOString();
      await store.enrollWorkerHost({
        id: "producer",
        credentialId: "producer-key",
        enrolledAt: at,
      });
      await store.claimWorkerHostConnection({
        workerHostId: "producer",
        credentialRevision: 1,
        workletId: "producer-worklet",
        protocolVersion: 17,
        workerSnapshot: { labels: [artifactVolumeLabel("artifacts")] },
        capacity: 1,
        availableSlots: 1,
        activeAttempts: 0,
        ready: true,
        observedAt: at,
      });
      const attempt = await artifactProducer(store, "producer");
      await store.recordArtifactVolumeCopy({
        volumeId: volume.id,
        source: volume.source,
        workerHostId: "producer",
        key: `attempts/${attempt.id}/sha256/${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 1,
        observedAt: at,
      });
      const response = await fetch(`${runtime.url}/api/v1/volumes?applySet=artifacts`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-administrative-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Volume",
          metadata: { name: "artifacts" },
          spec: { source: "file:///srv/replacement", credential: "artifacts" },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        reason: "Conflict",
        message: expect.stringContaining("1 artifact copies"),
      });
      for (const suffix of ["?dryRun=true", ""]) {
        const deletion = await fetch(`${runtime.url}/api/v1/volumes/artifacts${suffix}`, {
          method: "DELETE",
          headers: { authorization: "Bearer test-administrative-token" },
        });
        expect(deletion.status).toBe(409);
        expect(await deletion.json()).toMatchObject({
          message: expect.stringContaining("1 artifact copies"),
        });
      }
      expect(await fail("delete", "volume", "artifacts", "--dry-run")).toContain(
        "1 artifact copies",
      );
      for (const suffix of ["?dryRun=true", ""]) {
        const plan = await client.request<{ items: { action: string; reason: string }[] }>(
          `/api/v1/apply-sets/artifacts/prune${suffix}`,
          { method: "POST", body: JSON.stringify({ keep: [] }) },
        );
        expect(plan.items).toEqual([
          {
            kind: "Volume",
            name: "artifacts",
            action: "skip",
            reason: expect.stringContaining("1 artifact copies"),
          },
        ]);
        expect(plan.items[0]?.reason).not.toContain("could not be deleted");
      }
      await store.revokeWorkerHost({ workerHostId: "producer", revokedAt: at });
      expect(await run("delete", "volume", "artifacts", "--dry-run")).toContain("artifacts");
      expect(await store.findVolumeByName("artifacts")).toBeDefined();
      await run("delete", "volume", "artifacts");
      expect(await store.findVolumeByName("artifacts")).toBeUndefined();
    } finally {
      await store.disconnect();
    }
  });

  it("refuses sets and Roles in use, listing every reference, then deletes them", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));

    const refusal =
      "permission-set deploy is in use by Role Engineer, Tag lead (location slack:C02), and Tag release (location slack:C01).";
    expect(await fail("delete", "permission-set", "deploy")).toBe(refusal);
    // A dry run gives the same answer and changes nothing.
    expect(await fail("delete", "permission-set", "deploy", "--dry-run")).toBe(refusal);
    expect(await fail("delete", "context-set", "guides")).toBe(
      "context-set guides is in use by Role Engineer and Tag release (location slack:C01).",
    );
    expect(await fail("delete", "role", "Engineer")).toBe(
      "role Engineer is in use by Tag release.",
    );
    // The API reports the same refusal with the references as data.
    await expect(
      client.request("/api/v1/permission-sets/deploy", { method: "DELETE" }),
    ).rejects.toMatchObject({ status: 409 });
    const response = await fetch(`${runtime.url}/api/v1/roles/Engineer`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-administrative-token" },
    });
    expect(await response.json()).toMatchObject({
      kind: "Status",
      reason: "Conflict",
      details: { references: ["Tag release"] },
    });
    // Every Role is declared; there are no built-in Roles to protect.
    const roles = await client.request<{ items: { metadata: { name: string } }[] }>(
      "/api/v1/roles",
    );
    expect(roles.items.map((role) => role.metadata.name)).toEqual(["Engineer"]);
    expect(await fail("delete", "role", "Nobody")).toBe("Role Nobody does not exist");

    // Drop the references; the Role then retires, and its sets delete.
    await run("update", "tag", "release", "--remove-location", "slack", "--channel-id", "C01");
    await run("update", "tag", "lead", "--remove-location", "slack", "--channel-id", "C02");
    await run(
      "apply",
      "-f",
      await write("release.yaml", `${header("Tag", "release")}spec:\n  roles: []\n`),
    );
    expect(await run("delete", "role", "Engineer", "--dry-run")).toBe(
      [
        "Dry run: Role Engineer would be retired. Nothing was changed.",
        "Would remove with it:",
        "  reference to Context Set guides",
        "  reference to Permission Set deploy",
        "",
      ].join("\n"),
    );
    expect(await phase("/api/v1/roles/Engineer")).toBe("active");
    expect(await run("delete", "role", "Engineer")).toContain(
      "Role Engineer retired. Its history is kept.",
    );
    expect(await phase("/api/v1/roles/Engineer")).toBe("retired");
    expect(await run("delete", "permission-set", "deploy")).toBe(
      "Permission Set deploy deleted.\nRemoved with it:\n  its 1 permission\n",
    );
    expect(await run("delete", "context-set", "guides")).toContain("Context Set guides deleted.");
    expect(await exists("/api/v1/permission-sets/deploy")).toBe(false);
    expect(await exists("/api/v1/context-sets/guides")).toBe(false);
  });

  it("refuses a Workspace an open Objective names and deletes it once the Objective closes", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));
    await run(
      "create",
      "objective",
      "ship-api",
      "--outcome",
      "Ship the API",
      "--owner",
      "lead",
      "--workspace",
      "api",
    );
    expect(await fail("delete", "workspace", "api")).toBe(
      "workspace api is in use by Objective ship-api (working).",
    );
    await run("cancel", "objective", "ship-api");
    expect(await run("delete", "workspace", "api", "--dry-run")).toBe(
      "Dry run: Workspace api would be deleted. Nothing was changed.\n",
    );
    expect(await exists("/api/v1/workspaces/api")).toBe(true);
    expect(await run("delete", "workspace", "api")).toBe("Workspace api deleted.\n");
    expect(await exists("/api/v1/workspaces/api")).toBe(false);
  });

  it("refuses a Workspace a Tag location names", async () => {
    await run(
      "apply",
      "-f",
      await write(
        "organization.yaml",
        organization.replace(
          "      channelId: C02\n      permissionSets: [deploy]\n",
          "      channelId: C02\n      permissionSets: [deploy]\n      workspaces: [api]\n",
        ),
      ),
    );
    expect(await fail("delete", "workspace", "api")).toBe(
      "workspace api is in use by Tag lead (location slack:C02).",
    );
    expect(await exists("/api/v1/workspaces/api")).toBe(true);
  });

  it("retires a Tag: refuses while it has open work, then keeps history and frees the name", async () => {
    await run("apply", "-f", await write("organization.yaml", organization), "--set", "team");
    await run("update", "tag", "release", "--add-worker-host", HOST);
    await run("create", "objective", "launch", "--outcome", "Launch", "--owner", "release");
    await run(
      "create",
      "team",
      "launchers",
      "--member",
      "release",
      "--member",
      "lead",
      "--max-concurrency",
      "1",
    );

    const refused = await fail("delete", "tag", "lead");
    expect(refused).toBe("tag lead is in use by Team launchers (member).");
    const owner = await fail("delete", "tag", "release", "--dry-run");
    expect(owner).toContain("tag release is in use by Objective launch (owner)");
    expect(owner).toContain("Team launchers (member)");

    await run("cancel", "objective", "launch");
    // A Team outlives the Objectives that name it, so its membership is dropped explicitly.
    await run("update", "team", "launchers", "--member", "lead");
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    try {
      const release = await store.findTagByName("release");
      if (!release) throw new Error("expected Tag release");
      const history = await store.listTasks({ tagId: release.id });

      expect(await run("delete", "tag", "release", "--dry-run")).toBe(
        [
          "Dry run: Tag release would be retired. Nothing was changed.",
          "Would remove with it:",
          "  location slack:C01 with Permission Set deploy and Context Set guides",
          `  Worker Host ${HOST} binding`,
          "  Role Engineer assignment",
          "  Mailbox grant from Tag lead",
          "  membership in apply set team",
          "",
        ].join("\n"),
      );
      expect(await phase("/api/v1/tags/release")).toBe("active");

      expect(await run("delete", "tag", "release")).toContain(
        "Tag release retired. Its history is kept.",
      );
      // Hidden from lists, still readable by name, with its history intact.
      const listed = JSON.parse(await run("list", "tag", "--output", "json")) as {
        items: { metadata: { name: string } }[];
      };
      expect(listed.items.map((item) => item.metadata.name)).toEqual(["lead"]);
      const retired = await client.request<{
        metadata: { id: string };
        spec: Record<string, unknown[]>;
        status: { phase: string; retiredAt?: string };
      }>("/api/v1/tags/release");
      expect(retired.metadata.id).toBe(release.id);
      expect(retired.status).toMatchObject({ phase: "retired", retiredAt: expect.any(String) });
      expect(retired.spec).toMatchObject({
        roles: [],
        workerHosts: [],
        locations: [],
        acceptsMessagesFrom: [],
      });
      expect(await run("describe", "tag", "release")).toContain("Phase: retired");
      expect(await store.listTasks({ tagId: release.id })).toEqual(history);
      expect(await store.getObjective("launch")).toMatchObject({ ownerTagId: release.id });
      expect(await store.findResourceManagement("Tag", "release")).toBeUndefined();

      // Nothing can reach it: no binding, no second delete, no new Objective.
      expect(await fail("update", "tag", "release", "--add-worker-host", HOST)).toContain(
        "does not exist",
      );
      expect(await fail("delete", "tag", "release")).toBe("Tag release does not exist");
      expect(
        await fail("create", "objective", "again", "--outcome", "Again", "--owner", "release"),
      ).toBeTruthy();

      // The name is free again: a new Tag with a new id.
      expect(await run("create", "tag", "release")).toContain("Created Tag release");
      const successor = await store.findTagByName("release");
      expect(successor?.id).not.toBe(release.id);
      expect(await phase("/api/v1/tags/release")).toBe("active");
      // The old Tasks still name the retired Tag, not its successor.
      expect(await store.findTagById(release.id)).toMatchObject({ status: "retired" });
    } finally {
      await store.disconnect();
    }
  });

  it("refuses a Tag that a Permission Set names as an approver", async () => {
    await run("create", "tag", "approver");
    await run(
      "apply",
      "-f",
      await write(
        "gate.yaml",
        `${header("PermissionSet", "gate")}spec:\n  approvers: [tag:approver]\n  permissions:\n    - target: runtime\n      action: commands:execute\n`,
      ),
    );
    // A new Tag reusing the name would otherwise inherit the approval.
    expect(await fail("delete", "tag", "approver")).toBe(
      "tag approver is in use by Permission Set gate (approver).",
    );
  });

  it("prunes Workspaces through the same protection", async () => {
    await run(
      "apply",
      "-f",
      await write("workspace.yaml", header("Workspace", "api")),
      "--set",
      "ws",
    );
    await run("create", "tag", "owner");
    await run(
      "create",
      "objective",
      "uses-api",
      "--outcome",
      "Use the API",
      "--owner",
      "owner",
      "--workspace",
      "api",
    );
    const empty = await write("other.yaml", header("Workspace", "web"));
    expect(await run("diff", "-f", empty, "--set", "ws", "--prune")).toContain(
      "= Workspace api   not deleted: is in use by Objective uses-api (working)",
    );
    await run("cancel", "objective", "uses-api");
    expect(await run("diff", "-f", empty, "--set", "ws", "--prune")).toContain("- Workspace api");
    expect(await run("apply", "-f", empty, "--set", "ws", "--prune")).toContain(
      "Workspace/api deleted\n",
    );
    expect(await exists("/api/v1/workspaces/api")).toBe(false);
  });

  it("rejects unsupported kinds and keeps deletion away from AI actors", async () => {
    expect(await fail("delete", "task", "anything")).toContain("task cannot be deleted");
    expect(await fail("delete", "tag")).toContain("Usage: supertag delete");
    // Coordination credentials, even with every action, cannot use administrative routes.
    const response = await fetch(`${runtime.url}/api/v1/workspaces/api`, {
      method: "DELETE",
      headers: { authorization: "Bearer coordination-only" },
    });
    expect(response.status).toBe(403);
    // No coordination tool deletes or retires anything.
    expect(surfaceTools.map((tool) => tool.name)).not.toContainEqual(
      expect.stringMatching(/delete|retire|remove|prune/u),
    );
  });
});
