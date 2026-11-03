import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { DrizzleStore, inspectDatabaseMigrationReadiness, migrateDatabase } from "./src/index.js";

const observed = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("better-sqlite3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-sqlite3")>();
  return {
    // biome-ignore lint/complexity/useArrowFunction: SQLite is invoked as a constructor.
    default: function (path: string, options?: Database.Options) {
      if (path !== ":memory:") {
        observed.push(existsSync(path) ? statSync(path).mode & 0o777 : undefined);
      }
      return new actual.default(path, options);
    },
  };
});

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "supertag-db-mode-"));
  directories.push(directory);
  return join(directory, "supertag.db");
}
function mode(path: string) {
  return statSync(path).mode & 0o777;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  observed.length = 0;
});

it.each(["store", "migration"])(
  "creates a private database before SQLite opens it: %s",
  async (entry) => {
    const path = databasePath();
    const url = `file:${path}`;
    if (entry === "store") {
      const store = new DrizzleStore({ url });
      await store.disconnect();
    } else {
      await migrateDatabase({ url });
    }
    expect(observed).toEqual([0o600]);
    expect(mode(path)).toBe(0o600);
  },
);

it.each(["store", "migration", "inspection", "reconnect"])(
  "tightens existing database and live WAL files on %s",
  async (entry) => {
    const path = databasePath();
    const url = `file:${path}`;
    const store = new DrizzleStore({ url });
    await store.disconnect();
    const seed = new Database(path);
    try {
      seed.pragma("journal_mode = WAL");
      seed.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('kept')");
      const files = [path, `${path}-wal`, `${path}-shm`];
      for (const file of files) chmodSync(file, 0o644);
      if (entry === "store") {
        const reopened = new DrizzleStore({ url });
        await reopened.disconnect();
      } else if (entry === "migration") {
        await migrateDatabase({ url });
      } else if (entry === "inspection") {
        await inspectDatabaseMigrationReadiness({ url });
      } else {
        await store.connect();
      }
      expect(files.map(mode)).toEqual([0o600, 0o600, 0o600]);
      expect(seed.prepare("SELECT value FROM retained").pluck().get()).toBe("kept");
    } finally {
      await store.disconnect();
      seed.close();
    }
  },
);

it("lets SQLite create and recreate private WAL and SHM files", async () => {
  const path = databasePath();
  const store = new DrizzleStore({ url: `file:${path}` });
  await store.disconnect();
  for (let attempt = 0; attempt < 2; attempt++) {
    const database = new Database(path);
    try {
      database.pragma("journal_mode = WAL");
      database.exec(
        "CREATE TABLE IF NOT EXISTS data (value TEXT); INSERT INTO data VALUES ('secret')",
      );
      expect([path, `${path}-wal`, `${path}-shm`].map(mode)).toEqual([0o600, 0o600, 0o600]);
    } finally {
      database.close();
    }
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  }
});

it("tightens existing WAL and SHM files through a database symlink", async () => {
  const path = databasePath();
  const alias = `${path}-alias`;
  const seed = new Database(path);
  try {
    seed.pragma("journal_mode = WAL");
    seed.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('kept')");
    symlinkSync(path, alias);
    const files = [path, `${path}-wal`, `${path}-shm`];
    for (const file of files) chmodSync(file, 0o644);
    const store = new DrizzleStore({ url: `file:${alias}` });
    try {
      expect(files.map(mode)).toEqual([0o600, 0o600, 0o600]);
      expect(seed.prepare("SELECT value FROM retained").pluck().get()).toBe("kept");
    } finally {
      await store.disconnect();
    }
  } finally {
    seed.close();
  }
});
