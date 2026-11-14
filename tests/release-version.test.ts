import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
// rust/Cargo.toml's workspace version is the single source of truth for the release version.
const workspaceVersion = /^\[workspace\.package\]\n(?:[^[\n].*\n)*?version = "([^"]+)"/m.exec(
  read("rust/Cargo.toml"),
)?.[1];
const newestVersion = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(read("CHANGELOG.md"))?.[1];

test("the newest changelog version is the Rust workspace version", () => {
  expect(workspaceVersion).toBeDefined();
  expect(newestVersion).toBe(workspaceVersion);
});

test("the newest release is the first heading below Unreleased", () => {
  expect(newestVersion).toBeDefined();
  expect(read("CHANGELOG.md")).toMatch(
    new RegExp(
      `^## \\[Unreleased\\]\\n(?:(?!## \\[)[\\s\\S])*## \\[${newestVersion?.replace(/\./g, "\\.")}\\]( - \\d{4}-\\d{2}-\\d{2})?\\n`,
      "m",
    ),
  );
});

for (const path of tracked.filter((path) => /(^|\/)package\.json$/.test(path))) {
  test(`${path} matches the Rust workspace version`, () => {
    expect(workspaceVersion).toBeDefined();
    expect(JSON.parse(read(path)).version).toBe(workspaceVersion);
  });
}

test("the Python SDK and lockfile match the Rust workspace version", () => {
  const version = /^version = "([^"]+)"/m.exec(read("sdks/python/pyproject.toml"))?.[1];
  expect(version).toBe(workspaceVersion);
  const locked = /\[\[package\]\]\nname = "supertag"\nversion = "([^"]+)"/.exec(
    read("sdks/python/uv.lock"),
  )?.[1];
  expect(locked).toBe(workspaceVersion?.replace(/-alpha\.(\d+)$/, "a$1"));
  for (const path of tracked.filter(
    (path) => path.startsWith("sdks/python/src/") && path.endsWith(".py"),
  )) {
    const exported = /^__version__\s*=\s*["']([^"']+)["']/m.exec(read(path));
    if (exported) expect(exported[1], path).toBe(workspaceVersion);
  }
});
