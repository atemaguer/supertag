import { posix } from "node:path";
import { parseVolumeSource } from "./volume.js";

/** A live source attached at Task start, not a snapshot or an object manifest. */
export interface LiveMount {
  readonly volume: string;
  /** The configured source URL, without credentials. */
  readonly source: string;
  /** The source's key prefix; empty when the entire source is mounted. */
  readonly prefix: string;
  readonly path: string;
  readonly strategy: "mount";
  readonly access: "read-only" | "read-write";
  /** When the provider successfully attached the source, in ISO 8601 UTC. */
  readonly attachedAt: string;
}

const FIELDS = new Set(["volume", "source", "prefix", "path", "strategy", "access", "attachedAt"]);

/** Validate provider-reported evidence before it enters a journal or Task Attempt. */
export function parseLiveMounts(value: unknown): readonly LiveMount[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Live mounts must be an array of at most 64 records");
  const paths = new Set<string>();
  return value.map((item: unknown, index) => {
    const field = `Live mount ${index}`;
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${field} must be an object`);
    const record = item as Record<string, unknown>;
    // Reject extensions rather than letting credentials survive in the raw journal event.
    if (Object.keys(record).some((key) => !FIELDS.has(key)))
      throw new Error(`${field} contains unsupported fields`);
    const volume = text(record["volume"], `${field} volume`, 63);
    const source = text(record["source"], `${field} source`, 4096);
    const location = parseVolumeSource(source, `${field} source`);
    if (location.scheme === "file") throw new Error(`${field} source cannot be a host directory`);
    const prefix = text(record["prefix"], `${field} prefix`, 4096, true);
    if (prefix !== ("prefix" in location ? location.prefix : ""))
      throw new Error(`${field} prefix must match its source`);
    const path = text(record["path"], `${field} path`, 4096);
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.endsWith("/"))
      throw new Error(`${field} path must be a normalized absolute path`);
    if (paths.has(path)) throw new Error(`${field} repeats a path`);
    paths.add(path);
    if (record["strategy"] !== "mount") throw new Error(`${field} strategy must be mount`);
    if (record["access"] !== "read-only" && record["access"] !== "read-write")
      throw new Error(`${field} access must be read-only or read-write`);
    const attachedAt = text(record["attachedAt"], `${field} attachedAt`, 24);
    const time = Date.parse(attachedAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== attachedAt)
      throw new Error(`${field} attachedAt must be an ISO 8601 UTC time`);
    return {
      volume,
      source,
      prefix,
      path,
      strategy: "mount",
      access: record["access"],
      attachedAt,
    };
  });
}

function text(value: unknown, field: string, max: number, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    value.length > max ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error(`${field} must be bounded text without control characters`);
  return value;
}
