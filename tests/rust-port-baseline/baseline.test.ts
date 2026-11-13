import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

interface BaselineCase {
  readonly id: string;
  readonly description: string;
  readonly backends: readonly string[];
  readonly expected: Readonly<Record<string, unknown>>;
}

const root = resolve(import.meta.dirname, "../..");
const cases = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8"),
) as BaselineCase[];
const execute = promisify(execFile);
const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const driver = process.env["SUPERTAG_BASELINE_DRIVER"] ?? "old";
const drivers: Readonly<Record<string, string>> = {
  old: "old-system-driver.ts",
  rust: "rust-driver.ts",
};
const driverSource = drivers[driver];
if (!driverSource) throw new Error("SUPERTAG_BASELINE_DRIVER must be old or rust");
const rustBinary = process.env["SUPERTAG_BASELINE_RUST_BINARY"];
if (process.env["SUPERTAG_BASELINE_REQUIRE_POSTGRES"] === "1" && !postgres)
  throw new Error("This baseline run requires an isolated SUPERTAG_POSTGRES_URL");

describe(`portable Rust-port behavioral baseline [${driver} driver]`, () => {
  for (const scenario of cases) {
    for (const backend of scenario.backends) {
      it.skipIf(backend === "postgresql" && !postgres)(
        `${scenario.id} [${backend}]: ${scenario.description}`,
        async () => {
          const directory = await mkdtemp(join(tmpdir(), "supertag-port-baseline-"));
          const home = join(directory, "home");
          await mkdir(home);
          const args = [
            "--import",
            "tsx",
            "--conditions=development",
            join(import.meta.dirname, driverSource),
            scenario.id,
            backend,
            directory,
          ];
          try {
            // No provider or operator credentials enter the child process.
            const { stdout } = await execute(process.execPath, args, {
              cwd: root,
              timeout: 90_000,
              maxBuffer: 2 * 1024 * 1024,
              env: {
                PATH: process.env["PATH"],
                HOME: home,
                SUPERTAG_STATE_DIR: join(directory, "state"),
                GIT_CONFIG_NOSYSTEM: "1",
                ...(driver === "rust" && rustBinary
                  ? { SUPERTAG_BASELINE_RUST_BINARY: rustBinary }
                  : {}),
                ...(backend === "postgresql" && postgres
                  ? { SUPERTAG_POSTGRES_URL: postgres }
                  : {}),
              },
            });
            const records = stdout
              .split("\n")
              .filter((line) => line.startsWith("BASELINE_RESULT "));
            expect(records, "driver must emit exactly one semantic result").toHaveLength(1);
            const result = JSON.parse(records[0]?.slice("BASELINE_RESULT ".length) ?? "");
            expect(result).toEqual({
              version: 1,
              scenario: scenario.id,
              backend,
              facts: scenario.expected,
            });
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
        100_000,
      );
    }
  }
});
