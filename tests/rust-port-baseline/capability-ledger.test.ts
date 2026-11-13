import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every test and path the capability ledger cites must exist, so stale evidence fails here. */
const root = resolve(import.meta.dirname, "../..");
const ledger = await readFile(join(root, "rust/docs/rust-port-capability-ledger.md"), "utf8");
const cited = [...ledger.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1] as string);

async function rustSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const testTargets = new Set(
  (await rustSources(join(root, "rust/crates")))
    .filter((path) => /\/tests\/[^/]+\.rs$/u.test(path))
    .map((path) => path.slice(path.lastIndexOf("/") + 1, -".rs".length)),
);
const rust = (
  await Promise.all(
    (await rustSources(join(root, "rust/crates"))).map((path) => readFile(path, "utf8")),
  )
).join("\n");

describe("Rust port capability ledger", () => {
  it("cites only Rust test functions that exist", () => {
    // Test names are snake_case identifiers with at least three words, optionally with the
    // ledger's `sqlite_/postgres_name` shorthand for a paired test.
    const names = cited
      .flatMap((text) => text.split(/\s+|\//u))
      .map((name) => name.replace(/^(?:sqlite_|postgres_)$/u, ""))
      .filter((name) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/u.test(name));
    const paired = [...ledger.matchAll(/`sqlite_\/postgres_([a-z0-9_]+)`/gu)].flatMap((match) => [
      `sqlite_${match[1]}`,
      `postgres_${match[1]}`,
    ]);
    const missing = [...new Set([...names, ...paired])].filter(
      (name) =>
        !name.startsWith("supertag_v2_") &&
        !testTargets.has(name) &&
        !new RegExp(`\\bfn ${name}\\b`, "u").test(rust),
    );
    expect(missing).toEqual([]);
    expect(names.length).toBeGreaterThan(50);
  });

  it("cites only repository paths that exist", () => {
    const paths = cited.filter(
      (text) =>
        /^[\w.-]+(?:\/[\w.-]+)+\/?$/u.test(text) &&
        !text.includes("*") &&
        (/\.(?:ts|rs|py|go|mjs|md|json)$/u.test(text) || text.endsWith("/")),
    );
    const missing = paths.filter(
      (path) =>
        !existsSync(join(root, path)) &&
        !existsSync(join(root, "rust/crates", path)) &&
        !existsSync(join(root, "rust/crates/cli/tests", path)),
    );
    // Design documents live in the gitignored contributing/ directory.
    expect(
      missing.filter((path) => !path.startsWith("rust-port-") && !path.startsWith("contributing/")),
    ).toEqual([]);
    expect(paths.length).toBeGreaterThan(100);
  });
});
