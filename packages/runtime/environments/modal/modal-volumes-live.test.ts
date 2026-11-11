import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  bundleTrustedCommit,
  type EnvironmentPlan,
  type ExecutionEnvironment,
  type PreparedWorkspace,
  type VolumeResolver,
  workspaceDefinition,
} from "@supertag/worker-sdk";
import { ModalClient, type Sandbox } from "modal";
import { expect, it } from "vitest";
import { ModalWorkspaceEnvironment } from "./src/index.js";

const git = promisify(execFile);
const plan: EnvironmentPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};

it.skipIf(process.env["SUPERTAG_LIVE_MODAL"] !== "1" || Boolean(process.env["CI"]))(
  "mounts Modal Volumes in a Workspace and recovers writable output in a new sandbox",
  async () => {
    const client = new ModalClient();
    const appName = process.env["SUPERTAG_LIVE_MODAL_APP"] ?? "supertag-conformance";
    const suffix = randomUUID().slice(0, 8);
    const inputName = `supertag-volumes-live-${suffix}-input`;
    const outputName = `supertag-volumes-live-${suffix}-output`;
    const createdVolumes: string[] = [];
    const scratch = await mkdtemp(join(tmpdir(), "supertag-modal-volumes-"));
    const stagingDirectory = join(scratch, "staging");
    const environment = new ModalWorkspaceEnvironment({
      appName,
      stagingDirectory,
      memoryMiB: 512,
      sandboxTimeoutMs: 180_000,
      setupTimeoutMs: 180_000,
      snapshotTtlMs: 3_600_000,
    });
    let seed: Sandbox | undefined;
    let prepared: PreparedWorkspace | undefined;
    let active: ExecutionEnvironment | undefined;

    try {
      const app = await client.apps.fromName(appName, { createIfMissing: true });
      const input = await client.volumes.fromName(inputName, { createIfMissing: true });
      createdVolumes.push(inputName);
      const output = await client.volumes.fromName(outputName, { createIfMissing: true });
      createdVolumes.push(outputName);
      console.log(JSON.stringify({ volumes: createdVolumes }));
      seed = await client.sandboxes.create(app, client.images.fromRegistry("python:3.13-slim"), {
        command: ["sleep", "infinity"],
        timeoutMs: 180_000,
        volumes: { "/data/input": input, "/data/output": output },
      });
      const fixture = await seed.exec([
        "python3",
        "-c",
        `from pathlib import Path
root = Path('/data')
(root / 'input/dataset').mkdir()
(root / 'output/results').mkdir()
(root / 'input/dataset/fixture.txt').write_text('input fixture')
(root / 'input/private.txt').write_text('outside the selected prefix')
`,
      ]);
      expect(await fixture.wait()).toBe(0);
      await seed.terminate({ wait: true });
      seed = undefined;

      await mkdir(stagingDirectory);
      await git("git", ["init", "-q", scratch]);
      await git("git", [
        "-C",
        scratch,
        "-c",
        "user.name=SuperTag",
        "-c",
        "user.email=supertag@localhost",
        "commit",
        "--allow-empty",
        "-qm",
        "Fixture",
      ]);
      const commit = (await git("git", ["-C", scratch, "rev-parse", "HEAD"])).stdout.trim();
      prepared = await environment.prepare(
        workspaceDefinition({
          workspace: "modal-volumes",
          source: "https://example.invalid/modal-volumes.git",
          trustedCommit: commit,
          content: await bundleTrustedCommit({
            repository: scratch,
            trustedCommit: commit,
            directory: stagingDirectory,
          }),
          // A unique trusted layer keeps cleanup from deleting a base shared with another run.
          harness: { commands: ["sh"], install: `: modal-volume-probe-${suffix}` },
          taskId: "modal-volumes",
        }),
      );
      const mounts = [
        { volume: "input", path: "/mnt/input", strategy: "mount", access: "read-only" },
        { volume: "output", path: "/mnt/output", strategy: "mount", access: "read-write" },
      ] as const;
      const volumes: VolumeResolver = {
        async resolve() {
          throw new Error("This Workspace uses native mounts");
        },
        async resolveMount(volume) {
          const isInput = volume === "input";
          const name = isInput ? inputName : outputName;
          return {
            volume,
            source: `modal-volume://${name}/${isInput ? "dataset" : "results"}/`,
            nativeCredential: { "modal-volume": name },
          };
        },
      };
      const checkout = {
        taskId: "modal-volumes",
        attemptId: "writer",
        branch: "supertag/conformance/modal-volumes",
        base: commit,
        head: commit,
        mounts,
        volumes,
        plan,
      };
      active = await environment.start(prepared, checkout);
      const firstId = active.provenance?.["sandboxId"];
      expect(firstId).toMatch(/^sb-/u);
      expect(active.liveMounts?.map(({ volume, access }) => ({ volume, access }))).toEqual([
        { volume: "input", access: "read-only" },
        { volume: "output", access: "read-write" },
      ]);
      await environment.harnessEnvironment(active).prepare(plan);
      const write = await active.spawn({
        command: "python3",
        args: [
          "-c",
          `import errno
from pathlib import Path
root = Path('/mnt/input')
assert {p.name for p in root.iterdir()} == {'fixture.txt'}
assert (root / 'fixture.txt').read_text() == 'input fixture'
try:
    (root / 'forbidden.txt').write_text('must fail')
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), str(error)
else:
    raise AssertionError('read-only input accepted a write')
Path('/mnt/output/result.txt').write_text('persisted output')
Path('result.txt').write_text('workspace delivery')
`,
        ],
      });
      const written = await write.wait();
      expect(written.exitCode, written.stderr).toBe(0);
      const delivery = await environment.finalize(active, {
        message: "Record Volume probe",
        author: { name: "SuperTag", email: "supertag@localhost" },
      });
      expect(delivery.committed).toBe(true);
      expect(delivery.objects).toBeDefined();
      await active.dispose("completed");
      active = undefined;

      active = await environment.start(prepared, { ...checkout, attemptId: "reader" });
      const replacementId = active.provenance?.["sandboxId"];
      expect(replacementId).toMatch(/^sb-/u);
      expect(replacementId).not.toBe(firstId);
      const read = await active.spawn({
        command: "sh",
        args: ["-ec", "test ! -e /mnt/input/forbidden.txt && cat /mnt/output/result.txt"],
      });
      const restored = await read.wait();
      expect(restored.exitCode, restored.stderr).toBe(0);
      expect(restored.stdout).toBe("persisted output");
      console.log(JSON.stringify({ firstId, replacementId, commit: delivery.head }));
    } finally {
      try {
        await active?.dispose("completed");
        await seed?.terminate({ wait: true });
        if (prepared) await environment.evict(prepared);
        await Promise.all(createdVolumes.map((name) => client.volumes.delete(name)));
      } finally {
        client.close();
        await rm(scratch, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
