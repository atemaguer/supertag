import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runArtifactCommand } from "../apps/cli/src/artifacts.js";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { formatSpend } from "../apps/cli/src/spend.js";
import { validateArtifactPath } from "../packages/core/src/index.js";

vi.mock("../apps/cli/src/artifact-volume.js", () => ({
  artifactVolumeReader: () => async () => Buffer.from("safe bytes"),
}));

it.each([
  "\u0080",
  "\u009b",
  "\u009d",
  "\u009f",
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202e",
  "\u2066",
  "\u2069",
  "\u2028",
  "\u2029",
  "\u200b",
  "\ufeff",
  "\u00a0",
  "\u202f",
  "\u1680",
  "\u2003",
  "\u205f",
  "\u3000",
])("refuses artifact path control %j", (control) => {
  expect(() => validateArtifactPath(`a${control}2Jb.txt`)).toThrow("normalized relative");
});

it("keeps ordinary Unicode artifact paths", () => {
  expect(validateArtifactPath("résumé/报告.txt")).toBe("résumé/报告.txt");
  expect(validateArtifactPath("my report/v 2.txt")).toBe("my report/v 2.txt");
});

it.each([true, false])("filters spend names and fallback keys (name: %s)", (named) => {
  const value = "group\u009b2J\u202e\nforged";
  const output = formatSpend({
    by: "tag",
    since: null,
    groups: [
      {
        key: value,
        ...(named ? { name: value } : {}),
        attempts: 1,
        postTriggered: {
          attempts: 0,
          reportedCostByCurrency: null,
          unknownCostAttempts: 0,
          reportedTokens: null,
          unknownTokenAttempts: 0,
        },
        reportedCostByCurrency: null,
        unknownCostAttempts: 0,
        reportedTokens: null,
        unknownTokenAttempts: 0,
      },
    ],
  });
  expect(output).toMatch(/^group 2J {2}forged \|/);
  const lines = output.trimEnd().split("\n");
  // A group without post-triggered Attempts prints no post-triggered line.
  expect(lines).toHaveLength(1);
  for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});

it.each([false, true])(
  "filters download display but preserves file and JSON paths (json: %s)",
  async (json) => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-display-"));
    const destination = join(directory, "out\u009b2J\u202e.txt");
    const content = Buffer.from("safe bytes");
    // Existing catalog records still need safe display even if new admission rejects the path.
    const entry = {
      path: "a\u009b2Jb\u202e.txt",
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      sizeBytes: content.length,
    };
    const client = new ControlPlaneClient({ baseUrl: "http://localhost", token: "test" });
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({ spec: { entries: [entry] } })
      .mockResolvedValueOnce({
        artifactId: "artifact",
        ...entry,
        volumes: [{ volume: "test" }],
        locations: [],
        holders: { workerHostIds: [], volumes: ["test"] },
      });
    try {
      const output = await runArtifactCommand(client, "download", [
        "artifact",
        "--path",
        entry.path,
        "--out",
        destination,
        ...(json ? ["--output", "json"] : []),
      ]);
      expect(await readFile(destination)).toEqual(content);
      if (json) expect(JSON.parse(output)).toMatchObject({ path: entry.path, output: destination });
      else {
        expect(output).toContain("Saved a 2Jb .txt");
        expect(output).toContain("out 2J .txt");
        expect(output.trimEnd()).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      }
    } finally {
      request.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("filters unpriced models and currency fields in spend output", () => {
  const control = "\u009b2J\u202e\nforged";
  const output = formatSpend({
    by: "objective",
    since: null,
    groups: [
      {
        key: "safe",
        attempts: 1,
        postTriggered: {
          attempts: 1,
          reportedCostByCurrency: { [`USD${control}`]: 45 },
          unknownCostAttempts: 0,
          reportedTokens: null,
          unknownTokenAttempts: 0,
        },
        reportedCostByCurrency: { [`USD${control}`]: 123 },
        unknownCostAttempts: 1,
        unpricedModels: { [`model${control}`]: 1 },
        reportedTokens: 10,
        unknownTokenAttempts: 0,
        budget: { limitMinor: 100, currency: `EUR${control}` },
      },
    ],
  });
  expect(output).toContain("no published price for model 2J  forged");
  expect(output).toContain("123 USD 2J  forged minor units");
  expect(output).toContain("100 EUR 2J  forged minor units");
  expect(output).toContain("45 USD 2J  forged minor units");
  const lines = output.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});
