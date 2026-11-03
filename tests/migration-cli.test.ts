import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("migration CLI", () => {
  it("checks schema readiness without mutating the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-migration-cli-"));
    const databasePath = join(directory, "state.db");
    const output: string[] = [];
    vi.stubEnv("SUPERTAG_DATABASE_URL", `file:${databasePath}`);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["migrate", "--check"])).resolves.toBe(1);
      expect(output.join("")).toContain("Database schema: uninitialized");
      expect(existsSync(databasePath)).toBe(false);
      output.length = 0;

      await expect(main(["migrate"])).resolves.toBe(0);
      expect(output.join("")).toContain("database schema updated");
      output.length = 0;

      await expect(main(["migrate", "database"])).resolves.toBe(0);
      expect(output.join("")).toContain("already current; no changes were needed");
      output.length = 0;
      await expect(main(["migrate", "--check"])).resolves.toBe(0);
      expect(output.join("")).toContain("Database schema: current");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("has no maintenance mode", async () => {
    await expect(main(["migrate", "--maintenance"])).rejects.toThrow("Unknown option");
  });
});
