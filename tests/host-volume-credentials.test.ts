import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { runHostService } from "../apps/cli/src/host-service.js";
import { hostCredentialPath } from "../apps/cli/src/local-state.js";
import { loadServicesFile } from "../apps/cli/src/supertag-yaml.js";
import { writeWorkerHostCredential } from "../apps/cli/src/worker-hosts.js";
import { volumeCredentialLabel } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("advertises host consent for copy and native Volume credential mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-volume-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("DATASET_TOKEN", "host-only-test-value");
  await migrateDatabase({ url: databaseUrl });
  const runtime = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl,
    workletTransport: "remote",
    adminToken: "host-volume-admin",
  });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const controller = new AbortController();
  const output: string[] = [];
  let running: Promise<void> | undefined;
  try {
    const token = await enrollWorkerHost(runtime.url, "host-volume-admin", "volume-host");
    await writeWorkerHostCredential(hostCredentialPath("laptop"), {
      version: 1,
      workerHostId: "volume-host",
      token,
      controlPlane: runtime.url,
    });
    const config = join(directory, "config", "supertag.yaml");
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "data"));
    await writeFile(join(directory, "config", "volume-secret"), "file-only-test-value");
    await writeFile(
      config,
      `services:
  laptop:
    type: host
    control-plane: ${runtime.url}
    harnesses: [codex]
    local-mount-root: ../data
    volume-credentials:
      team-data: { modal-volume: Training }
      bucket-data: { modal-secret: dataset-access }
      datasets: { environment: DATASET_TOKEN }
      archive: { file: ./volume-secret }
      local: { path: ../data }
`,
    );
    const file = await loadServicesFile({ files: [config] });
    const service = file.services.find((entry) => entry.type === "host");
    if (!service) throw new Error("missing host service");
    running = runHostService({
      file,
      service,
      mode: "foreground",
      signal: controller.signal,
      write: (text) => {
        output.push(text);
      },
      checkModels: async () => ({ status: "ok" }),
    });
    await expect
      .poll(async () => (await store.findWorkerHostById("volume-host"))?.labels ?? [], {
        timeout: 10_000,
      })
      .toEqual(
        expect.arrayContaining(
          ["team-data", "bucket-data", "datasets", "archive", "local"].map(volumeCredentialLabel),
        ),
      );
    const publicState = JSON.stringify(await store.findWorkerHostById("volume-host"));
    for (const secret of [
      "host-only-test-value",
      "file-only-test-value",
      "Training",
      "dataset-access",
    ]) {
      expect(publicState).not.toContain(secret);
      expect(output.join("\n")).not.toContain(secret);
    }
  } finally {
    controller.abort();
    await running;
    await store.disconnect();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
