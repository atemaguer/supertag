/**
 * What the app keeps on disk to show at once on launch, before the Gateway answers: the Tag
 * list, recent conversations, and messages not yet sent. Each Gateway and principal has its own
 * directory, named by digests, under the app's cache directory. The files hold only what the app
 * read or wrote, never a credential, and only this user can read them.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

/** The most one entry may take. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** How many entries each Gateway and principal keep; the least recently written go first. */
export const MAX_ENTRIES = 64;
export const CACHE_ERROR = "Could not use the conversation cache.";

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Where a Gateway's cached conversations are, for every principal. */
export function gatewayDirectory(root: string, gateway: string): string {
  return path.join(root, digest([gateway]));
}

/** What a connection's cache entries are scoped to: the Gateway, and whom it acts as. */
export interface CacheScope {
  readonly gateway: string;
  readonly principal: string;
}

export function entryPath(root: string, scope: CacheScope, key: string): string {
  return path.join(
    gatewayDirectory(root, scope.gateway),
    digest([scope.principal]),
    `${digest([key])}.json`,
  );
}

/** An entry's key: `roster`, `outbox`, `drafts`, or `tag:` and a Tag ID. */
export function validKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  if (key === "roster" || key === "outbox" || key === "drafts") return true;
  if (!key.startsWith("tag:")) return false;
  const tag = key.slice(4);
  return tag.length > 0 && Buffer.byteLength(tag) <= 256 && !/\p{Cc}/u.test(tag);
}

const uid = () => process.getuid?.();

async function privateDirectory(directory: string) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(directory);
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      (uid() !== undefined && metadata.uid !== uid())
    ) {
      throw CACHE_ERROR;
    }
  } catch {
    throw CACHE_ERROR;
  }
}

/** The entry at `file`, if it is a private regular file of this user within the size limit. */
export async function readEntry(file: string): Promise<unknown> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    if ((metadata.mode & 0o077) !== 0 || (uid() !== undefined && metadata.uid !== uid())) {
      return undefined;
    }
    if (metadata.size > MAX_ENTRY_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_ENTRY_BYTES) return undefined;
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Replaces the entry at `file` atomically, as an owner-only file. */
export async function writeEntry(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  if (text === undefined) throw CACHE_ERROR;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_ENTRY_BYTES) {
    // Too large to keep; the conversation still loads from the Gateway.
    await fs.rm(file, { force: true }).catch(() => {});
    return;
  }
  const parent = path.dirname(file);
  await privateDirectory(parent);
  const staged = path.join(parent, `.tmp${randomBytes(6).toString("hex")}`);
  try {
    const handle = await fs.open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await fs.rename(staged, file);
  } catch {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw CACHE_ERROR;
  }
  await prune(parent);
}

/** Keeps the {@link MAX_ENTRIES} most recently written entries of one scope. */
async function prune(directory: string) {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }
  const files: { modified: number; file: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      files.push({ modified: (await fs.lstat(file)).mtimeMs, file });
    } catch {
      // Removed meanwhile.
    }
  }
  if (files.length <= MAX_ENTRIES) return;
  files.sort((a, b) => a.modified - b.modified || (a.file < b.file ? -1 : 1));
  for (const { file } of files.slice(0, files.length - MAX_ENTRIES)) {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/** Removes everything cached for a Gateway, for every principal. */
export async function forget(root: string, gateway: string): Promise<void> {
  await fs.rm(gatewayDirectory(root, gateway), { recursive: true, force: true }).catch(() => {});
}
