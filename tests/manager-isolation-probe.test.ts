import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  assessIsolation,
  MANAGER_ISOLATION_LIVE_ENV,
  parseChildReport,
  parseProbeCli,
  sanitizeProbeText,
  versionFromOutput,
} from "../scripts/manager-isolation-probe-lib.js";

it("requires both explicit live authorizations before selecting a provider", () => {
  const base = { harness: "claude-code", output: "/tmp/report" };
  expect(() => parseProbeCli(base, {})).toThrow(`both --live and ${MANAGER_ISOLATION_LIVE_ENV}=1`);
  expect(() => parseProbeCli({ ...base, live: true }, {})).toThrow(MANAGER_ISOLATION_LIVE_ENV);
  expect(() => parseProbeCli(base, { [MANAGER_ISOLATION_LIVE_ENV]: "1" })).toThrow("--live");
  expect(
    parseProbeCli({ ...base, live: true }, { [MANAGER_ISOLATION_LIVE_ENV]: "1" }),
  ).toMatchObject({ harness: "claude-code", model: "haiku", output: "/tmp/report" });
});

it("rejects Codex because native subagents are disabled", () => {
  expect(() =>
    parseProbeCli(
      { live: true, harness: "codex", output: "/tmp/report" },
      { [MANAGER_ISOLATION_LIVE_ENV]: "1" },
    ),
  ).toThrow("native subagents are disabled");
});

it("requires explicit OpenCode model syntax and limits executable overrides", () => {
  const environment = { [MANAGER_ISOLATION_LIVE_ENV]: "1" };
  expect(() =>
    parseProbeCli({ live: true, harness: "opencode", output: "/tmp/report" }, environment),
  ).toThrow("provider/model");
  expect(() =>
    parseProbeCli(
      { live: true, harness: "claude-code", executable: "claude", output: "/tmp/report" },
      environment,
    ),
  ).toThrow("only for the pinned OpenCode preflight");
});

it("extracts exact semantic versions from pinned CLI output", () => {
  expect(versionFromOutput("codex-cli 0.146.0")).toBe("0.146.0");
  expect(versionFromOutput("2.1.220 (Claude Code)")).toBe("2.1.220");
  expect(versionFromOutput("no semantic version")).toBeUndefined();
});

it("requires hard schema isolation from supported subagent Harnesses", () => {
  const preflight = {
    command: "pinned",
    expectedVersion: "1.2.3",
    observedVersion: "1.2.3",
    compatible: true,
    source: "bundled" as const,
  };
  const base = {
    listRequests: 1,
    rootCallObserved: true,
    childCallObserved: false,
    childReportedToolVisible: true,
    childReportedCredentialVisible: false,
    outputContainedCredential: false,
    nativeChildrenObserved: 1,
  };
  expect(assessIsolation("claude-code", preflight, base)).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("hard-isolated tool schema"),
  });
  expect(assessIsolation("opencode", preflight, base)).toMatchObject({ status: "failed" });
});

it("fails on child invocation, credential access, output leakage, and incompatible binaries", () => {
  const observations = {
    listRequests: 1,
    rootCallObserved: true,
    childCallObserved: true,
    childReportedCredentialVisible: true,
    outputContainedCredential: true,
    nativeChildrenObserved: 1,
  };
  expect(
    assessIsolation(
      "claude-code",
      { command: "codex", expectedVersion: "1", compatible: true, source: "bundled" },
      observations,
    ),
  ).toMatchObject({ status: "failed", reason: expect.stringContaining("credential canary") });
  expect(
    assessIsolation(
      "claude-code",
      { command: "codex", expectedVersion: "1", compatible: false, source: "bundled" },
      { ...observations, childCallObserved: false, childReportedCredentialVisible: false },
    ),
  ).toEqual({ status: "failed", reason: "Pinned binary preflight failed closed" });
});

it("fails when the provider does not return the child's structured observations", () => {
  expect(
    assessIsolation(
      "opencode",
      {
        command: "opencode",
        expectedVersion: "1.1.48",
        observedVersion: "1.1.48",
        compatible: true,
        source: "configured",
      },
      {
        listRequests: 1,
        rootCallObserved: true,
        childCallObserved: false,
        outputContainedCredential: false,
        nativeChildrenObserved: 0,
      },
    ),
  ).toMatchObject({ status: "failed", reason: expect.stringContaining("structured") });
});

it("parses the bounded child report and redacts credential canaries", () => {
  expect(
    parseChildReport(
      'noise\nCHILD_ISOLATION_REPORT {"toolVisible":false,"credentialVisible":true}\n',
    ),
  ).toEqual({ childReportedToolVisible: false, childReportedCredentialVisible: true });
  expect(sanitizeProbeText("prefix secret suffix", "secret")).toBe("prefix [REDACTED] suffix");
});

it("writes a manifest when a compatible provider executable is unavailable for execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-manager-isolation-"));
  const executable = join(directory, "opencode-fixture.mjs");
  const authFile = join(directory, "auth.json");
  const output = join(directory, "report");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("1.1.48");process.exit(0)}console.log(JSON.stringify({type:"error",error:"authentication unavailable"}));\n',
  );
  await chmod(executable, 0o700);
  await writeFile(authFile, "{}\n");
  try {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          "scripts/manager-isolation-probe.ts",
          "--live",
          "--harness",
          "opencode",
          "--model",
          "opencode-go/fixture",
          "--executable",
          executable,
          "--auth-file",
          authFile,
          "--output",
          output,
        ],
        {
          cwd: process.cwd(),
          timeout: 10_000,
          env: { ...process.env, [MANAGER_ISOLATION_LIVE_ENV]: "1" },
        },
      ),
    ).rejects.toMatchObject({ code: 1 });
    const manifest = JSON.parse(
      await readFile(join(output, "manager-isolation-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      version: 1,
      harness: "opencode",
      status: "unavailable",
      preflight: {
        expectedVersion: "1.1.48",
        observedVersion: "1.1.48",
        compatible: true,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
