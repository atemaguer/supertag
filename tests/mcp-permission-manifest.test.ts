import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { getResource } from "./support/resources.ts";

describe("target: mcp Permission Set manifests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("applies, exports, and diffs MCP grants, and rejects malformed ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-manifest-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
      await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
      const client = new ControlPlaneClient({ url: runtime.url, token });
      const manifest = (permissions: readonly string[]) =>
        [
          "apiVersion: supertag/v1",
          "kind: PermissionSet",
          "metadata:",
          "  name: triage",
          "spec:",
          "  permissions:",
          ...permissions,
          "",
        ].join("\n");
      const grants = [
        '    - { target: mcp, action: "sentry/get_issue_details" }',
        '    - { target: mcp, action: "sentry/update_issue", approval: required }',
        '    - { target: mcp, action: "notion/*" }',
        '    - { target: mcp, action: "github/create_pull_request", resource: "repository:acme/api" }',
      ];
      const path = join(directory, "permission-set.yaml");
      await writeFile(path, manifest(grants));
      await expect(main(["apply", "-f", path])).resolves.toBe(0);
      const stored = await getResource(client, "permission-sets", "triage");
      expect(
        stored.spec.permissions.map(({ target, action, resource, approval }) => ({
          target,
          action,
          ...(resource === undefined ? {} : { resource }),
          ...(approval === undefined ? {} : { approval }),
        })),
      ).toEqual(
        expect.arrayContaining([
          { target: "mcp", action: "sentry/get_issue_details" },
          { target: "mcp", action: "sentry/update_issue", approval: "required" },
          { target: "mcp", action: "notion/*" },
          { target: "mcp", action: "github/create_pull_request", resource: "repository:acme/api" },
        ]),
      );
      expect(stored.spec.permissions).toHaveLength(4);
      output.length = 0;
      await expect(main(["diff", "-f", path])).resolves.toBe(0);
      expect(output.join("")).toContain("No changes.");

      // A different resource is a different grant.
      await writeFile(
        path,
        manifest([
          ...grants.slice(0, 3),
          '    - { target: mcp, action: "github/create_pull_request", resource: "repository:acme/web" }',
        ]),
      );
      await expect(main(["apply", "-f", path])).resolves.toBe(0);
      const changed = await getResource(client, "permission-sets", "triage");
      expect(JSON.stringify(changed.spec)).toContain("repository:acme/web");
      expect(JSON.stringify(changed.spec)).not.toContain("repository:acme/api");

      for (const [entry, message] of [
        ['    - { target: mcp, action: "sentry" }', /server\/tool/u],
        ['    - { target: mcp, action: "Sentry/get_issue" }', /exact server name/u],
        ['    - { target: mcp, action: "sentry/get issue" }', /letters, digits/u],
        ['    - { target: mcp, action: "*/get_issue" }', /exact server name/u],
        ['    - { target: mcp, action: "sentry/x", resource: "repository:acme/*" }', /kind:value/u],
        ['    - { target: mcp, action: "sentry/x", resource: "acme" }', /kind:value/u],
        [
          '    - { target: mcp, action: "sentry/x", scope: "repository:1" }',
          /does not take scope/u,
        ],
        ['    - { target: mcpx, action: "sentry/x" }', /surface, runtime, or mcp/u],
      ] as const) {
        await writeFile(path, manifest([entry]));
        await expect(main(["apply", "-f", path]), entry).rejects.toThrow(message);
      }
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
