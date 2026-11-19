/**
 * The saved Gateways, `<config>/ai.supertag.desktop/gateways.json`, which the CLI also reads
 * (`core/crates/cli/src/profiles.rs`, `desktop_store`). Its shape:
 * `{ active, gateways: [{ profile: { name, origin }, token }] }`, an owner-only file
 * in a directory only its owner can write, replaced atomically. The single-instance lock keeps
 * one app writing it.
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { GatewayProfile } from "../model/gateway";

export const STORE_ERROR = "Could not read or save your Gateway connections.";
const MAX_STORE_BYTES = 16 * 1024 * 1024;

export interface SavedGateway {
  profile: GatewayProfile;
  token: string;
}

export interface Profiles {
  active: string | null;
  gateways: SavedGateway[];
}

const uid = () => process.getuid?.();
const ownedBySomeoneElse = (owner: number) => uid() !== undefined && owner !== uid();

function parse(text: string): Profiles {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw STORE_ERROR;
  const record = value as Record<string, unknown>;
  const active = record["active"] ?? null;
  const gateways = record["gateways"];
  if ((active !== null && typeof active !== "string") || !Array.isArray(gateways)) {
    throw STORE_ERROR;
  }
  return {
    active,
    gateways: gateways.map((entry: unknown) => {
      const saved = entry as { profile?: { name?: unknown; origin?: unknown }; token?: unknown };
      if (
        typeof saved?.profile?.name !== "string" ||
        typeof saved.profile.origin !== "string" ||
        typeof saved.token !== "string"
      ) {
        throw STORE_ERROR;
      }
      return {
        profile: { name: saved.profile.name, origin: saved.profile.origin },
        token: saved.token,
      };
    }),
  };
}

/** The saved Gateways; none when the store does not exist yet. */
export async function loadProfiles(file: string): Promise<Profiles> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: null, gateways: [] };
    throw STORE_ERROR;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      ownedBySomeoneElse(metadata.uid) ||
      metadata.size > MAX_STORE_BYTES
    ) {
      throw STORE_ERROR;
    }
    return parse(await handle.readFile("utf8"));
  } catch {
    throw STORE_ERROR;
  } finally {
    await handle.close();
  }
}

/** Creates the store's directory, owner-only, and checks only its owner can write it. */
export async function storeDirectory(file: string): Promise<void> {
  const directory = path.dirname(file);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(directory);
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o022) !== 0 ||
      ownedBySomeoneElse(metadata.uid)
    ) {
      throw STORE_ERROR;
    }
  } catch {
    throw STORE_ERROR;
  }
}

/** Replaces the store with `profiles`: a private staged file renamed into place. */
export async function saveProfiles(file: string, profiles: Profiles): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(profiles), "utf8");
  if (bytes.length > MAX_STORE_BYTES) throw "The saved Gateway list is too large.";
  await storeDirectory(file);
  const staged = path.join(path.dirname(file), `.gateways${randomBytes(6).toString("hex")}`);
  try {
    const handle = await fs.open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staged, file);
  } catch {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw STORE_ERROR;
  }
}
