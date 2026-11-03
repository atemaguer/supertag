import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostServiceWorklet, workletVolumeResolver } from "../apps/cli/src/worker.js";
import {
  artifactVolumeGuard,
  dispatchedWorkspacePlan,
} from "../packages/control-plane/src/label-placement.js";
import { artifactVolumeLabel, type TaskNamedWorkspacePlan } from "../packages/core/src/index.js";
import {
  pinWorkspaceVolumes,
  planWorkspaceMounts,
} from "../packages/runtime/sdk/src/volume-copy.js";
import { decodeTaskAttemptSpec } from "../packages/runtime/transport/src/attempt-codec.js";
import { repositoryAttempt } from "./support/repository-execution.js";

// This suite isolates artifact protection from the independent ban on Task-writable sources.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "artifact-alias-")));
  await mkdir(join(scratch, "artifacts", "sha256"), { recursive: true });
});
afterEach(async () => rm(scratch, { recursive: true, force: true }));

function catalog(recorded = false) {
  const volumes = [
    { id: "art", name: "artifacts", source: `file://${scratch}/artifacts`, credential: "private" },
    { id: "data", name: "data", source: `file://${scratch}/alias`, credential: "data" },
  ];
  return {
    listVolumes: async () => volumes,
    findVolumeByName: async (name: string) => volumes.find((volume) => volume.name === name),
    listWorkerHosts: async () => [
      {
        labels: [],
        workerSnapshot: { labels: recorded ? [] : [artifactVolumeLabel("artifacts")] },
      },
    ],
    listVolumeIdsHoldingArtifacts: async () => (recorded ? ["art"] : []),
  };
}

it.each([false, true])(
  "S1 Control Plane refuses real-path aliases (recorded=%s)",
  async (recorded) => {
    await symlink(join(scratch, "artifacts"), join(scratch, "alias"));
    const guard = await artifactVolumeGuard(catalog(recorded));
    for (const path of ["alias", "alias/sha256", "alias/missing/child", ""])
      expect(guard("data", `file://${scratch}/${path}`)).toMatch(
        /overlaps artifact Volume artifacts/u,
      );
    expect(guard("data", `file://${scratch}/artifacts-sibling`)).toBeUndefined();
  },
);

it.each([false, true])(
  "S1 dispatch protects another host's artifact path on the consuming host (recorded=%s)",
  async (recorded) => {
    // The alias does not exist on the Control Plane. On host B it points into host A's Volume.
    const plan: TaskNamedWorkspacePlan = {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: "supertag/o/t",
      delivery: "branch",
      mounts: [{ volume: "data", path: "/mnt/data", access: "read-only", strategy: "copy" }],
    };
    const dispatched = await dispatchedWorkspacePlan(catalog(recorded), plan);
    const decoded = decodeTaskAttemptSpec({
      ...repositoryAttempt("alias"),
      workspacePlan: dispatched,
    });
    if (decoded.workspacePlan?.status !== "workspace") throw new Error("missing workspace plan");
    const task = { taskId: "t", attemptId: "a", volumes: decoded.workspacePlan.volumes };
    await symlink(join(scratch, "artifacts"), join(scratch, "alias"));
    // B has no artifact Volume of its own, but has exact host consent to read the alias.
    const resolver = workletVolumeResolver(
      { readVolumeCredential: async () => ({ path: scratch }) },
      join(scratch, "b-state"),
    );
    await expect(resolver.resolve("data", task)).rejects.toThrow(
      /overlaps.*(?:artifact|protected)/u,
    );
    expect(task.volumes).toContainEqual({
      name: "artifacts",
      source: `file://${scratch}/artifacts`,
    });
    expect(task.volumes?.find((volume) => volume.name === "artifacts")).not.toHaveProperty(
      "credential",
    );
  },
);

it.each([undefined, "configured"])(
  "L3 built-in hosts already restrict artifact labels to configuration (%s)",
  async (configured) => {
    expect(
      () =>
        new HostServiceWorklet(
          "w",
          "h",
          [],
          {
            labels: ["gpu", artifactVolumeLabel("forged")],
          },
          [],
        ),
    ).toThrow(/labels come from host service configuration/u);
    const worklet = new HostServiceWorklet(
      "w",
      "h",
      [],
      {
        labels: ["gpu"],
      },
      [],
      undefined,
      undefined,
      configured,
    );
    const expected = configured ? [artifactVolumeLabel(configured)] : [];
    const labels = (await worklet.describe()).host.labels ?? [];
    expect(labels).toContain("gpu");
    expect(labels.filter((label) => label.startsWith("artifact-volume:"))).toEqual(expected);
    expect(
      (await worklet.hostLabels()).filter((label) => label.startsWith("artifact-volume:")),
    ).toEqual(expected);
  },
);

it("S1 preserves protected paths through pinning and rechecks them before copying", async () => {
  const data = join(scratch, "data");
  const protectedAlias = join(scratch, "protected-alias");
  await mkdir(data);
  await symlink(join(scratch, "artifacts"), protectedAlias);
  const volumes = [
    { name: "data", source: `file://${data}`, credential: "data" },
    { name: "artifacts", source: `file://${protectedAlias}` },
  ];
  const task = { taskId: "t", attemptId: "a", volumes };
  const mounts = [
    { volume: "data", path: "/mnt/data", access: "read-only", strategy: "copy" },
  ] as const;
  const pinned = await pinWorkspaceVolumes({
    mounts,
    task,
    volumes: workletVolumeResolver(
      { readVolumeCredential: async () => ({ path: scratch }) },
      join(scratch, "state"),
    ),
  });
  // The artifact path changes after pinning. A pinned resolver must retain its protection.
  await rm(protectedAlias);
  await symlink(data, protectedAlias);
  await expect(planWorkspaceMounts({ mounts, task, volumes: pinned })).rejects.toThrow(
    /overlaps.*SuperTag/u,
  );
});
