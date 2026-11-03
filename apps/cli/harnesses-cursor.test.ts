import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHarnesses, noHarnessMessage } from "./src/harnesses.js";

const directories: string[] = [];

async function binDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-detect-"),
  );
  directories.push(directory);
  return directory;
}

async function binary(directory: string, name: string, version: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Cursor init detection", () => {
  it("detects CURSOR_API_KEY without a CLI", async () => {
    expect(
      await detectHarnesses(await binDirectory(), { CURSOR_API_KEY: "secret-token" }),
    ).toContain("cursor");
  });

  it("detects cursor-agent without a key", async () => {
    const directory = await binDirectory();
    await binary(directory, "cursor-agent", "Cursor Agent 1.0");
    expect(await detectHarnesses(directory, {})).toContain("cursor");
  });

  it("does not mistake Grok's agent for Cursor", async () => {
    const directory = await binDirectory();
    await binary(directory, "agent", "Grok CLI 1.0");
    expect(await detectHarnesses(directory, {})).not.toContain("cursor");
  });

  it("detects a verified Cursor agent alias", async () => {
    const directory = await binDirectory();
    await binary(directory, "agent", "Cursor Agent 1.0");
    expect(await detectHarnesses(directory, {})).toContain("cursor");
  });

  it("detects a Cursor agent alias identified by about", async () => {
    const directory = await binDirectory();
    const path = join(directory, "agent");
    await writeFile(
      path,
      `#!/bin/sh\nif [ "$1" = about ]; then printf '%s\\n' '{"name":"Cursor Agent"}'; else printf '%s\\n' 'Agent 1.0'; fi\n`,
    );
    await chmod(path, 0o755);
    expect(await detectHarnesses(directory, {})).toContain("cursor");
  });

  it("explains API key based Cursor setup", () => {
    expect(noHarnessMessage()).toContain("CURSOR_API_KEY");
    expect(noHarnessMessage()).not.toContain("Cursor.auth.login");
  });
});
