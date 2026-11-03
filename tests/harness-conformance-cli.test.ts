import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each([
  { args: ["--backend", "modla"], error: "Select --backend local, modal, or e2b" },
  { args: ["--backend", "modal"], error: "Modal Harness tests require --image-id" },
  { args: ["--backend", "e2b"], error: "E2B Harness tests require --template" },
  {
    args: ["--backend", "local", "--image-id", "not-local"],
    error: "--image-id requires --backend modal",
  },
])(
  "rejects invalid cloud execution selection before fixture/provider work: $args",
  async ({ args, error }) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-cli-selection-"));
    const output = join(directory, "must-not-exist");
    try {
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            "--conditions=development",
            "scripts/harness-conformance.ts",
            "--live",
            "--harness",
            "codex",
            "--output",
            output,
            ...args,
          ],
          { timeout: 10000 },
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(error) });
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
