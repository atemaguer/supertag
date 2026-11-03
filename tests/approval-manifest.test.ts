import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

describe("Permission Set approval manifests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("round-trips approval and approvers through apply and diff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-approval-manifest-"));
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
      const account = await client.setupSurface({
        provider: "slack",
        externalAccountId: "T_APPROVAL",
        displayName: "Approval Slack",
        authMethod: "slack-bot-token",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
      });
      const manifest = (options: { approvers?: string; approval: boolean }) =>
        [
          "apiVersion: supertag/v1",
          "kind: PermissionSet",
          "metadata:",
          "  name: release-engineering",
          "spec:",
          ...(options.approvers === undefined ? [] : [`  approvers: ${options.approvers}`]),
          "  permissions:",
          "    - target: surface",
          `      surfaceAccountId: ${account.metadata.id}`,
          "      scope: channel:C_RELEASE",
          "      action: history:read",
          "    - target: runtime",
          "      action: commands:execute",
          ...(options.approval ? ["      approval: required"] : []),
          "",
        ].join("\n");
      const path = join(directory, "permission-set.yaml");
      const get = () =>
        client.request<{ spec: Record<string, unknown> }>(
          "/api/v1/permission-sets/release-engineering",
        );

      // A manifest without the new fields behaves as before.
      await writeFile(path, manifest({ approval: false }));
      await expect(main(["apply", "-f", path])).resolves.toBe(0);
      const plain = await get();
      expect(plain.spec).not.toHaveProperty("approvers");
      expect(JSON.stringify(plain.spec)).not.toContain("approval");

      await writeFile(
        path,
        manifest({ approvers: "[operator:release-oncall, tag:release-manager]", approval: true }),
      );
      output.length = 0;
      await expect(main(["diff", "-f", path])).resolves.toBe(0);
      expect(output.join("")).toContain(
        "spec.approvers: + operator:release-oncall, + tag:release-manager",
      );
      expect(output.join("")).toContain("spec.permissions: ~ runtime:commands:execute");
      await expect(main(["apply", "-f", path])).resolves.toBe(0);
      const gated = await get();
      expect(gated.spec).toMatchObject({
        approvers: ["operator:release-oncall", "tag:release-manager"],
        permissions: expect.arrayContaining([
          expect.objectContaining({
            target: "runtime",
            action: "commands:execute",
            approval: "required",
          }),
          expect.not.objectContaining({ approval: expect.anything() }),
        ]),
      });
      output.length = 0;
      await expect(main(["diff", "-f", path])).resolves.toBe(0);
      expect(output.join("")).toContain("No changes.");

      // Removing the fields from the manifest clears them.
      await writeFile(path, manifest({ approval: false }));
      await expect(main(["apply", "-f", path])).resolves.toBe(0);
      const cleared = await get();
      expect(cleared.spec).not.toHaveProperty("approvers");
      expect(JSON.stringify(cleared.spec)).not.toContain("approval");

      await writeFile(path, manifest({ approvers: "[admin]", approval: false }));
      await expect(main(["apply", "-f", path])).rejects.toThrow("Invalid approver");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
