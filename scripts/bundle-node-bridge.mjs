// Bundle one Node bridge's compiled entries into single files, for scripts/node_bridges.py.
//
//   node scripts/bundle-node-bridge.mjs --package DIR --output DIR --entry dist/a.js [--entry ...]
//                                       [--external NAME ...]
//
// Each entry becomes OUTPUT/<its file name>, holding the bridge's own code and every dependency
// except the --external packages, which stay imports that Node resolves from OUTPUT/node_modules.
// OUTPUT/THIRD-PARTY-NOTICES.txt carries the license of every package whose code is in a bundle.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

// A bundled CommonJS dependency reaches Node's built-in modules through require, which an ES
// module lacks. The names are unlikely ones because the banner shares the bundle's scope.
const BANNER =
  'import { createRequire as __supertagCreateRequire } from "node:module";\n' +
  "const require = __supertagCreateRequire(import.meta.url);";
const NOTICE_FILE = /^(licen[cs]e|notice|copying)([.-].*)?$/i;

/** The directory of the package that owns `file`: the nearest one whose package.json names it. */
function packageRoot(file) {
  for (
    let directory = dirname(file);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    const metadata = JSON.parse(readFileSync(manifest, "utf8"));
    if (metadata.name && metadata.version) return { directory, metadata };
  }
  throw new Error(`no package owns ${file}`);
}

function licenseName(metadata) {
  const license = metadata.license ?? metadata.licenses;
  if (typeof license === "string") return license;
  if (Array.isArray(license)) return license.map((entry) => entry.type ?? entry).join(" OR ");
  return license?.type ?? "not declared in its package.json";
}

/** Every third-party package with code in the bundles, each with its license files. */
function notices(inputs, workspace) {
  const packages = new Map();
  for (const input of inputs) {
    const file = realpathSync(resolve(workspace, input));
    if (!file.includes(`${sep}node_modules${sep}`)) continue;
    const { directory, metadata } = packageRoot(file);
    packages.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
  }
  const sections = [...packages.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, { directory, metadata }]) => {
      const texts = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && NOTICE_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .map((file) => `--- ${file} ---\n${readFileSync(join(directory, file), "utf8").trim()}\n`);
      const homepage =
        typeof metadata.homepage === "string" ? `\nHomepage: ${metadata.homepage}` : "";
      return [
        "=".repeat(80),
        `${name}\nLicense: ${licenseName(metadata)}${homepage}\n`,
        ...(texts.length
          ? texts
          : ["(The package ships no license file; its package.json names the license above.)\n"]),
      ].join("\n");
    });
  return { count: packages.size, text: sections.join("\n") };
}

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    output: { type: "string" },
    entry: { type: "string", multiple: true },
    external: { type: "string", multiple: true, default: [] },
  },
});
if (!values.package || !values.output || !values.entry?.length)
  throw new Error("--package, --output and at least one --entry are required");
const source = resolve(values.package);
const output = resolve(values.output);
const entries = values.entry.map((entry) => join(source, entry));
if (new Set(entries.map((entry) => basename(entry))).size !== entries.length)
  throw new Error("entries must have distinct file names");
mkdirSync(output, { recursive: true });
const result = await build({
  absWorkingDir: source,
  entryPoints: entries,
  outdir: output,
  entryNames: "[name]",
  bundle: true,
  // One self-contained file per entry: each is a process entry point that asks whether it is
  // the main module, and a shared chunk would answer for the wrong file.
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node22.13",
  // Resolve exactly as Node does, so a bundle holds the files Node would have loaded: no
  // "module" condition or field, which only bundlers read.
  conditions: [],
  mainFields: ["main"],
  external: values.external.flatMap((name) => [name, `${name}/*`]),
  banner: { js: BANNER },
  legalComments: "inline",
  charset: "utf8",
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: "warning",
});
if (result.warnings.length)
  throw new Error("the bundler reported warnings; resolve them before packaging");
// Mark the bundles as ES modules whatever directory they are installed under.
writeFileSync(
  join(output, "package.json"),
  `${JSON.stringify({ private: true, type: "module" })}\n`,
);
const third = notices(Object.keys(result.metafile.inputs), source);
writeFileSync(
  join(output, "THIRD-PARTY-NOTICES.txt"),
  `The files in this directory include code from the ${third.count} open-source packages below.\n` +
    "Packages under node_modules/, if any, are unmodified and carry their own licenses.\n\n" +
    `${third.text}`,
);
// What the bundles still import from packages at run time, for the caller to check against
// --external.
const imported = new Set();
for (const file of Object.values(result.metafile.outputs))
  for (const entry of file.imports)
    if (entry.external && !isBuiltin(entry.path)) imported.add(entry.path);
process.stdout.write(
  `${JSON.stringify({ packages: third.count, imports: [...imported].sort() })}\n`,
);
