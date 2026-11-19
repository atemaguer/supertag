/**
 * What the terminal UI remembers between launches, `<config>/supertag/tui.json`: the Gateway it
 * used last, whom each Gateway's credential acted as (so a launch paints that Gateway's cached
 * conversations before it connects), and the Tag list's width and fold. Never a credential.
 * Owner-only, replaced atomically; a file of another schema is ignored.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CacheScope, configRoot } from "@supertag/client/node";

const SCHEMA_VERSION = 1;
export const RAIL = { initial: 30, min: 18, max: 60 };

export interface Preferences {
  /** The Gateway entry used last: `local` or `saved:` and its origin. */
  lastGateway?: string;
  /** Each entry's cache scope as its last connection found it. */
  scopes: Record<string, CacheScope>;
  railWidth: number;
  railFolded: boolean;
}

export function preferencesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configRoot(env), "supertag", "tui.json");
}

function parse(text: string): Preferences | undefined {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || value["schemaVersion"] !== SCHEMA_VERSION) return undefined;
  const scopes: Record<string, CacheScope> = {};
  const raw = value["scopes"];
  if (raw && typeof raw === "object") {
    for (const [id, scope] of Object.entries(raw as Record<string, unknown>)) {
      const entry = scope as Partial<CacheScope> | null;
      if (typeof entry?.gateway === "string" && typeof entry.principal === "string")
        scopes[id] = { gateway: entry.gateway, principal: entry.principal };
    }
  }
  const width = value["railWidth"];
  return {
    ...(typeof value["lastGateway"] === "string" ? { lastGateway: value["lastGateway"] } : {}),
    scopes,
    railWidth:
      typeof width === "number" && width >= RAIL.min && width <= RAIL.max
        ? Math.round(width)
        : RAIL.initial,
    railFolded: value["railFolded"] === true,
  };
}

export function loadPreferences(file: string): Preferences {
  try {
    return parse(readFileSync(file, "utf8")) ?? defaults();
  } catch {
    return defaults();
  }
}

export function defaults(): Preferences {
  return { scopes: {}, railWidth: RAIL.initial, railFolded: false };
}

/** Writes the preferences; a failure only loses them. */
export function savePreferences(file: string, preferences: Preferences): void {
  const staged = `${file}.${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(staged, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...preferences }), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(staged, file);
  } catch {
    rmSync(staged, { force: true });
  }
}
