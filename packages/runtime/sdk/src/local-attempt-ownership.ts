import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const REGISTRY = `.supertag-attempt-owners-${process.getuid?.() ?? "local"}`;
interface Manifest {
  version: 1;
  ownerPid: number;
  host: string;
  uid: number | null;
  platform: string;
  rootName: string;
  rootDev: string;
  rootIno: string;
  taskId: string;
  attemptId: string;
  specDigest?: string;
}
type ProcessRecord =
  | { state: "none" }
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "recorded"; groupPid: number };
export interface LocalAttemptOwnership {
  /** Persist uncertainty before spawning: a crash before record() must preserve the root. */
  prepareProcess(): Promise<{ record(pid: number | undefined): Promise<void> }>;
  /** Mark the owner finished; callers may remove the root only when this returns true. */
  dispose(): Promise<boolean>;
  /** Forget ownership only after the root has actually been removed. */
  forget(): Promise<void>;
}

function uid(): number | null {
  return process.getuid?.() ?? null;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}
function dead(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}
async function secureDirectory(path: string, create = false): Promise<boolean> {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  const stat = await lstat(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    (uid() === null || stat.uid === uid()) &&
    (process.platform === "win32" || privateMode(stat.mode))
  );
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (uid() !== null && stat.uid !== uid()) ||
      (process.platform !== "win32" && !privateMode(stat.mode)) ||
      stat.size > 16384 ||
      stat.nlink !== 1
    )
      throw new Error("Unsafe ownership metadata");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
function manifestMatches(value: unknown, name: string): value is Manifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<Manifest>;
  return (
    m.version === 1 &&
    m.host === hostname() &&
    m.uid === uid() &&
    m.platform === process.platform &&
    m.rootName === name &&
    name.startsWith("supertag-attempt-") &&
    name === basename(name) &&
    name !== "." &&
    name !== ".." &&
    name !== REGISTRY &&
    Number.isSafeInteger(m.ownerPid) &&
    (m.ownerPid ?? 0) > 0 &&
    typeof m.rootDev === "string" &&
    typeof m.rootIno === "string" &&
    typeof m.taskId === "string" &&
    typeof m.attemptId === "string" &&
    (m.specDigest === undefined ||
      (typeof m.specDigest === "string" && /^[a-f0-9]{64}$/.test(m.specDigest)))
  );
}
async function rootMatches(root: string, manifest: Manifest): Promise<boolean> {
  try {
    const stat = await lstat(root);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (manifest.uid === null || stat.uid === manifest.uid) &&
      String(stat.dev) === manifest.rootDev &&
      String(stat.ino) === manifest.rootIno
    );
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function processesGone(directory: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    // A concurrent reaper can remove the ownership record after disposal publishes finished.
    // Missing evidence never grants permission to delete a root.
    if (missing(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry === "manifest.json" || entry === "finished.json") continue;
    // Unknown or interrupted writes are evidence of uncertainty, never permission to reap.
    if (!/^process-[0-9a-f-]+\.json$/u.test(entry)) return false;
    let value: unknown;
    try {
      value = await readJson(join(directory, entry));
    } catch {
      return false;
    }
    const record = value as Partial<ProcessRecord> | null;
    if (record?.state === "none") continue;
    if (
      record?.state !== "recorded" ||
      !("groupPid" in record) ||
      !Number.isSafeInteger(record.groupPid) ||
      (record.groupPid ?? 0) <= 0 ||
      !dead(-record.groupPid)
    )
      return false;
  }
  return true;
}

export async function createLocalAttemptOwnership(
  root: string,
  identity: { taskId: string; attemptId: string; specDigest?: string },
): Promise<LocalAttemptOwnership> {
  const absolute = resolve(root),
    parent = dirname(absolute),
    name = basename(absolute);
  if (!name.startsWith("supertag-attempt-"))
    throw new Error("Attempt root must use the owned attempt prefix");
  const rootStat = await lstat(absolute);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (uid() !== null && rootStat.uid !== uid())
  )
    throw new Error("Attempt root must be an owned directory");
  const registry = join(parent, REGISTRY);
  if (!(await secureDirectory(registry, true)))
    throw new Error("Attempt ownership registry must be private and owned");
  const directory = join(registry, name);
  await mkdir(directory, { mode: 0o700 });
  const manifest: Manifest = {
    version: 1,
    ownerPid: process.pid,
    host: hostname(),
    uid: uid(),
    platform: process.platform,
    rootName: name,
    rootDev: String(rootStat.dev),
    rootIno: String(rootStat.ino),
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    ...(identity.specDigest ? { specDigest: identity.specDigest } : {}),
  };
  await atomicJson(join(directory, "manifest.json"), manifest);
  let finished = false;
  let writes = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = writes.then(work);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return {
    prepareProcess() {
      return serialize(async () => {
        if (finished) throw new Error("Attempt ownership already disposed");
        const path = join(directory, `process-${randomUUID()}.json`);
        await atomicJson(path, { state: "pending" });
        let recorded = false;
        return {
          record(pid) {
            return serialize(async () => {
              if (recorded) throw new Error("Process ownership already recorded");
              recorded = true;
              const value: ProcessRecord =
                pid === undefined
                  ? { state: "none" }
                  : process.platform !== "win32" && Number.isSafeInteger(pid) && pid > 0
                    ? { state: "recorded", groupPid: pid }
                    : { state: "unknown" };
              await atomicJson(path, value);
            });
          },
        };
      });
    },
    dispose() {
      return serialize(async () => {
        finished = true;
        // A finished marker permits another provider to reap this root even while our owner
        // process remains alive. Check our evidence before publishing that handoff; otherwise
        // recovery can remove the registry mid-check and turn successful cleanup into uncertainty.
        const removable =
          (await rootMatches(absolute, manifest)) && (await processesGone(directory));
        await atomicJson(join(directory, "finished.json"), { finished: true });
        return removable;
      });
    },
    async forget() {
      await writes;
      try {
        await lstat(absolute);
        return;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (!(await secureDirectory(directory).catch(() => false))) return;
      const current = await readJson(join(directory, "manifest.json")).catch(() => null);
      if (
        !manifestMatches(current, name) ||
        current.rootDev !== manifest.rootDev ||
        current.rootIno !== manifest.rootIno
      )
        return;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Never signals processes. Only confirmed dead owners/groups and exact owned roots are reaped. */
export async function recoverLocalAttempts(parent: string): Promise<void> {
  if (uid() === null) return;
  const absolute = resolve(parent),
    registry = join(absolute, REGISTRY);
  if (!(await secureDirectory(registry).catch(() => false))) return;
  for (const name of await readdir(registry)) {
    const directory = join(registry, name);
    try {
      if (!(await secureDirectory(directory))) continue;
      const manifest = await readJson(join(directory, "manifest.json"));
      if (!manifestMatches(manifest, name)) continue;
      const finish = await readJson(join(directory, "finished.json")).catch(() => null);
      const finished =
        typeof finish === "object" &&
        finish !== null &&
        (finish as { finished?: unknown }).finished === true;
      if (!finished && !dead(manifest.ownerPid)) continue;
      if (!(await processesGone(directory))) continue;
      const root = join(absolute, name);
      if (await rootMatches(root, manifest)) await removeOwnedRoot(root, manifest);
      // A concurrent reaper may already have removed both. A replacement root is preserved.
      try {
        await lstat(root);
        continue;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const current = await readJson(join(directory, "manifest.json")).catch(() => null);
      if (
        manifestMatches(current, name) &&
        current.rootDev === manifest.rootDev &&
        current.rootIno === manifest.rootIno
      ) {
        if (manifest.specDigest)
          await atomicJson(
            join(registry, cleanupKey(manifest.taskId, manifest.attemptId, manifest.specDigest)),
            { ...manifest, cleanupConfirmed: true },
          );
        await rm(directory, { recursive: true, force: true });
      }
    } catch {
      /* Uncertain ownership, permissions, races or liveness preserve the root. */
    }
  }
}
async function removeOwnedRoot(root: string, manifest: Manifest): Promise<void> {
  const makeWritable = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await chmod(path, stat.mode | 0o700);
      for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    }
  };
  if (!(await rootMatches(root, manifest))) return;
  await makeWritable(root);
  if (!(await rootMatches(root, manifest))) return;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function cleanupKey(taskId: string, attemptId: string, specDigest: string): string {
  return `cleanup-${createHash("sha256")
    .update(JSON.stringify([taskId, attemptId, specDigest]))
    .digest("hex")}.json`;
}
/** Proof applies only to a colocated local execution, never to a remote sandbox. */
export async function localAttemptCleanupConfirmed(
  parent: string,
  taskId: string,
  attemptId: string,
  specDigest: string,
): Promise<boolean> {
  await recoverLocalAttempts(parent);
  const registry = join(resolve(parent), REGISTRY);
  if (!(await secureDirectory(registry).catch(() => false))) return false;
  const value = await readJson(join(registry, cleanupKey(taskId, attemptId, specDigest))).catch(
    () => null,
  );
  if (!value || typeof value !== "object") return false;
  const record = value as Manifest & { cleanupConfirmed?: boolean };
  return (
    typeof record.rootName === "string" &&
    manifestMatches(record, record.rootName) &&
    record.taskId === taskId &&
    record.attemptId === attemptId &&
    record.specDigest === specDigest &&
    record.cleanupConfirmed === true
  );
}
