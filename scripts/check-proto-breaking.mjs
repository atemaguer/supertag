import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arguments_ = process.argv.slice(2);
const selfTest = arguments_.includes("--self-test");
const baseline = arguments_.find((argument) => argument !== "--self-test") ?? "a9b9c7f";
const revision = execFileSync("git", ["rev-parse", "--verify", `${baseline}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
execFileSync("pnpm", ["exec", "buf", "breaking", "--against", `.git#ref=${revision}`], {
  cwd: root,
  stdio: "inherit",
});
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
    const result = spawnSync(
      "pnpm",
      ["exec", "buf", "breaking", temporary, "--against", join(root, "spec/proto")],
      { cwd: root, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 100 || !output.includes('changed type from "string" to "uint64"')) {
      throw new Error(
        `Breaking-gate negative control did not detect the incompatible field: ${output}`,
      );
    }
    process.stdout.write("Breaking gate rejected an incompatible field type as expected.\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
