import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const command = resolve("examples/shared-organization/organization.mjs");

it.each(['{"containerName":"owned-container",', "null", "false", "[]"])(
  "does not report successful cleanup when existing example state is corrupt: %s",
  async (contents) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-corrupt-example-state-"));
    await writeFile(join(directory, "state.json"), contents, { mode: 0o600 });
    try {
      const result = await execute(process.execPath, [command, "cleanup"], {
        env: { ...process.env, SUPERTAG_EXAMPLE_STATE: directory },
      }).then(
        (value) => ({ ...value, code: 0 }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain('"stopped":true');
      expect(result.stderr).not.toBe("");
      expect(await readFile(join(directory, "state.json"), "utf8")).toBe(contents);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("keeps cleanup idempotent when no example state exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-absent-example-state-"));
  try {
    const result = await execute(process.execPath, [command, "cleanup"], {
      env: { ...process.env, SUPERTAG_EXAMPLE_STATE: directory },
    });
    expect(JSON.parse(result.stdout)).toEqual({ stopped: true, stateDirectory: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
