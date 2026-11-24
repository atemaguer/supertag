import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const bundler = resolve(import.meta.dirname, "bundle-node-bridge.mjs");

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A bridge package with one bundled dependency, one CommonJS one, and one that stays external. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "supertag-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "bridge");
  write(
    join(source, "dist/rust-adapter/entry.js"),
    'import { greet } from "inside";\nimport { name } from "outside";\nimport { where } from "../shared.js";\n' +
      "console.log(JSON.stringify({ greeting: greet(), name, where, self: import.meta.url }));\n",
  );
  write(
    join(source, "dist/runner.js"),
    'import { where } from "./shared.js";\nconsole.log(where);\n',
  );
  write(
    join(source, "dist/shared.js"),
    'export const where = new URL("./runner.js", import.meta.url).href;\n',
  );
  const modules = join(source, "node_modules");
  write(
    join(modules, "inside/package.json"),
    JSON.stringify({ name: "inside", version: "1.2.3", license: "MIT", main: "index.js" }),
  );
  write(
    join(modules, "inside/index.js"),
    'const { basename } = require("node:path");\nconst legacy = require("legacy");\n' +
      'exports.greet = () => legacy.word + " " + basename("/a/there");\n',
  );
  write(join(modules, "inside/LICENSE"), "MIT License\nCopyright (c) Inside Authors\n");
  write(join(modules, "inside/NOTICE.md"), "Inside notice\n");
  write(
    join(modules, "legacy/package.json"),
    JSON.stringify({ name: "legacy", version: "0.1.0", licenses: [{ type: "ISC" }] }),
  );
  write(join(modules, "legacy/index.js"), 'module.exports = { word: "hello" };\n');
  write(
    join(modules, "outside/package.json"),
    JSON.stringify({ name: "outside", version: "9.0.0", type: "module", exports: "./index.js" }),
  );
  write(join(modules, "outside/index.js"), 'export const name = "external";\n');
  write(join(modules, "outside/LICENSE"), "Proprietary\n");
  return { root, source, modules };
}

function bundle(source, output, ...extra) {
  return spawnSync(
    process.execPath,
    [
      bundler,
      "--package",
      source,
      "--output",
      output,
      "--entry",
      "dist/rust-adapter/entry.js",
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

test("bundles each entry into one file beside the others and reports what stays an import", (t) => {
  const { root, source, modules } = fixture(t);
  const output = join(root, "stage");
  const result = bundle(source, output, "--entry", "dist/runner.js", "--external", "outside");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { packages: 2, imports: ["outside"] });
  assert.deepEqual(readdirSync(output).sort(), [
    "THIRD-PARTY-NOTICES.txt",
    "entry.js",
    "package.json",
    "runner.js",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "package.json"), "utf8")), {
    private: true,
    type: "module",
  });
  // The staged bridge resolves the external package from its own node_modules, a bundled
  // CommonJS dependency reaches Node's built-in modules, and a file the bridge locates beside
  // its own module is found beside the bundled entry.
  write(
    join(output, "node_modules/outside/package.json"),
    readFileSync(join(modules, "outside/package.json")),
  );
  write(
    join(output, "node_modules/outside/index.js"),
    readFileSync(join(modules, "outside/index.js")),
  );
  const run = spawnSync(process.execPath, [join(output, "entry.js")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const printed = JSON.parse(run.stdout);
  assert.equal(printed.greeting, "hello there");
  assert.equal(printed.name, "external");
  assert.equal(printed.where, new URL("./runner.js", printed.self).href);
  assert.ok(printed.self.endsWith("/entry.js"));
});

test("the notices name every bundled package with its license files, and no external one", (t) => {
  const { root, source } = fixture(t);
  const output = join(root, "stage");
  assert.equal(bundle(source, output, "--external", "outside").status, 0);
  const notices = readFileSync(join(output, "THIRD-PARTY-NOTICES.txt"), "utf8");
  assert.match(notices, /code from the 2 open-source packages below/);
  assert.match(
    notices,
    /inside@1\.2\.3\nLicense: MIT\n\n--- LICENSE ---\nMIT License\nCopyright \(c\) Inside Authors\n/,
  );
  assert.match(notices, /--- NOTICE\.md ---\nInside notice\n/);
  assert.match(notices, /legacy@0\.1\.0\nLicense: ISC\n\n\(The package ships no license file/);
  assert.doesNotMatch(notices, /outside|Proprietary/);
});

test("an import that is neither bundled nor external stops the build", (t) => {
  const { root, source, modules } = fixture(t);
  rmSync(join(modules, "legacy"), { recursive: true });
  const result = bundle(source, join(root, "stage"), "--external", "outside");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not resolve "legacy"/);
});
