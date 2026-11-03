import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

/** The Tag comes first, so dependency ordering, not file order, applies the Workspace first. */
const organization = `${header("Tag", "builder")}spec:
  roles: []
---
${header("Workspace", "app")}spec:
  ref: main
  setup: pnpm install --frozen-lockfile
  delivery: patch
---
${header("Workspace", "docs")}`;

describe("Workspace manifests", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-workspace-manifest-"));
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

  it("applies Workspaces before Tags, round-trips through get and diff, and lists them", async () => {
    const path = await write("organization.yaml", organization);
    expect(await run("apply", "-f", path)).toBe(
      ["Workspace/app configured", "Workspace/docs configured", "Tag/builder configured", ""].join(
        "\n",
      ),
    );
    const app = await client.request<{ spec: Record<string, unknown>; status: unknown }>(
      "/api/v1/workspaces/app",
    );
    expect(app.spec).toEqual({
      ref: "main",
      setup: "pnpm install --frozen-lockfile",
      delivery: "patch",
    });
    // Getting one Workspace also lists the hosts that serve it by environment provider.
    expect(app.status).toEqual({ phase: "active", workerHosts: [], environments: [] });
    // An empty spec takes every default.
    expect((await client.request<{ spec: unknown }>("/api/v1/workspaces/docs")).spec).toEqual({
      delivery: "branch",
    });

    expect(await run("diff", "-f", path)).toBe(
      "No changes. The Control Plane matches the input.\nPlan: 0 to create, 0 to update, 0 to delete, 0 conflicts.\n",
    );

    const exported = await run("get", "workspace", "app", "--output", "yaml");
    expect(exported).toBe(
      [
        "apiVersion: supertag/v1",
        "kind: Workspace",
        "metadata:",
        "  name: app",
        "spec:",
        "  ref: main",
        "  setup: pnpm install --frozen-lockfile",
        "  delivery: patch",
        "",
      ].join("\n"),
    );
    const exportPath = await write("exported.yaml", exported);
    expect(await run("diff", "-f", exportPath)).toContain("No changes.");

    const listed = JSON.parse(await run("list", "workspace", "--output", "json")) as {
      items: { metadata: { name: string } }[];
    };
    expect(listed.items.map((item) => item.metadata.name)).toEqual(["app", "docs"]);

    const described = await run("describe", "workspace", "app");
    expect(described).toContain("Workspace: app");
    expect(described).toContain("Delivery: patch");
    expect(described).toContain("Worker Hosts with a checkout: none");
    expect(described).toContain("supertag connect worklet --workspace app=PATH");
  });

  it("resets a field the manifest set and now omits to its default", async () => {
    await run(
      "apply",
      "-f",
      await write("app.yaml", `${header("Workspace", "app")}spec:\n  setup: make\n`),
    );
    const trimmed = await write("trimmed.yaml", header("Workspace", "app"));
    expect(await run("diff", "-f", trimmed)).toBe(
      "~ Workspace app   spec.setup: - make\nPlan: 0 to create, 1 to update, 0 to delete, 0 conflicts.\n",
    );
    await run("apply", "-f", trimmed);
    expect((await client.request<{ spec: unknown }>("/api/v1/workspaces/app")).spec).toEqual({
      delivery: "branch",
    });
  });

  it("applies and describes operator-declared Workspace mounts", async () => {
    const path = await write(
      "mounted.yaml",
      `${header("Workspace", "app")}spec:\n  source: https://github.com/acme/app.git\n  mounts:\n    - volume: datasets\n      path: /mnt/datasets\n      maxBytes: 1024\n`,
    );
    await run("apply", "-f", path);
    const app = await client.request<{ spec: Record<string, unknown> }>("/api/v1/workspaces/app");
    expect(app.spec["mounts"]).toEqual([
      {
        volume: "datasets",
        path: "/mnt/datasets",
        access: "read-only",
        strategy: "copy",
        maxBytes: 1024,
      },
    ]);
    expect(await run("describe", "workspace", "app")).toContain(
      "datasets at /mnt/datasets (read-only, copy, maxBytes 1024)",
    );
  });

  it("rejects pull-request delivery without a GitHub source and invalid fields before applying anything", async () => {
    const path = await write(
      "invalid.yaml",
      `${header("Workspace", "app")}spec:\n  delivery: pull-request\n---\n${header("Workspace", "web")}spec:\n  source: https://user:secret@example.com/acme/web.git\n---\n${header("Workspace", "Bad Name")}---\n${header("Workspace", "lab")}spec:\n  source: https://gitlab.example.com/acme/lab.git\n  delivery: pull-request\n`,
    );
    const errors = await fail("apply", "-f", path);
    expect(errors).toContain("Nothing was applied");
    expect(errors).toContain("pull-request needs spec.source naming a GitHub repository");
    expect(errors).toContain(
      "pull-request supports only GitHub sources such as https://github.com/OWNER/REPO",
    );
    expect(errors).toContain("https://gitlab.example.com/acme/lab.git is not one");
    expect(errors).toContain("must not embed credentials");
    expect(errors).toContain("Workspace metadata.name must be 1-63 lowercase");
    await expect(client.request("/api/v1/workspaces/app")).rejects.toThrow("does not exist");
  });

  it("accepts a git source and names Workspaces on Objectives, rejecting unknown names", async () => {
    await run(
      "apply",
      "-f",
      await write(
        "app.yaml",
        `${header("Workspace", "app")}spec:\n  source: git@github.com:acme/app.git\n`,
      ),
    );
    await client.request("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "owner" },
        spec: { roles: [] },
      }),
    });
    const created = JSON.parse(
      await run(
        "create",
        "objective",
        "ship-app",
        "--outcome",
        "Ship the app.",
        "--owner",
        "owner",
        "--workspace",
        "app",
        "--output",
        "json",
      ),
    ) as { workspaces: string[] };
    expect(created.workspaces).toEqual(["app"]);
    const errors = await fail(
      "create",
      "objective",
      "ship-web",
      "--outcome",
      "Ship the web.",
      "--owner",
      "owner",
      "--workspace",
      "web",
    );
    expect(errors).toContain("Workspace web does not exist");
  });
});
