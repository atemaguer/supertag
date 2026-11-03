import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "supertag-proto-"));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}
try {
  let template = await readFile("buf.gen.yaml", "utf8");
  const destinations = [
    ...new Set([...template.matchAll(/^\s+out: (\S+)$/gm)].map((match) => match[1])),
  ];
  if (!destinations.length) throw new Error("No protobuf output directories configured");
  const outputs = destinations.map((destination, index) => ({
    destination,
    temporary: join(temporary, String(index)),
  }));
  for (const output of outputs)
    template = template.replaceAll(`out: ${output.destination}`, `out: ${output.temporary}`);
  execFileSync("buf", ["generate", "--template", template], { stdio: "inherit" });
  for (const output of outputs) {
    const generated = (await files(output.temporary))
      .map((path) => relative(output.temporary, path))
      .sort();
    const checkedIn = (await files(output.destination))
      .map((path) => relative(output.destination, path))
      .sort();
    if (JSON.stringify(generated) !== JSON.stringify(checkedIn))
      throw new Error(
        `Generated protobuf file inventory differs in ${output.destination}; run pnpm proto:generate`,
      );
    for (const path of generated) {
      const [expected, actual] = await Promise.all([
        readFile(join(output.temporary, path)),
        readFile(resolve(output.destination, path)),
      ]);
      if (!expected.equals(actual))
        throw new Error(`Stale protobuf binding: ${path}; run pnpm proto:generate`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
