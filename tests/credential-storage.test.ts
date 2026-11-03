import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../packages/store/src/index.ts";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

describe("local credential storage durability", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("preserves every Gateway and operator update from separate OS processes", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = join(directory, "credentials.json");
    const moduleUrl = pathToFileURL(resolve("packages/store/src/index.ts")).href;
    const writers = [
      ["gateway", "slack-a"],
      ["gateway", "github-b"],
      ["operator", "admin-a"],
      ["operator", "admin-b"],
    ] as const;

    await Promise.all(
      writers.map(async ([section, prefix]) => {
        const script = `
            import { FileCredentialStore } from ${JSON.stringify(moduleUrl)};
            const store = new FileCredentialStore(${JSON.stringify(section)}, ${JSON.stringify(credentialPath)});
            for (let index = 0; index < 20; index += 1) {
              await store.store(${JSON.stringify(prefix)} + "/" + index, { token: ${JSON.stringify(prefix)} + "-" + index });
            }
          `;
        await execFileAsync(
          process.execPath,
          ["--import", "tsx", "--conditions=development", "--input-type=module", "--eval", script],
          { cwd: process.cwd(), timeout: 20_000 },
        );
      }),
    );

    const file = JSON.parse(await readFile(credentialPath, "utf8")) as {
      gateway: Record<string, unknown>;
      operator: Record<string, unknown>;
    };
    expect(Object.keys(file.gateway)).toHaveLength(40);
    expect(Object.keys(file.operator)).toHaveLength(40);
    expect(file.gateway["slack-a/0"]).toEqual({ token: "slack-a-0" });
    expect(file.operator["admin-b/19"]).toEqual({ token: "admin-b-19" });
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  }, 25_000);

  it("recovers a lock abandoned by a crashed writer", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = join(directory, "credentials.json");
    const lockPath = `${credentialPath}.lock`;
    await writeFile(lockPath, "abandoned", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const store = new FileCredentialStore("gateway", credentialPath);
    await store.store("surface/slack/T123", { token: "restored" });

    await expect(store.resolve("surface/slack/T123")).resolves.toEqual({ token: "restored" });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on corrupt files without overwriting them", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = join(directory, "credentials.json");
    await writeFile(credentialPath, "not-json", { mode: 0o600 });
    const store = new FileCredentialStore("gateway", credentialPath);

    await expect(store.store("surface/slack/T123", { token: "must-not-write" })).rejects.toThrow();
    await expect(readFile(credentialPath, "utf8")).resolves.toBe("not-json");
  });

  it("rejects a symlink instead of following it", async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, "target.json");
    const credentialPath = join(directory, "credentials.json");
    await writeFile(targetPath, '{"sentinel":true}', { mode: 0o600 });
    await symlink(targetPath, credentialPath);
    const store = new FileCredentialStore("gateway", credentialPath);

    await expect(store.store("surface/slack/T123", { token: "must-not-write" })).rejects.toThrow(
      "Credential store is not a regular file",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe('{"sentinel":true}');
  });

  it.each([
    ["populated workers", { workers: { "local-codex": { token: "stale-token" } } }],
    ["empty workers", { workers: {} }],
    ["workers array", { workers: [] }],
    ["null workers", { workers: null }],
    ["unknown section", { providerSettings: { region: "local" } }],
  ])("rejects %s without changing the credential file", async (_name, extra) => {
    const directory = await temporaryDirectory();
    const credentialPath = join(directory, "credentials.json");
    const original = `${JSON.stringify(
      {
        version: 2,
        gateway: { "existing/key": { token: "gateway-token" } },
        operator: { "existing/key": { token: "operator-token" } },
        ...extra,
      },
      null,
      2,
    )}\n`;
    await writeFile(credentialPath, original, { mode: 0o600 });

    for (const section of ["gateway", "operator"] as const) {
      const store = new FileCredentialStore(section, credentialPath);
      const operations = [
        () => store.resolve("existing/key"),
        () => store.store("new/key", { token: "must-not-write" }),
        () => store.storeIf("existing/key", { token: "must-not-write" }, () => true),
        () => store.storeIfAbsent("new/key", { token: "must-not-write" }),
        () => store.delete("existing/key"),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow("Credential store has an unsupported format");
        await expect(readFile(credentialPath, "utf8")).resolves.toBe(original);
        await expect(stat(`${credentialPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("writes new files without a workers section", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = join(directory, "credentials.json");
    await new FileCredentialStore("gateway", credentialPath).store("surface/slack/T1", {
      token: "t",
    });
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toEqual({
      version: 2,
      gateway: { "surface/slack/T1": { token: "t" } },
      operator: {},
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-credential-durability-"));
  directories.push(directory);
  return directory;
}
