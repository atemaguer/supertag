import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.ts";

interface TagSpec {
  readonly roles: readonly string[];
  readonly workerHosts: readonly string[];
  readonly runsOn: readonly string[];
  readonly locations: readonly Record<string, unknown>[];
  readonly acceptsMessagesFrom: readonly { tag: string; types: readonly string[] }[];
}

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

const sets = `${header("ContextSet", "eng-guidelines")}spec:
  items:
    - itemKey: skill:review
      type: supertag/skill
      version: 1
      required: true
      config:
        reference: review-guidelines
---
${header("PermissionSet", "eng-runtime")}spec:
  permissions:
    - target: runtime
      action: commands:execute
`;

const role = (purpose = "Ship reviewed changes.") => `${header("Role", "Engineer")}spec:
  purpose: ${purpose}
  instructions: Keep changes small and tested.
  contextSets: [eng-guidelines]
  permissionSets: [eng-runtime]
`;

const builder = `${header("Tag", "builder")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0BUILD
      permissionSets: [eng-runtime]
    - provider: lark
      chatId: oc_build
`;

const reviewer = `${header("Tag", "reviewer")}spec:
  roles: [Engineer]
  acceptsMessagesFrom:
    - tag: builder
      types: [message]
`;

const organization = [sets, role(), builder, reviewer].join("---\n");

describe("field managers and apply sets", () => {
  let directory: string;
  let databasePath: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-field-managers-"));
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
    });
    output = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
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
    await client.setupSurface({
      provider: "lark",
      externalAccountId: "cli_org",
      displayName: "Org Lark",
      authMethod: "lark-app",
      configuration: { transport: "websocket" },
      secrets: { appId: "cli_org", appSecret: "secret" },
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
  const tag = async (name: string) =>
    (await client.request<{ spec: TagSpec }>(`/api/v1/tags/${name}`)).spec;
  const exists = (path: string) =>
    client.request(path).then(
      () => true,
      () => false,
    );
  /** Forgets field ownership, as for a resource created before field managers existed. */
  const forgetOwnership = async (kind: "Role" | "Tag", name: string) => {
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    try {
      await store.deleteResourceManagement(kind, name);
    } finally {
      await store.disconnect();
    }
  };

  it("keeps locations and hosts added with the CLI and removes what the manifest dropped", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));
    const hosts = await client.request<{ items: { metadata: { id: string } }[] }>(
      "/api/v1/worker-hosts",
    );
    const host = hosts.items[0]?.metadata.id ?? "missing";
    await run("update", "tag", "builder", "--add-worker-host", host);
    await run("update", "tag", "builder", "--add-location", "slack", "--channel-id", "C0CLI");

    // The manifest drops the Lark location it added; the CLI's location and host stay.
    const slackOnly = `${header("Tag", "builder")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0BUILD
      permissionSets: [eng-runtime]
`;
    const path = await write("builder.yaml", slackOnly);
    expect(await run("diff", "-f", path)).toBe(
      "~ Tag builder   spec.locations: - lark:oc_build\nPlan: 0 to create, 1 to update, 0 to delete, 0 conflicts.\n",
    );
    await run("apply", "-f", path);
    expect(await tag("builder")).toMatchObject({
      workerHosts: [host],
      locations: [
        {
          provider: "slack",
          account: "T_ORG",
          channelId: "C0BUILD",
          permissionSets: ["eng-runtime"],
        },
        { provider: "slack", account: "T_ORG", channelId: "C0CLI" },
      ],
    });

    // Declaring the CLI's location with the same value takes it over; dropping it then removes it.
    await run(
      "apply",
      "-f",
      await write(
        "adopt.yaml",
        `${slackOnly}    - provider: slack\n      channelId: C0CLI\n  workerHosts: [${host}]\n`,
      ),
    );
    await run("apply", "-f", path);
    expect(await tag("builder")).toMatchObject({
      workerHosts: [],
      locations: [{ channelId: "C0BUILD" }],
    });
  });

  it("merges runsOn labels by value, so a label another manager added survives apply", async () => {
    const labels = (runsOn: string) => `${header("Tag", "trainer")}spec:\n  runsOn: ${runsOn}\n`;
    await run("apply", "-f", await write("team-a.yaml", labels("[GPU, linux]")), "--set", "team-a");
    await run("apply", "-f", await write("team-b.yaml", labels("[macos]")), "--set", "team-b");
    expect((await tag("trainer")).runsOn).toEqual(["gpu", "linux", "macos"]);

    // Dropping a label removes only that manager's entry; the other set's label stays.
    const trimmed = await write("team-a-trimmed.yaml", labels("[gpu]"));
    expect(await run("diff", "-f", trimmed, "--set", "team-a")).toBe(
      "~ Tag trainer   spec.runsOn: - linux\nPlan: 0 to create, 1 to update, 0 to delete, 0 conflicts.\n",
    );
    await run("apply", "-f", trimmed, "--set", "team-a");
    expect((await tag("trainer")).runsOn).toEqual(["gpu", "macos"]);
    // Re-applying is a no-op, and a manifest without runsOn leaves the labels alone.
    expect(await run("diff", "-f", trimmed, "--set", "team-a")).toContain("No changes.");
    await run("apply", "-f", await write("bare.yaml", `${header("Tag", "trainer")}spec: {}\n`));
    expect((await tag("trainer")).runsOn).toEqual(["gpu", "macos"]);
  });

  it("refuses to change a field another manager owns until --force-conflicts", async () => {
    const path = await write("organization.yaml", organization);
    await run("apply", "-f", path);
    await run(
      "activate",
      "context-set",
      "eng-guidelines",
      "--tag",
      "builder",
      "--provider",
      "lark",
      "--chat-id",
      "oc_build",
    );

    expect(await run("diff", "-f", path)).toBe(
      "! Tag builder   spec.locations[lark:oc_build] owned by cli  (use --force-conflicts)\nPlan: 0 to create, 0 to update, 0 to delete, 1 conflict.\n",
    );
    const refused = await fail("apply", "-f", path);
    expect(refused).toContain("Nothing was applied");
    expect(refused).toContain("Tag/builder: spec.locations[lark:oc_build] is owned by cli");
    expect((await tag("builder")).locations).toContainEqual({
      provider: "lark",
      account: "cli_org",
      chatId: "oc_build",
      contextSets: ["eng-guidelines"],
    });

    expect(await run("diff", "-f", path, "--force-conflicts")).toBe(
      "~ Tag builder   spec.locations: ~ lark:oc_build\nPlan: 0 to create, 1 to update, 0 to delete, 0 conflicts.\n",
    );
    await run("apply", "-f", path, "--force-conflicts");
    expect((await tag("builder")).locations).toContainEqual({
      provider: "lark",
      account: "cli_org",
      chatId: "oc_build",
    });
    // Ownership moved to apply, so the next apply has nothing to resolve.
    expect(await run("diff", "-f", path)).toContain("No changes.");

    // Two sets that disagree about a Role conflict on the field, naming the owning set.
    await run("apply", "-f", path, "--set", "team-a");
    const other = await write("other.yaml", role("Ship quickly."));
    expect(await run("diff", "-f", other, "--set", "team-b")).toBe(
      "! Role Engineer   spec.purpose owned by team-a  (use --force-conflicts)\nPlan: 0 to create, 0 to update, 0 to delete, 1 conflict.\n",
    );
    // The same value is not a conflict: ownership simply moves.
    expect(await run("diff", "-f", await write("same.yaml", role()), "--set", "team-b")).toContain(
      "No changes.",
    );
  });

  it("adopts resources that predate field managers without deleting their fields", async () => {
    await run("apply", "-f", await write("sets.yaml", `${sets}---\n${role()}`));
    await run("create", "tag", "legacy");
    await run("update", "tag", "legacy", "--add-location", "slack", "--channel-id", "C0LEGACY");
    await forgetOwnership("Role", "Engineer");

    // Every stored field belongs to cli, so omitting one keeps it...
    await run(
      "apply",
      "-f",
      await write("legacy.yaml", `${header("Tag", "legacy")}spec:\n  roles: [Engineer]\n`),
    );
    expect((await tag("legacy")).locations).toEqual([
      { provider: "slack", account: "T_ORG", channelId: "C0LEGACY" },
    ]);
    const trimmedRole = `${header("Role", "Engineer")}spec:
  purpose: Ship reviewed changes.
  instructions: Keep changes small and tested.
  contextSets: []
  permissionSets: [eng-runtime]
`;
    await run("apply", "-f", await write("trimmed-role.yaml", trimmedRole));
    expect(
      (await client.request<{ spec: { contextSets: string[] } }>("/api/v1/roles/Engineer")).spec
        .contextSets,
    ).toEqual(["eng-guidelines"]);

    // ...and changing one conflicts.
    const changed = await write(
      "changed.yaml",
      `${header("Tag", "legacy")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0LEGACY
      permissionSets: [eng-runtime]
`,
    );
    expect(await fail("apply", "-f", changed)).toContain(
      "Tag/legacy: spec.locations[slack:C0LEGACY] is owned by cli",
    );

    // One forced apply adopts the fields; from then on, omitting them removes them.
    await run("apply", "-f", changed, "--force-conflicts");
    await run(
      "apply",
      "-f",
      await write("legacy.yaml", `${header("Tag", "legacy")}spec:\n  roles: [Engineer]\n`),
    );
    expect((await tag("legacy")).locations).toEqual([]);
  });

  it("records set membership and prunes only that set's missing members", async () => {
    expect(await fail("apply", "-f", await write("any.yaml", sets), "--prune")).toContain(
      "--prune requires --set NAME",
    );
    expect(await fail("apply", "-f", await write("any.yaml", sets), "--set", "apply")).toContain(
      "apply is a built-in field manager",
    );

    await run("apply", "-f", await write("team-a.yaml", organization), "--set", "team-a");
    await run(
      "apply",
      "-f",
      await write("team-b.yaml", `${header("Tag", "planner")}spec: {}\n`),
      "--set",
      "team-b",
    );

    // Dropping reviewer from team-a's input deletes reviewer only; team-b's planner stays.
    const withoutReviewer = await write("team-a-next.yaml", [sets, role(), builder].join("---\n"));
    expect(await run("diff", "-f", withoutReviewer, "--set", "team-a", "--prune")).toBe(
      "- Tag reviewer\nPlan: 0 to create, 0 to update, 1 to delete, 0 conflicts.\n",
    );
    expect(await exists("/api/v1/tags/reviewer")).toBe(true);
    expect(await run("apply", "-f", withoutReviewer, "--set", "team-a", "--prune")).toContain(
      "Tag/reviewer deleted\n",
    );
    // Deleting a Tag retires it; its name stays readable until a new Tag takes it.
    expect(
      (await client.request<{ status: { phase: string } }>("/api/v1/tags/reviewer")).status.phase,
    ).toBe("retired");
    expect(await exists("/api/v1/tags/planner")).toBe(true);

    // A member still in use stays in the set and is reported, not deleted.
    const tagsOnly = await write("team-a-tags.yaml", builder);
    expect(await run("apply", "-f", tagsOnly, "--set", "team-a", "--prune")).toBe(
      [
        "Tag/builder configured",
        "Role/Engineer not deleted: is in use by Tag builder",
        "PermissionSet/eng-runtime not deleted: is in use by Role Engineer and Tag builder (location slack:C0BUILD)",
        "ContextSet/eng-guidelines not deleted: is in use by Role Engineer",
        "",
      ].join("\n"),
    );
    expect(await exists("/api/v1/roles/Engineer")).toBe(true);

    // Once builder no longer uses them, the next prune deletes them in reverse apply order.
    const bare = await write("team-a-bare.yaml", `${header("Tag", "builder")}spec: {}\n`);
    expect(await run("apply", "-f", bare, "--set", "team-a", "--prune")).toBe(
      [
        "Tag/builder configured",
        "Role/Engineer deleted",
        "PermissionSet/eng-runtime deleted",
        "ContextSet/eng-guidelines deleted",
        "",
      ].join("\n"),
    );
    const retired = await client.request<{ status: { phase: string } }>("/api/v1/roles/Engineer");
    expect(retired.status.phase).toBe("retired");
    expect(await exists("/api/v1/permission-sets/eng-runtime")).toBe(false);
    expect(await exists("/api/v1/context-sets/eng-guidelines")).toBe(false);
    expect(await exists("/api/v1/tags/planner")).toBe(true);
  });

  it("prints a plan with creates, updates, deletes, and conflicts", async () => {
    await run("apply", "-f", await write("team.yaml", organization), "--set", "team");
    await run(
      "activate",
      "context-set",
      "eng-guidelines",
      "--tag",
      "builder",
      "--provider",
      "lark",
      "--chat-id",
      "oc_build",
    );
    const next = await write(
      "next.yaml",
      [
        sets,
        role("Ship small changes."),
        builder,
        `${header("Tag", "ios-dev")}spec:\n  roles: [Engineer]\n`,
      ].join("---\n"),
    );
    expect(await run("diff", "-f", next, "--set", "team", "--prune")).toBe(
      [
        '~ Role Engineer   spec.purpose: "Ship reviewed changes." -> "Ship small changes."',
        "! Tag builder     spec.locations[lark:oc_build] owned by cli  (use --force-conflicts)",
        "+ Tag ios-dev",
        "- Tag reviewer",
        "Plan: 1 to create, 1 to update, 1 to delete, 1 conflict.",
        "",
      ].join("\n"),
    );
    // A plan changes nothing.
    expect(await exists("/api/v1/tags/ios-dev")).toBe(false);
    expect(await exists("/api/v1/tags/reviewer")).toBe(true);
  });

  it("answers a server dry run with the merged spec and plan, without writing", async () => {
    const planned = await client.request<{
      spec: TagSpec;
      plan: { action: string; changes: { path: string; action: string }[] };
    }>("/api/v1/tags?dryRun=true", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "dry" },
        spec: { locations: [{ provider: "slack", channelId: "C0DRY" }] },
      }),
    });
    expect(planned.plan.action).toBe("create");
    expect(planned.plan.changes).toEqual([
      expect.objectContaining({ path: "spec.locations[slack:C0DRY]", action: "add" }),
    ]);
    expect(planned.spec).toEqual({
      roles: [],
      workerHosts: [],
      runsOn: [],
      locations: [{ provider: "slack", account: "T_ORG", channelId: "C0DRY" }],
      acceptsMessagesFrom: [],
    });
    expect(await exists("/api/v1/tags/dry")).toBe(false);
  });
});
