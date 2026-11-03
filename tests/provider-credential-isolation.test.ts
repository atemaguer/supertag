import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexModels } from "../packages/runtime/harnesses/codex/src/index.ts";
import { ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES } from "../packages/runtime/sdk/src/index.ts";
import { bundleGitEnvironment } from "../packages/runtime/sdk/src/workspace-bundles.ts";

const credentials = Object.fromEntries(
  ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES.map((name) => [name, `secret-${name}`]),
);

describe("provider credentials stay out of host child processes", () => {
  const saved = { ...process.env };
  const directories: string[] = [];
  afterEach(async () => {
    for (const name of ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("covers every e2b and Modal SDK credential", () => {
    expect([...ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES].sort()).toEqual([
      "E2B_ACCESS_TOKEN",
      "E2B_API_KEY",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
    ]);
  });

  it("removes them from the git bundling environment", () => {
    const environment = bundleGitEnvironment({ ...credentials, PATH: "/usr/bin", HOME: "/h" });
    for (const name of ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES)
      expect(environment).not.toHaveProperty(name);
    expect(environment).toMatchObject({ PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/dev/null" });
  });

  it.skipIf(process.platform === "win32")(
    "removes them from the Codex model-check process, even when passed explicitly",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-credential-isolation-"));
      directories.push(directory);
      const record = join(directory, "env.txt");
      const command = join(directory, "codex");
      await writeFile(command, `#!/bin/sh\nenv > '${record}'\n`);
      await chmod(command, 0o700);
      Object.assign(process.env, credentials);
      await expect(
        listCodexModels({
          command,
          timeoutMs: 10_000,
          environment: { MODAL_TOKEN_SECRET: "explicit", SUPERTAG_PROBE: "kept" },
        }),
      ).rejects.toThrow();
      const seen = await readFile(record, "utf8");
      expect(seen).toContain("SUPERTAG_PROBE=kept");
      for (const name of ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES)
        expect(seen).not.toMatch(new RegExp(`^${name}=`, "m"));
    },
  );
});
