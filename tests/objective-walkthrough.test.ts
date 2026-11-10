import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const directory = join(root, "examples/objective-walkthrough");

/** Replaces ids and timestamps so the transcript compares across runs. */
const normalize = (text: string) =>
  text
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/gu, "<time>")
    .trimEnd();

it("runs the FIXTURE Objective walkthrough and matches its expected transcript", async () => {
  const env = { ...process.env };
  for (const name of ["SUPERTAG_URL", "SUPERTAG_CONTROL_PLANE_URL", "SUPERTAG_TOKEN"])
    delete env[name];
  const { stdout } = await promisify(execFile)(
    join(root, "node_modules/.bin/tsx"),
    ["--conditions=development", join(directory, "walkthrough.ts")],
    { cwd: root, env, timeout: 120_000 },
  );
  const expected = await readFile(join(directory, "expected-transcript.txt"), "utf8");
  expect(normalize(stdout)).toBe(normalize(expected));
  for (const line of stdout.trimEnd().split("\n")) expect(line).toMatch(/^FIXTURE /u);
}, 150_000);
