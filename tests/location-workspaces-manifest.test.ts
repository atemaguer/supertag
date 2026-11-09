import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.ts";
import { applyManifests, getResource } from "./support/resources.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

const workspaces = `${header("Workspace", "app")}spec:
  source: https://github.com/acme/app.git
---
${header("Workspace", "docs")}spec:
  delivery: patch
`;

const lead = (location: string) => `${header("Tag", "lead")}spec:
  locations:
    - provider: slack
      channelId: C0LEAD
${location}`;

describe("Workspaces on Tag locations", () => {
  let directory: string;
  let databasePath: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-location-workspaces-"));
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
  const locations = async () => (await getResource(client, "tags", "lead")).spec.locations;

  it("applies, stores in order, exports, and describes a location's Workspaces", async () => {
    const path = await write(
      "org.yaml",
      `${workspaces}---\n${lead("      workspaces: [docs, app]\n")}`,
    );
    await run("apply", "-f", path);
    expect(await locations()).toEqual([
      { provider: "slack", account: "T_ORG", channelId: "C0LEAD", workspaces: ["docs", "app"] },
    ]);
    expect(await run("get", "tag", "lead", "--output", "yaml")).toContain(
      "workspaces:\n        - docs\n        - app",
    );
    expect(await run("describe", "tag", "lead")).toContain(
      "slack channelId C0LEAD: Objectives created here name Workspaces docs, app",
    );
    expect(await run("diff", "-f", path)).toContain("No changes.");

    const store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    try {
      const referencing = await store.listLocationsReferencingWorkspace("app");
      expect(referencing.map((route) => [route.scope, route.workspaces])).toEqual([
        ["channel:C0LEAD", ["docs", "app"]],
      ]);
    } finally {
      await store.disconnect();
    }

    // Dropping the field clears the location's Workspaces.
    const bare = await write("bare.yaml", lead(""));
    expect(await run("diff", "-f", bare)).toContain("spec.locations: ~ slack:C0LEAD");
    await run("apply", "-f", bare);
    expect(await locations()).toEqual([
      { provider: "slack", account: "T_ORG", channelId: "C0LEAD" },
    ]);
    expect(await run("describe", "tag", "lead")).toContain(
      "Objectives created here name no Workspace",
    );
  });

  it("applies a Workspace's MCP servers, Skills, and Skill catalog", async () => {
    const selected = `${header("Workspace", "app")}spec:
  mcp: [sentry]
  skills: [docs-conventions]
  skillCatalog:
    repository: acme/agent-skills
    path: catalog
    revision: main
    skills: [review]
`;
    const path = await write("selected.yaml", selected);
    await run("apply", "-f", path);
    expect((await getResource(client, "workspaces", "app")).spec).toMatchObject({
      mcp: ["sentry"],
      skills: ["docs-conventions"],
      skillCatalog: {
        repository: "acme/agent-skills",
        path: "catalog",
        revision: "main",
        skills: ["review"],
      },
    });
    expect(await run("diff", "-f", path)).toContain("No changes");

    await run(
      "apply",
      "-f",
      await write("fewer.yaml", `${header("Workspace", "app")}spec:\n  skills: [testing]\n`),
    );
    const spec = (await getResource(client, "workspaces", "app")).spec;
    expect(spec.skills).toEqual(["testing"]);
    expect(spec.mcp).toBeUndefined();
    expect(spec.skillCatalog).toBeUndefined();
  });

  it("rejects Workspaces that do not exist, before and at the API", async () => {
    await run("apply", "-f", await write("workspaces.yaml", workspaces));
    const refused = await fail(
      "apply",
      "-f",
      await write("ghost.yaml", lead("      workspaces: [ghost]\n")),
    );
    expect(refused).toContain("Nothing was applied");
    expect(refused).toContain("references Workspace ghost");

    await expect(
      applyManifests(
        client,
        [
          {
            apiVersion: "supertag/v1",
            kind: "Tag",
            metadata: { name: "lead" },
            spec: {
              locations: [{ provider: "slack", channelId: "C0LEAD", workspaces: ["app", "ghost"] }],
            },
          },
        ],
        { imperative: true },
      ),
    ).rejects.toThrow("spec.locations[0].workspaces: Workspace ghost does not exist");
    await expect(
      applyManifests(
        client,
        [
          {
            apiVersion: "supertag/v1",
            kind: "Tag",
            metadata: { name: "lead" },
            spec: {
              locations: [{ provider: "slack", channelId: "C0LEAD", workspaces: ["app", "app"] }],
            },
          },
        ],
        { imperative: true },
      ),
    ).rejects.toThrow("must not contain duplicates");
    await expect(getResource(client, "tags", "lead")).rejects.toThrow();
  });

  it("treats Workspaces as part of the location's value for field ownership", async () => {
    await run("apply", "-f", await write("workspaces.yaml", workspaces));
    await run("create", "tag", "lead");
    await run("update", "tag", "lead", "--add-location", "slack", "--channel-id", "C0LEAD");

    // The CLI owns the location; a manifest that changes its value conflicts.
    const path = await write("lead.yaml", lead("      workspaces: [app]\n"));
    expect(await run("diff", "-f", path)).toBe(
      "! Tag lead   spec.locations[slack:C0LEAD] owned by cli  (use --force-conflicts)\nPlan: 0 to create, 0 to update, 0 to delete, 1 conflict.\n",
    );
    expect(await fail("apply", "-f", path)).toContain(
      "Tag/lead: spec.locations[slack:C0LEAD] is owned by cli",
    );
    await run("apply", "-f", path, "--force-conflicts");
    expect(await locations()).toEqual([
      { provider: "slack", account: "T_ORG", channelId: "C0LEAD", workspaces: ["app"] },
    ]);

    // Another set's location merges by key and keeps this location's Workspaces.
    await run(
      "apply",
      "-f",
      await write(
        "other.yaml",
        `${header("Tag", "lead")}spec:\n  locations:\n    - provider: slack\n      channelId: C0OTHER\n      workspaces: [docs]\n`,
      ),
      "--set",
      "other",
    );
    expect(await locations()).toEqual([
      { provider: "slack", account: "T_ORG", channelId: "C0LEAD", workspaces: ["app"] },
      { provider: "slack", account: "T_ORG", channelId: "C0OTHER", workspaces: ["docs"] },
    ]);
    // A set that declares the same location with different Workspaces conflicts with its owner.
    expect(
      await run(
        "diff",
        "-f",
        await write("steal.yaml", lead("      workspaces: [docs]\n")),
        "--set",
        "other",
      ),
    ).toContain("! Tag lead   spec.locations[slack:C0LEAD] owned by apply");
  });
});
