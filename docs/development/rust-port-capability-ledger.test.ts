import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The capability ledger beside this file is frozen at the last commit that contained the
 * TypeScript runtime. Its Rust citations must keep naming Rust tests that exist, so renamed or
 * deleted Rust evidence fails here. Every other cited path must exist now or at the freeze
 * commit: TypeScript citations are historical. That check reads the freeze commit from Git, so
 * it needs full history (`fetch-depth: 0` in CI) and is skipped without it.
 */
const root = resolve(import.meta.dirname, "../..");
const ledger = await readFile(join(import.meta.dirname, "rust-port-capability-ledger.md"), "utf8");
const FROZEN_AT = "6c934be8c25a60226fa43c7bdc87d312bae495a7";

/** Files at the freeze commit, or undefined when this checkout lacks that commit. */
function filesAtFreeze(): Set<string> | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${FROZEN_AT}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return undefined;
  }
  return new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", FROZEN_AT], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean),
  );
}
const atFreeze = filesAtFreeze();
const backticked = (text: string) =>
  [...text.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1] as string);
const cited = backticked(ledger);

async function rustSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const crates = join(root, "core/crates");
const rustFiles = new Map(
  await Promise.all(
    (await rustSources(crates)).map(
      async (path) => [relative(crates, path), await readFile(path, "utf8")] as const,
    ),
  ),
);
const testTargets = new Set(
  [...rustFiles.keys()]
    .filter((path) => /\/tests\/[^/]+\.rs$/u.test(path))
    .map((path) => path.slice(path.lastIndexOf("/") + 1, -".rs".length)),
);
const rust = [...rustFiles.values()].join("\n");

/** Cells of a Markdown table row; a `|` inside backticks belongs to its cell. */
function cells(line: string): string[] {
  const result: string[] = [];
  let cell = "";
  let code = false;
  for (const character of line.trim().slice(1, -1)) {
    if (character === "`") code = !code;
    if (character === "|" && !code) {
      result.push(cell.trim());
      cell = "";
    } else cell += character;
  }
  result.push(cell.trim());
  return result;
}

/** Body rows of every table whose header cells are exactly `header`. */
function tableRows(...header: string[]): string[][] {
  const rows: string[][] = [];
  let inside = false;
  for (const line of ledger.split("\n")) {
    if (!line.startsWith("|")) {
      inside = false;
      continue;
    }
    const row = cells(line);
    if (row.join("|") === header.join("|")) inside = true;
    else if (inside && !/^-+$/u.test(row[0] ?? "")) rows.push(row);
  }
  return rows;
}

const capabilities = tableRows("Capability", "TypeScript tests", "Rust tests", "Status", "Gap");

/** A cited Rust file: a crate-relative path, or a file name that is unique under core/crates. */
function rustFile(citation: string): string | undefined {
  const matches = [...rustFiles.keys()].filter(
    (path) => path === citation || path.endsWith(`/${citation}`),
  );
  return matches.length === 1 ? rustFiles.get(matches[0] as string) : undefined;
}

/** Rust identifiers in one citation, expanding the `sqlite_/postgres_name` paired-test shorthand. */
function identifiers(citation: string): string[] {
  const paired = /^sqlite_\/postgres_([a-z0-9_]+)$/u.exec(citation);
  if (paired) return [`sqlite_${paired[1]}`, `postgres_${paired[1]}`];
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(citation) ? [citation] : [];
}

describe("Rust port capability ledger", () => {
  it("parses every capability row into five cells", () => {
    expect(capabilities.length).toBeGreaterThan(100);
    expect(capabilities.filter((row) => row.length !== 5).map((row) => row[0])).toEqual([]);
  });

  it("cites each Rust test name in the Rust file cited before it", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [capability, , evidence] of capabilities) {
      let file: { readonly name: string; readonly source: string | undefined } | undefined;
      for (const citation of backticked(evidence ?? "")) {
        if (citation.endsWith(".rs") && !citation.includes("*")) {
          file = { name: citation, source: rustFile(citation) };
          if (file.source === undefined)
            problems.push(`${capability}: ${citation} names no unique Rust file`);
          continue;
        }
        for (const name of identifiers(citation)) {
          checked += 1;
          if (file === undefined) {
            if (!new RegExp(`\\bfn ${name}\\b`, "u").test(rust))
              problems.push(`${capability}: no Rust function ${name}`);
          } else if (
            file.source !== undefined &&
            !new RegExp(`\\b${name}\\b`, "u").test(file.source)
          )
            problems.push(`${capability}: ${name} is not in ${file.name}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("cites only Rust test functions that exist", () => {
    // Outside the Rust tests column, a test name has at least three snake_case words.
    const names = cited
      .flatMap((text) => text.split(/\s+|\//u))
      .filter((name) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/u.test(name));
    const missing = [...new Set(names)].filter(
      (name) =>
        !name.startsWith("supertag_v2_") &&
        !testTargets.has(name) &&
        !new RegExp(`\\bfn ${name}\\b`, "u").test(rust),
    );
    expect(missing).toEqual([]);
  });

  it.skipIf(atFreeze === undefined)(
    "cites only paths that exist now or at the freeze commit",
    () => {
      const paths = cited.filter(
        (text) =>
          /^[\w.-]+(?:\/[\w.-]+)+\/?$/u.test(text) &&
          !text.includes("*") &&
          (/\.(?:ts|rs|py|go|mjs|md|json)$/u.test(text) || text.endsWith("/")),
      );
      const frozen = [...(atFreeze ?? [])];
      const existedAtFreeze = (path: string) =>
        path.endsWith("/") ? frozen.some((file) => file.startsWith(path)) : atFreeze?.has(path);
      const missing = paths.filter(
        (path) =>
          !existsSync(join(root, path)) &&
          !existsSync(join(crates, path)) &&
          !existsSync(join(crates, "cli/tests", path)) &&
          !existedAtFreeze(path),
      );
      // Design documents live in the gitignored contributing/ directory.
      expect(
        missing.filter(
          (path) => !path.startsWith("rust-port-") && !path.startsWith("contributing/"),
        ),
      ).toEqual([]);
      expect(paths.length).toBeGreaterThan(100);
    },
  );
});
