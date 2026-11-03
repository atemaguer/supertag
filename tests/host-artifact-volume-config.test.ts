import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostServiceStorageWarnings } from "../apps/cli/src/storage-durability.js";
import {
  loadServicesFile,
  renderServicesFile,
  SupertagYamlError,
  serviceFingerprint,
} from "../apps/cli/src/supertag-yaml.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "supertag-artifact-volume-config-"));
  vi.stubEnv("HOME", join(directory, "home"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function host(extra: string): Promise<string> {
  const root = join(directory, "config");
  await mkdir(root, { recursive: true });
  const path = join(root, "supertag.yaml");
  await writeFile(
    path,
    `services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev
    harnesses: [codex]
${extra}`,
  );
  return path;
}

describe("a host service's artifact-volume", () => {
  it("names the Volume its artifacts are stored on, next to volume-credentials", async () => {
    const file = await loadServicesFile({
      files: [
        await host(`    artifact-volume: team-artifacts
    volume-credentials:
      team: { environment: TEAM_ARTIFACTS_KEY }
`),
      ],
    });
    expect(file.services[0]).toMatchObject({
      artifactVolume: "team-artifacts",
      volumeCredentials: { team: { environment: "TEAM_ARTIFACTS_KEY" } },
    });
    expect(renderServicesFile(file)).toContain("artifact-volume: team-artifacts");
    // Changing where artifacts are stored restarts the host.
    const local = await loadServicesFile({ files: [await host("")] });
    expect(local.services[0]).not.toHaveProperty("artifactVolume");
    expect(renderServicesFile(local)).not.toMatch(/^\s+artifact-volume:/mu);
    expect(serviceFingerprint(file, file.services[0] as never)).not.toBe(
      serviceFingerprint(local, local.services[0] as never),
    );
  });

  it("refuses a name that is not a Volume name", async () => {
    const problems = await loadServicesFile({
      files: [await host("    artifact-volume: Team Artifacts\n")],
    }).then(
      () => [],
      (error: unknown) => (error instanceof SupertagYamlError ? error.problems : [String(error)]),
    );
    expect(problems).toEqual([
      expect.stringMatching(/artifact-volume.*must be 1-63 lowercase letters/u),
    ]);
  });

  it("warns that only an ephemeral host without an artifact Volume loses its artifacts", () => {
    expect(hostServiceStorageWarnings({ name: "cloud" }, true)).toEqual([
      expect.stringContaining("the Control Plane keeps no copy of its artifacts"),
    ]);
    expect(
      hostServiceStorageWarnings({ name: "cloud", artifactVolume: "team-artifacts" }, true),
    ).toEqual([
      expect.stringContaining("artifacts its Tasks capture are kept on Volume team-artifacts"),
    ]);
    expect(
      hostServiceStorageWarnings(
        { name: "cloud", artifactVolume: "team-artifacts", environment: { provider: "modal" } },
        false,
      ),
    ).toEqual([
      "Warning: host service cloud runs Tasks in modal sandboxes. Ephemeral storage: Task files in modal sandboxes are lost when each sandbox stops; artifacts its Tasks capture are kept on Volume team-artifacts.",
    ]);
  });
});
