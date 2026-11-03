import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ModalClient } from "modal";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const output = await mkdtemp(join(tmpdir(), "supertag-codex-modal-live-"));
const version = await pinnedCodexVersion();
const client = new ModalClient();
const app = await client.apps.fromName("supertag-conformance", { createIfMissing: true });
const image = await client.images
  .fromRegistry("node:24-bookworm-slim")
  .dockerfileCommands([
    "RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git python3 && rm -rf /var/lib/apt/lists/*",
    `RUN npm install --global --no-audit --no-fund @openai/codex@${version} && codex --version`,
  ])
  .build(app);

try {
  const run = await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions=development",
      "scripts/codex-native-conformance.ts",
      "--live",
      "--split",
      "--backend",
      "modal",
      "--image-id",
      image.imageId,
      "--output",
      output,
    ],
    { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024, timeout: 360_000 },
  );
  const report = JSON.parse(run.stdout) as {
    backend: string;
    split: boolean;
    reports: readonly {
      verification: string;
      manifest: { manifest: { executionEnvironment: { provenance?: Record<string, unknown> } } };
    }[];
  };
  if (report.backend !== "modal" || report.split !== true)
    throw new Error("Modal Codex conformance did not use split execution");
  if (report.reports[0]?.verification !== "VERIFIED")
    throw new Error("Modal Codex conformance did not verify exported workspace results");
  const provenance = report.reports[0]?.manifest.manifest.executionEnvironment.provenance;
  if (typeof provenance?.["sandboxId"] !== "string")
    throw new Error("Modal Codex conformance did not record sandbox provenance");
  console.log(
    JSON.stringify({
      provider: "modal",
      split: true,
      codexVersion: version,
      sandboxId: provenance["sandboxId"],
      verification: "VERIFIED",
    }),
  );
} finally {
  await client.images.delete(image.imageId).catch(() => undefined);
  client.close();
  await rm(output, { recursive: true, force: true });
}

async function pinnedCodexVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../harnesses/codex/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const value = manifest.dependencies?.["@openai/codex-sdk"];
  if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value))
    throw new Error("Codex Harness must pin an exact SDK version for split conformance");
  return value;
}
