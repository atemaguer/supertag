import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const exceptionsPath = join(root, "spec/proto/accepted-breaking-changes.json");
const arguments_ = process.argv.slice(2);
const selfTest = arguments_.includes("--self-test");
const baseline =
  arguments_.find((argument) => argument !== "--self-test") ??
  execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
const revision = execFileSync("git", ["rev-parse", "--verify", `${baseline}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();

const exceptions = JSON.parse(await readFile(exceptionsPath, "utf8"));
if (typeof exceptions.against !== "string" || !Array.isArray(exceptions.changes))
  throw new Error(`${exceptionsPath} needs a string "against" and a "changes" list`);
const exceptionRevision = execFileSync(
  "git",
  ["rev-parse", "--verify", `${exceptions.against}^{commit}`],
  { cwd: root, encoding: "utf8" },
).trim();
const accepted = exceptionRevision === revision ? exceptions.changes : [];

const result = spawnSync(
  "pnpm",
  ["exec", "buf", "breaking", "--against", `.git#ref=${revision}`, "--error-format=json"],
  { cwd: root, encoding: "utf8" },
);
if (result.error) throw result.error;
if (result.status !== 0 && result.status !== 100) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const found = result.stdout
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const matches = (change, finding) =>
  change.type === finding.type &&
  change.message === finding.message &&
  (change.path === undefined || change.path === finding.path);
const unaccepted = found.filter((finding) => !accepted.some((change) => matches(change, finding)));
const stale = accepted.filter((change) => !found.some((finding) => matches(change, finding)));
for (const finding of unaccepted) {
  const location = finding.path === undefined ? "" : `${finding.path}:${finding.start_line}: `;
  process.stderr.write(`${location}${finding.type}: ${finding.message}\n`);
}
for (const change of stale)
  process.stderr.write(
    `Accepted breaking change no longer occurs; remove it: ${change.type}: ${change.message}\n`,
  );
if (unaccepted.length > 0 || stale.length > 0) {
  process.stderr.write(
    `buf breaking against ${baseline} (${revision.slice(0, 7)}) failed. Accept a deliberate ` +
      `pre-release break in ${exceptionsPath.slice(root.length + 1)}.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `No unaccepted breaking changes against ${baseline} (${accepted.length} accepted).\n`,
);

if (selfTest) {
  const temporary = await mkdtemp(join(tmpdir(), "supertag-breaking-"));
  try {
    await cp(join(root, "spec/proto"), join(temporary, "proto"), { recursive: true });
    await cp(join(root, "buf.yaml"), join(temporary, "buf.yaml"));
    const config = await readFile(join(temporary, "buf.yaml"), "utf8");
    await writeFile(join(temporary, "buf.yaml"), config.replace("path: spec/proto", "path: proto"));
    const path = join(temporary, "proto/supertag/environment/v1/environment.proto");
    const schema = await readFile(path, "utf8");
    if (!schema.includes("string access_id = 2;"))
      throw new Error("Breaking-gate fixture no longer matches the schema");
    await writeFile(path, schema.replace("string access_id = 2;", "uint64 access_id = 2;"));
    const negative = spawnSync(
      "pnpm",
      ["exec", "buf", "breaking", temporary, "--against", join(root, "spec/proto")],
      { cwd: root, encoding: "utf8" },
    );
    if (negative.error) throw negative.error;
    const output = `${negative.stdout}\n${negative.stderr}`;
    if (negative.status !== 100 || !output.includes('changed type from "string" to "uint64"')) {
      throw new Error(
        `Breaking-gate negative control did not detect the incompatible field: ${output}`,
      );
    }
    process.stdout.write("Breaking gate rejected an incompatible field type as expected.\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
