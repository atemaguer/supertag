import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkInstalledCli,
  compareVersions,
  findCommandOnPath,
  firstVersion,
} from "./src/installed-cli.js";

const requirement = {
  name: "Codex",
  command: "codex",
  minimumVersion: "0.156.0",
  install: "Install it with: npm install -g @openai/codex",
};

describe("installed harness CLIs", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-installed-cli-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const fake = async (output: string, name = "codex", exitCode = 0) => {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`);
    await chmod(path, 0o755);
    return path;
  };

  it("accepts a CLI at or above the minimum and reports its path and version", async () => {
    const path = await fake("codex-cli 0.163.0");
    expect(await checkInstalledCli(requirement, { path: directory })).toEqual({
      status: "ok",
      path,
      version: "0.163.0",
    });
    await fake("codex-cli 0.156.0");
    expect(await checkInstalledCli(requirement, { path: directory })).toMatchObject({
      status: "ok",
      version: "0.156.0",
    });
  });

  it("says how to install a missing CLI", async () => {
    const result = await checkInstalledCli(requirement, { path: directory });
    expect(result).toEqual({
      status: "missing",
      message:
        "Codex is not installed: `codex` is not on PATH. Install it with: npm install -g @openai/codex",
    });
  });

  it("says how to upgrade a CLI older than the minimum", async () => {
    await fake("codex-cli 0.150.9");
    const result = await checkInstalledCli(requirement, { path: directory });
    expect(result).toMatchObject({ status: "outdated", version: "0.150.9" });
    expect(result.status !== "ok" && result.message).toBe(
      "Codex 0.150.9 is older than 0.156.0, the oldest version SuperTag supports. Install it with: npm install -g @openai/codex",
    );
  });

  it("reports a CLI that prints no version or fails", async () => {
    await fake("hello");
    expect(await checkInstalledCli(requirement, { path: directory })).toMatchObject({
      status: "unknown-version",
    });
    await fake("codex-cli 0.163.0", "codex", 1);
    expect(await checkInstalledCli(requirement, { path: directory })).toMatchObject({
      status: "unknown-version",
    });
  });

  it("ignores directories and files that are not executable", async () => {
    const plain = join(directory, "codex");
    await writeFile(plain, "#!/bin/sh\necho 0.163.0\n");
    expect(await findCommandOnPath("codex", directory)).toBeUndefined();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.163.0", "0.156.0")).toBe(1);
    expect(compareVersions("2.1.280", "2.1.280")).toBe(0);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1);
    expect(firstVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
    expect(firstVersion("no version")).toBeUndefined();
  });
});
