import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { enrollWorkerHost } from "./support/worker-host-enrollment.ts";

// The CLI owns the YAML dependency; read manifests with the same parser apply uses.
const { parseAllDocuments } = createRequire(new URL("../apps/cli/package.json", import.meta.url))(
  "yaml",
) as typeof import("yaml");
/** The Worker Host IDs the examples use as placeholders for the reader's own hosts. */
const placeholderHosts = ["my-laptop", "my-laptop-verify"];
const examples = fileURLToPath(new URL("../examples/organizations/", import.meta.url));
const paths: Record<string, string> = {
  PermissionSet: "permission-sets",
  Workspace: "workspaces",
  Role: "roles",
  Tag: "tags",
};

/** A manifest spec as the Control Plane stores it: execution models and efforts are lists. */
function normalized(spec: Record<string, unknown>): Record<string, unknown> {
  const execution = spec["execution"];
  if (typeof execution !== "object" || execution === null) return spec;
  const list = (value: unknown) => (typeof value === "string" ? [value] : value);
  const { model, effort, ...rest } = execution as Record<string, unknown>;
  return {
    ...spec,
    execution: {
      ...rest,
      ...(model === undefined ? {} : { model: list(model) }),
      ...(effort === undefined ? {} : { effort: list(effort) }),
    },
  };
}

const names = (await readdir(examples, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

describe("example organizations", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-example-organizations-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      workletTransport: "remote",
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
    // A reader replaces the placeholders with hosts they enrolled; here the placeholders are real.
    for (const host of placeholderHosts) await enrollWorkerHost(runtime.url, token, host);
  });

  afterEach(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const run = async (...args: string[]) => {
    output.length = 0;
    await expect(main(args)).resolves.toBe(0);
    return output.join("");
  };

  it("ships at least the documented examples", () => {
    expect(names).toEqual(expect.arrayContaining(["mixed-harnesses", "review-team", "solo"]));
  });

  it("adopts the resources supertag init created when applied over them", async () => {
    // init applies these under its own apply set; see ensureResources in apps/cli/src/init.ts.
    const init = (path: string, kind: string, name: string, spec: object) =>
      client.request(`/api/v1/${path}?applySet=init`, {
        method: "POST",
        body: JSON.stringify({ apiVersion: "supertag/v1", kind, metadata: { name }, spec }),
      });
    await init("permission-sets", "PermissionSet", "local-tools", {
      permissions: [
        { target: "runtime", action: "commands:execute" },
        { target: "runtime", action: "files:write" },
      ],
    });
    await init("roles", "Role", "Lead", {
      purpose: "Own Objectives: plan the work, do or delegate each part, and review the results.",
      instructions: "Work from repository evidence.",
      contextSets: [],
      permissionSets: ["local-tools"],
    });
    await init("tags", "Tag", "lead", { roles: ["Lead"] });

    const path = join(examples, "solo", "organization.yaml");
    // The README's adoption steps: diff shows init's fields, then one forced apply takes them.
    expect(await run("diff", "-f", path)).toContain("spec.purpose owned by init");
    await expect(main(["apply", "-f", path])).rejects.toThrow("owned by init");
    await run("apply", "-f", path, "--force-conflicts");
    expect(await run("diff", "-f", path)).toContain("No changes");
  });

  for (const name of names) {
    it(`${name} applies, matches what the Control Plane stores, and then diffs clean`, async () => {
      const path = join(examples, name, "organization.yaml");
      await run("apply", "-f", path);

      const documents = parseAllDocuments(await readFile(path, "utf8")).map(
        (document) =>
          document.toJS() as {
            kind: string;
            metadata: { name: string };
            spec: Record<string, unknown>;
          },
      );
      expect(documents.length).toBeGreaterThan(0);
      for (const document of documents) {
        const collection = paths[document.kind];
        expect(collection, `unexpected kind ${document.kind}`).toBeDefined();
        const stored = await client.request<{ spec: object }>(
          `/api/v1/${collection}/${encodeURIComponent(document.metadata.name)}`,
        );
        expect(stored.spec, `${document.kind}/${document.metadata.name}`).toMatchObject(
          normalized(document.spec),
        );
      }
      expect(await run("diff", "-f", path)).toContain("No changes");
    });
  }
});
