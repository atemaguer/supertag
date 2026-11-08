import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

interface TagSpec {
  readonly roles: readonly string[];
  readonly workerHosts: readonly string[];
  readonly locations: readonly Record<string, unknown>[];
  readonly acceptsMessagesFrom: readonly string[];
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

const role = `${header("Role", "Engineer")}spec:
  purpose: Ship reviewed changes.
  instructions: Keep changes small and tested.
  contextSets: [eng-guidelines]
  permissionSets: [eng-runtime]
`;

/** Tags first, so dependency ordering, not file order, must make this apply. */
const organization = `${header("Tag", "builder")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0BUILD
      permissionSets: [eng-runtime]
      contextSets: [eng-guidelines]
    - provider: lark
      chatId: oc_build
  acceptsMessagesFrom: [reviewer]
---
${header("Tag", "reviewer")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0REVIEW
      contextSets: [eng-guidelines]
  acceptsMessagesFrom: [builder]
---
${role}---
${sets}`;

describe("organization manifests", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-organization-manifest-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
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
  const tag = async (name: string) =>
    (await client.request<{ spec: TagSpec }>(`/api/v1/tags/${name}`)).spec;
  const exists = (path: string) =>
    client.request(path).then(
      () => true,
      () => false,
    );

  it("applies Tags listed before their Role, sets, and each other, then reports no drift", async () => {
    const path = await write("organization.yaml", organization);
    expect(await run("apply", "-f", path)).toBe(
      [
        "ContextSet/eng-guidelines configured",
        "PermissionSet/eng-runtime configured",
        "Role/Engineer configured",
        "Tag/builder configured",
        "Tag/reviewer configured",
        "",
      ].join("\n"),
    );
    expect(await tag("builder")).toEqual({
      roles: ["Engineer"],
      workerHosts: [],
      runsOn: [],
      locations: [
        { provider: "lark", account: "cli_org", chatId: "oc_build" },
        {
          provider: "slack",
          account: "T_ORG",
          channelId: "C0BUILD",
          permissionSets: ["eng-runtime"],
          contextSets: ["eng-guidelines"],
        },
      ],
      acceptsMessagesFrom: ["reviewer"],
    });
    expect((await tag("reviewer")).acceptsMessagesFrom).toEqual(["builder"]);

    expect(await run("diff", "-f", path)).toBe(
      "No changes. The Control Plane matches the input.\nPlan: 0 to create, 0 to update, 0 to delete, 0 conflicts.\n",
    );

    // Reapplying changes nothing.
    const before = await client.request<{ metadata: { resourceVersion: string } }>(
      "/api/v1/tags/builder",
    );
    await run("apply", "-f", path);
    const after = await client.request<{ metadata: { resourceVersion: string } }>(
      "/api/v1/tags/builder",
    );
    expect(after.metadata.resourceVersion).toBe(before.metadata.resourceVersion);
    expect(await run("diff", "-f", path)).toContain("No changes.");
  });

  it("reads every manifest file in a directory, in name order, without recursing", async () => {
    const input = join(directory, "organization");
    await mkdir(join(input, "nested"), { recursive: true });
    await writeFile(
      join(input, "00-sets.json"),
      JSON.stringify([
        {
          apiVersion: "supertag/v1",
          kind: "ContextSet",
          metadata: { name: "eng-guidelines" },
          spec: { items: [] },
        },
        {
          apiVersion: "supertag/v1",
          kind: "PermissionSet",
          metadata: { name: "eng-runtime" },
          spec: { permissions: [] },
        },
      ]),
    );
    await writeFile(join(input, "10-role.yml"), role);
    await writeFile(
      join(input, "20-tag.yaml"),
      `${header("Tag", "builder")}spec:\n  roles: [Engineer]\n`,
    );
    await writeFile(join(input, "README.md"), "not a manifest");
    await writeFile(join(input, "nested", "ignored.yaml"), "not: [valid");
    expect(await run("apply", "-f", input)).toBe(
      [
        "ContextSet/eng-guidelines configured",
        "PermissionSet/eng-runtime configured",
        "Role/Engineer configured",
        "Tag/builder configured",
        "",
      ].join("\n"),
    );
    expect(await run("diff", "-f", input)).toContain("No changes.");
  });

  it("validates every document before applying any of them", async () => {
    const path = await write(
      "invalid.yaml",
      `${sets}---
${header("Tag", "builder")}spec:
  roles: [Missing Role]
  locations:
    - provider: slack
      channelId: C0BUILD
      contextSets: [missing-context]
---
${header("Tag", "reviewer")}spec:
  acceptsMessagesFrom: [missing-sender]
`,
    );
    const failure = main(["apply", "-f", path]);
    await expect(failure).rejects.toThrow("Nothing was applied");
    await failure.catch((error: Error) => {
      expect(error.message).toContain("references Role Missing Role");
      expect(error.message).toContain("references Context Set missing-context");
      expect(error.message).toContain("references Tag missing-sender");
    });
    expect(await exists("/api/v1/context-sets/eng-guidelines")).toBe(false);
    expect(await exists("/api/v1/tags/builder")).toBe(false);

    // With a second Slack account, a location must select one.
    await client.setupSurface({
      provider: "slack",
      externalAccountId: "T_SECOND",
      displayName: "Second Slack",
      authMethod: "slack-bot-token",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-second", appToken: "xapp-second" },
    });
    const ambiguous = await write(
      "ambiguous.yaml",
      `${header("Tag", "builder")}spec:\n  locations:\n    - provider: slack\n      channelId: C0BUILD\n`,
    );
    await expect(main(["apply", "-f", ambiguous])).rejects.toThrow(
      "set account to one of: T_ORG, T_SECOND",
    );
    const scoped = await write(
      "scoped.yaml",
      `${header("Tag", "builder")}spec:\n  locations:\n    - provider: slack\n      account: T_SECOND\n      channelId: C0BUILD\n`,
    );
    await run("apply", "-f", scoped);
    expect((await tag("builder")).locations).toEqual([
      { provider: "slack", account: "T_SECOND", channelId: "C0BUILD" },
    ]);
    const wrongFields = await write(
      "wrong-fields.yaml",
      `${header("Tag", "builder")}spec:\n  locations:\n    - provider: slack\n      account: T_ORG\n      chatId: oc_x\n`,
    );
    await expect(main(["diff", "-f", wrongFields])).rejects.toThrow(
      "contains fields not used by slack: chatId",
    );
  });

  it("rejects the same kind and name defined twice", async () => {
    const path = await write("duplicate.yaml", `${sets}---\n${sets}`);
    await expect(main(["apply", "-f", path])).rejects.toThrow("define each resource once");
    expect(await exists("/api/v1/context-sets/eng-guidelines")).toBe(false);
  });

  it("stops at the first failed document and reports what was and was not applied", async () => {
    await run(
      "apply",
      "-f",
      await write(
        "holder.yaml",
        `${header("Tag", "holder")}spec:\n  locations:\n    - provider: slack\n      channelId: C0BUILD\n`,
      ),
    );
    const path = await write("organization.yaml", organization);
    const failure = main(["apply", "-f", path]);
    await expect(failure).rejects.toThrow("Tag/builder");
    await failure.catch((error: Error) => {
      expect(error.message).toContain("already routes to Tag holder");
      expect(error.message).toContain(
        "Applied: ContextSet/eng-guidelines, PermissionSet/eng-runtime, Role/Engineer",
      );
      expect(error.message).toContain("Not applied: Tag/builder, Tag/reviewer");
    });
    expect(await exists("/api/v1/roles/Engineer")).toBe(true);
    expect(await exists("/api/v1/tags/builder")).toBe(false);
  });

  it("removes locations, activations, and grants the manifest set and now omits", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));
    // The same Tag without locations or grants: apply set both, so both go.
    await run(
      "apply",
      "-f",
      await write("roles-only.yaml", `${header("Tag", "builder")}spec:\n  roles: [Engineer]\n`),
    );
    expect((await tag("builder")).locations).toEqual([]);
    expect((await tag("builder")).acceptsMessagesFrom).toEqual([]);
    expect((await tag("builder")).roles).toEqual(["Engineer"]);

    // A listed location keeps only the listed activations.
    await run("apply", "-f", await write("organization.yaml", organization));
    await run(
      "apply",
      "-f",
      await write(
        "one-location.yaml",
        `${header("Tag", "builder")}spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: c0build
      permissionSets: [eng-runtime]
`,
      ),
    );
    expect((await tag("builder")).locations).toEqual([
      {
        provider: "slack",
        account: "T_ORG",
        channelId: "C0BUILD",
        permissionSets: ["eng-runtime"],
      },
    ]);
    const contextSet = await client.request<{ status: { bindings: readonly string[] } }>(
      "/api/v1/context-sets/eng-guidelines",
    );
    expect(contextSet.status.bindings).toHaveLength(1); // reviewer's location only
  });

  it("merges Mailbox grants by sender Tag", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));
    await run("apply", "-f", await write("third.yaml", `${header("Tag", "planner")}spec: {}\n`));
    const replace = await write(
      "replace.yaml",
      `${header("Tag", "builder")}spec:
  roles: [Engineer]
  acceptsMessagesFrom: [planner]
`,
    );
    await run("apply", "-f", replace);
    expect((await tag("builder")).acceptsMessagesFrom).toEqual(["planner"]);
    // A grant made with the CLI belongs to cli and survives the next apply.
    await run("grant", "mailbox", "builder", "--sender", "reviewer");
    await run("apply", "-f", replace);
    expect([...(await tag("builder")).acceptsMessagesFrom].sort()).toEqual(["planner", "reviewer"]);
    // The reverse grant, where builder is the sender, is not builder's to manage.
    expect((await tag("reviewer")).acceptsMessagesFrom).toEqual(["builder"]);
  });

  it("exports apply-able YAML that diffs as unchanged", async () => {
    await run("apply", "-f", await write("organization.yaml", organization));
    const exported = [
      await run("get", "tag", "builder", "--output", "yaml"),
      await run("get", "role", "Engineer", "--output", "yaml"),
      await run("get", "permission-set", "eng-runtime", "--output", "yaml"),
      await run("get", "context-set", "eng-guidelines", "--output", "yaml"),
    ];
    expect(exported[0]).toContain("acceptsMessagesFrom:");
    expect(exported[0]).not.toContain("createdAt");
    const path = await write("exported.yaml", exported.join("---\n"));
    expect(await run("diff", "-f", path)).toContain("No changes.");

    // Listing exports every defined resource of a kind, skipping built-in Roles.
    const tags = await run("get", "tag", "--output", "yaml");
    const roles = await run("get", "role", "--output", "yaml");
    expect(roles.match(/^kind: Role$/gmu)).toHaveLength(1);
    const listPath = await write("tags.yaml", tags);
    expect(await run("diff", "-f", listPath)).toContain("No changes.");
    await expect(main(["get", "worker-host", "--output", "yaml"])).rejects.toThrow(
      "YAML manifests are available for",
    );
  });
});
