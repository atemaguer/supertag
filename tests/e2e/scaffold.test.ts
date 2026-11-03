import { describe, expect, it } from "vitest";
import { main } from "../../apps/cli/src/index.ts";
import { tagIdSchema } from "../../packages/core/src/index.ts";
import { DrizzleStore } from "../../packages/store/src/index.ts";

describe("repository scaffold", () => {
  it("validates Tag identifiers at the core boundary", () => {
    expect(tagIdSchema.parse(" demo ")).toBe("demo");
    expect(() => tagIdSchema.parse(" ")).toThrow();
  });

  it("connects to the zero-configuration SQLite adapter", async () => {
    const sqlite = new DrizzleStore({ url: "file::memory:" });
    expect(sqlite.provider).toBe("sqlite");
    await sqlite.connect();
    await sqlite.disconnect();
  });

  it("provides a working CLI help entry point", async () => {
    await expect(main(["--help"])).resolves.toBe(0);
    await expect(main(["setup", "slack", "--help"])).resolves.toBe(0);
    await expect(main(["setup", "github", "--help"])).resolves.toBe(0);
    await expect(main(["tag", "--help"])).resolves.toBe(0);
    await expect(main(["control-plane", "--help"])).resolves.toBe(0);
    await expect(main(["migrate", "--help"])).resolves.toBe(0);
  });
});

const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
describe.runIf(postgresqlUrl !== undefined)("PostgreSQL store adapter", () => {
  it("connects through the same store boundary", async () => {
    const postgresql = new DrizzleStore({ url: postgresqlUrl });
    expect(postgresql.provider).toBe("postgresql");
    await postgresql.connect();
    await postgresql.disconnect();
  });
});
