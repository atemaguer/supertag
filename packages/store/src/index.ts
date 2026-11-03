import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CredentialValue, GatewayCredentialVault } from "@supertag/core";
import { Pool } from "pg";
import {
  assertMigrationReady,
  inspectPostgresqlMigrationReadiness,
  inspectSqliteMigrationReadiness,
  type MigrationOptions,
  type MigrationReadiness,
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
} from "./migrations.js";
import { defaultSqliteUrl, stateDirectory } from "./paths.js";
import { openSqliteDatabase } from "./sqlite-connection.js";

export type { StoreOptions } from "./drizzle-store.js";
export { DrizzleStore } from "./drizzle-store.js";
export {
  assertMigrationReady,
  inspectPostgresqlMigrationReadiness,
  inspectSqliteMigrationReadiness,
  type MigrationOptions,
  type MigrationReadiness,
  type MigrationReadinessState,
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
  postgresqlMigrationsFolder,
  sqliteMigrationsFolder,
} from "./migrations.js";
export { stateDirectory } from "./paths.js";
export {
  VaultGatewayCredentialVault,
  type VaultGatewayCredentialVaultOptions,
} from "./vault-credential-vault.js";

export interface DatabaseMigrationOptions extends MigrationOptions {
  readonly url?: string;
}

export async function inspectDatabaseMigrationReadiness(
  options: { readonly url?: string } = {},
): Promise<MigrationReadiness> {
  const url = options.url ?? process.env["SUPERTAG_DATABASE_URL"] ?? defaultSqliteUrl();
  if (url.startsWith("file:")) {
    const path = sqlitePathFromUrl(url);
    const resolvedPath = path === ":memory:" ? path : resolve(path);
    const database =
      resolvedPath === ":memory:" || !existsSync(resolvedPath)
        ? openSqliteDatabase(":memory:")
        : openSqliteDatabase(resolvedPath, { fileMustExist: true, readonly: true });
    try {
      return inspectSqliteMigrationReadiness(database);
    } finally {
      database.close();
    }
  }
  if (url.startsWith("postgresql:") || url.startsWith("postgres:")) {
    const pool = new Pool({ connectionString: url });
    try {
      return await inspectPostgresqlMigrationReadiness(pool);
    } finally {
      await pool.end();
    }
  }
  throw new Error("SUPERTAG_DATABASE_URL must use file:, postgresql:, or postgres:");
}

export async function assertDatabaseSchemaReady(
  options: { readonly url?: string } = {},
): Promise<void> {
  assertMigrationReady(await inspectDatabaseMigrationReadiness(options));
}

export async function migrateDatabase(options: DatabaseMigrationOptions = {}): Promise<void> {
  const url = options.url ?? process.env["SUPERTAG_DATABASE_URL"] ?? defaultSqliteUrl();
  if (url.startsWith("file:")) {
    const path = sqlitePathFromUrl(url);
    const database = openSqliteDatabase(path);
    try {
      database.pragma("foreign_keys = ON");
      migrateSqliteDatabase(database, options);
    } finally {
      database.close();
    }
    return;
  }
  if (url.startsWith("postgresql:") || url.startsWith("postgres:")) {
    const pool = new Pool({ connectionString: url });
    try {
      await migratePostgresqlDatabase(pool, options);
    } finally {
      await pool.end();
    }
    return;
  }
  throw new Error("SUPERTAG_DATABASE_URL must use file:, postgresql:, or postgres:");
}

interface CredentialFile {
  readonly version: 2;
  readonly gateway: Record<string, CredentialValue>;
  readonly operator: Record<string, CredentialValue>;
}

export type FileCredentialSection = "gateway" | "operator";

const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_STALE_MS = 30_000;

/** Lock-protected local credential backend shared by the Gateway and operator providers. */
export class FileCredentialStore {
  readonly #path: string;
  readonly #section: FileCredentialSection;

  constructor(
    section: FileCredentialSection,
    path = resolve(stateDirectory(), "credentials.json"),
  ) {
    this.#section = section;
    this.#path = path;
  }

  async store(credentialId: string, value: CredentialValue): Promise<void> {
    validateCredentialId(credentialId);
    await this.withWriteLock(async () => {
      const file = await this.read();
      await this.write({
        ...file,
        ...this.#withCredentials(file, { ...this.#credentials(file), [credentialId]: value }),
      });
    });
  }

  /**
   * Stores the value only when the current one passes `expected`, checked under the write lock,
   * so a concurrent writer's value is never overwritten by a decision made on an older read.
   */
  async storeIf(
    credentialId: string,
    value: CredentialValue,
    expected: (current: CredentialValue | undefined) => boolean,
  ): Promise<boolean> {
    validateCredentialId(credentialId);
    let stored = false;
    await this.withWriteLock(async () => {
      const file = await this.read();
      if (!expected(this.#credentials(file)[credentialId])) return;
      await this.write({
        ...file,
        ...this.#withCredentials(file, { ...this.#credentials(file), [credentialId]: value }),
      });
      stored = true;
    });
    return stored;
  }

  async storeIfAbsent(credentialId: string, value: CredentialValue): Promise<CredentialValue> {
    validateCredentialId(credentialId);
    let winner: CredentialValue | undefined;
    await this.withWriteLock(async () => {
      const file = await this.read();
      winner = this.#credentials(file)[credentialId];
      if (winner !== undefined) return;
      await this.write({
        ...file,
        ...this.#withCredentials(file, { ...this.#credentials(file), [credentialId]: value }),
      });
      winner = value;
    });
    if (winner === undefined) throw new Error("Credential initialization failed");
    return winner;
  }

  async resolve(credentialId: string): Promise<CredentialValue | undefined> {
    validateCredentialId(credentialId);
    const file = await this.read();
    return this.#credentials(file)[credentialId];
  }

  async delete(credentialId: string): Promise<void> {
    validateCredentialId(credentialId);
    await this.withWriteLock(async () => {
      const file = await this.read();
      const current = this.#credentials(file);
      if (current[credentialId] === undefined) return;
      const { [credentialId]: _deleted, ...credentials } = current;
      await this.write({ ...file, ...this.#withCredentials(file, credentials) });
    });
  }

  private async read(): Promise<CredentialFile> {
    const stats = await lstat(this.#path).catch(() => undefined);
    if (stats === undefined) return emptyCredentialFile();
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Credential store is not a regular file: ${this.#path}`);
    }
    const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
    if (!isCredentialFile(parsed))
      throw new Error(
        `Credential store has an unsupported format: ${this.#path}; expected version 2 with only version, gateway, and operator fields`,
      );
    return parsed;
  }

  #credentials(file: CredentialFile): Record<string, CredentialValue> {
    return file[this.#section];
  }

  #withCredentials(
    _file: CredentialFile,
    credentials: Record<string, CredentialValue>,
  ): Partial<CredentialFile> {
    return this.#section === "gateway" ? { gateway: credentials } : { operator: credentials };
  }

  private async write(file: CredentialFile): Promise<void> {
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withWriteLock(operation: () => Promise<void>): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Managed-volume mount roots are commonly owned by the container runtime. The
    // application user can create private files there but cannot change the root
    // directory's mode. The credential file and lock are still created with 0600.
    await chmod(directory, 0o700).catch((error) => {
      if (!hasCode(error, "EPERM")) throw error;
    });
    const lockPath = `${this.#path}.lock`;
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const lockStats = await lstat(lockPath).catch(() => undefined);
        if (lockStats !== undefined && Date.now() - lockStats.mtimeMs > FILE_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Credential store is busy: ${this.#path}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/** Local development implementation of the Gateway credential-vault contract. */
export class FileGatewayCredentialVault
  extends FileCredentialStore
  implements GatewayCredentialVault
{
  constructor(path?: string) {
    super("gateway", path);
  }
}

/** Accept only the current credential-file format, without extra top-level fields. */
function isCredentialFile(value: unknown): value is CredentialFile {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "gateway", "operator"].includes(key)) ||
    !("version" in value) ||
    value.version !== 2 ||
    !("gateway" in value) ||
    !("operator" in value) ||
    !isCredentialSection(value.gateway) ||
    !isCredentialSection(value.operator)
  )
    return false;
  return true;
}

function isCredentialSection(value: unknown): value is Record<string, CredentialValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (credential) =>
      typeof credential === "object" &&
      credential !== null &&
      !Array.isArray(credential) &&
      Object.values(credential).every((item) => typeof item === "string"),
  );
}

function emptyCredentialFile(): CredentialFile {
  return { version: 2, gateway: {}, operator: {} };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function validateCredentialId(credentialId: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]{2,200}$/i.test(credentialId))
    throw new Error("Credential identifier contains unsupported characters");
}

function sqlitePathFromUrl(url: string): string {
  const path = url.slice("file:".length);
  return path === ":memory:" || path === "::memory:" ? ":memory:" : decodeURIComponent(path);
}
