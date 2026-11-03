import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const ADMIN = "audit-cli-admin";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureOutput(): () => string {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => write.mock.calls.map(([value]) => String(value)).join("");
}

describe("supertag audit", () => {
  it("is listed in supertag --help and has its own help", async () => {
    expect(normalizeActionFirstCommand(["audit", "--since", "2026-10-01"])).toEqual([
      "audit",
      "--since",
      "2026-10-01",
    ]);
    const output = captureOutput();
    expect(await main(["--help"])).toBe(0);
    expect(output()).toContain(
      "supertag audit [--since ISO] [--actor NAME] [--limit N] [--output text|json]",
    );
    expect(await main(["audit", "--help"])).toBe(0);
    expect(output()).toContain("Lists recorded operator changes, newest first");
  });

  it("reads the audit trail from the selected Control Plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-audit-cli-"));
    await migrateSqlite(join(directory, "state.db"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      stateDirectory: directory,
      adminToken: ADMIN,
      coordinationOperatorCredentials: [],
      reply: async () => {},
    });
    cleanups.push(async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", runtime.url);
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "");
    const output = captureOutput();
    expect(await main(["create", "tag", "reviewer"])).toBe(0);
    expect(await main(["audit", "--actor", "control-plane-break-glass", "--limit", "10"])).toBe(0);
    expect(output()).toMatch(
      /^\S+Z\s+control-plane-break-glass\s+apply\s+Tag\/reviewer\s+succeeded \(201\)$/mu,
    );
    expect(output()).not.toContain(ADMIN);
    await expect(main(["audit", "--limit", "1000"])).rejects.toThrow(
      "--limit must be an integer from 1 through 500",
    );
  });
});
