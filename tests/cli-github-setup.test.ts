import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";
import { setupGitHub } from "../apps/cli/src/setup.ts";

describe("GitHub CLI setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prints readable local Slack documentation without a hosted documentation dependency", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["setup", "surface", "slack", "--help"])).resolves.toBe(0);
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).not.toContain("github.com/atemaguer");
    for (const label of ["Guide", "Manifest"]) {
      const path = output.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1];
      expect(path).toBeDefined();
      expect(await readFile(path ?? "", "utf8")).not.toBe("");
    }
  });

  it("preserves token-only setup by default", async () => {
    vi.stubEnv("SUPERTAG_GITHUB_TOKEN", "github-token");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "unused-webhook-secret");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: 123, login: "octocat", type: "User" })),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const account = await setupGitHub([]);

    expect(account.secrets).toEqual({ token: "github-token" });
  });

  it("collects the repository webhook secret when --webhook is selected", async () => {
    vi.stubEnv("SUPERTAG_GITHUB_TOKEN", "github-token");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "repository-webhook-secret");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: 123, login: "octocat", type: "User" })),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const account = await setupGitHub(["--webhook"]);

    expect(account.secrets).toEqual({
      token: "github-token",
      webhookSecret: "repository-webhook-secret",
    });
  });

  it("documents token webhook enrollment in setup help", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main(["setup", "github", "--help"])).resolves.toBe(0);

    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("[--webhook]");
    expect(output).toContain("GITHUB_WEBHOOK_SECRET");
  });
});
