import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostSecretPaths } from "../apps/cli/src/host-service.js";
import { loadServicesFile, readVolumeCredential } from "../apps/cli/src/supertag-yaml.js";
import { workletVolumeResolver } from "../apps/cli/src/worker.js";

let scratch: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it("refuses the removed Control Plane artifact settings", async () => {
  scratch = await mkdtemp(join(tmpdir(), "cp-artifact-settings-"));
  for (const settings of [
    "    artifacts: { volume: artifacts }\n",
    "    volume-credentials:\n      artifact-keys: { environment: ARTIFACT_KEYS }\n",
  ]) {
    const yaml = join(scratch, "supertag.yaml");
    await writeFile(yaml, `services:\n  control-plane:\n    type: control-plane\n${settings}`);
    await expect(loadServicesFile({ files: [yaml] })).rejects.toThrow(
      /artifacts|volume-credentials/u,
    );
  }
});

it("allows host consent directories that do not overlap Control Plane storage", async () => {
  scratch = await mkdtemp(join(tmpdir(), "cp-safe-volume-"));
  const shared = join(scratch, "shared");
  await mkdir(shared);
  const yaml = join(scratch, "supertag.yaml");
  await writeFile(
    yaml,
    `services:
  control-plane:
    type: control-plane
  laptop:
    type: host
    harnesses: [codex]
    volume-credentials:
      share: { path: ${shared} }
  other:
    type: host
    harnesses: [codex]
    volume-credentials:
      share: { path: ${shared} }
`,
  );
  const file = await loadServicesFile({ files: [yaml] });
  const host = file.services.find((service) => service.name === "laptop");
  if (host?.type !== "host") throw new Error("missing host");
  const source = `file://${shared}`;
  await expect(
    workletVolumeResolver(
      {
        readVolumeCredential: (name) => readVolumeCredential(file, host, name),
        volumeProtectedPaths: hostSecretPaths(file),
      },
      join(scratch, "host-state"),
    ).resolve("share", {
      taskId: "t",
      attemptId: "a",
      volumes: [{ name: "share", source, credential: "share" }],
    }),
  ).resolves.toMatchObject({ volume: "share", source });
});

it.each([
  "other host credential file",
  "Control Plane TLS key",
  "Control Plane operators file",
  "Control Plane SQLite database",
  "Control Plane SQLite WAL",
  "Control Plane SQLite SHM",
  "Worker Host artifact copies",
  "Worker Host artifact copies through a symlink",
])("refuses a host Volume overlapping %s", async (kind) => {
  scratch = await mkdtemp(join(tmpdir(), "cp-paths-"));
  const shared = join(scratch, "shared");
  const state = join(scratch, "state");
  const artifacts = join(state, "artifacts");
  await mkdir(join(shared, "nested"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  vi.stubEnv("SUPERTAG_STATE_DIR", state);
  const secret = join(shared, "secret");
  await writeFile(secret, "cp-private-canary");
  let source = shared;
  let cpSettings = "";
  let otherService = "";
  if (kind === "other host credential file") {
    otherService = `
  other:
    type: host
    harnesses: [codex]
    volume-credentials:
      private: { file: ${secret} }
`;
  } else if (kind === "Control Plane TLS key") {
    cpSettings = `    hosts: { grpc: "127.0.0.1:7443" }\n    tls: { cert: ${join(scratch, "cert.pem")}, key: ${secret} }\n`;
  } else if (kind === "Control Plane operators file") {
    cpSettings = `    operators: { file: ${secret} }\n`;
  } else if (kind.startsWith("Control Plane SQLite")) {
    const database = join(shared, "cp.db");
    cpSettings = `    database: { url: "file:${database}" }\n`;
    const suffix = kind.endsWith("WAL") ? "-wal" : kind.endsWith("SHM") ? "-shm" : "";
    await writeFile(`${database}${suffix}`, "cp-database-canary");
    // Sidecars alone must remain protected, including when the database does not exist yet.
    if (suffix) source = `${database}${suffix}`;
  } else if (kind.endsWith("symlink")) {
    // A Workspace mount of this host's artifact copies would bypass artifact grants.
    source = join(scratch, "alias");
    await symlink(artifacts, source);
  } else {
    source = artifacts;
  }
  const yaml = join(scratch, "supertag.yaml");
  await writeFile(
    yaml,
    `services:
  control-plane:
    type: control-plane
${cpSettings}  laptop:
    type: host
    harnesses: [codex]
    volume-credentials:
      share: { path: ${kind.startsWith("Control Plane SQLite") ? shared : source} }
${otherService}`,
  );
  const file = await loadServicesFile({ files: [yaml] });
  const host = file.services.find((service) => service.name === "laptop");
  if (host?.type !== "host") throw new Error("missing host");
  const resolver = workletVolumeResolver(
    {
      readVolumeCredential: (name) => readVolumeCredential(file, host, name),
      volumeProtectedPaths: hostSecretPaths(file),
    },
    join(scratch, "host-state"),
  );
  await expect(
    resolver.resolve("share", {
      taskId: "t",
      attemptId: "a",
      volumes: [{ name: "share", source: `file://${source}`, credential: "share" }],
    }),
  ).rejects.toThrow(/overlaps a protected Worker Host directory/u);
});
