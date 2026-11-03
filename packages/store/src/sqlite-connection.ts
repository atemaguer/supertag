import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

/** Open state without exposing database contents through the host's default umask. */
export function openSqliteDatabase(path: string, options?: Database.Options): Database.Database {
  if (path !== ":memory:") {
    if (options?.readonly || options?.fileMustExist) {
      chmodSync(path, 0o600);
    } else {
      mkdirSync(dirname(resolve(path)), { recursive: true });
      // O_CREAT uses 0600 on first creation; append mode never truncates existing state.
      const descriptor = openSync(path, "a", 0o600);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    }
    const realPath = realpathSync(path);
    // SQLite's Unix VFS creates journals, WAL and SHM with the database's mode.
    // Tighten sidecars left by earlier versions before SQLite can read or write them.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        chmodSync(`${realPath}${suffix}`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return new Database(path, options);
}
