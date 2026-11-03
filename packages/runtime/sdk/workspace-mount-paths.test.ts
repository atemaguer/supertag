import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSensitiveWorkspaceMountPath,
  parseWorkspaceMounts,
  type WorkspaceMount,
} from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentPlan } from "./src/index.js";
import {
  assertLocalWorkspaceMountPaths,
  assertLocalWorkspacePlanPaths,
} from "./src/workspace-mount-paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-mount-paths-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  const host = join(root, "host");
  await mkdir(checkout);
  await mkdir(host);
  const mount = (path: string): WorkspaceMount => ({
    volume: "data",
    path,
    access: "read-only",
    strategy: "copy",
  });
  return { root, checkout, host, mount };
}

describe("local Workspace mount destinations", () => {
  it("caps declared copy mount bytes at 20 GiB", () => {
    expect(() =>
      parseWorkspaceMounts([{ volume: "data", path: "/mnt/data", maxBytes: 20 * 1024 ** 3 + 1 }]),
    ).toThrow(/at most 20 GiB/u);
  });
  it("refuses a symlinked destination and an ancestor redirect into the checkout", async () => {
    const { root, checkout, mount } = await fixture();
    await symlink(checkout, join(root, "link"));
    await expect(
      assertLocalWorkspaceMountPaths([mount(join(root, "link"))], checkout, [], []),
    ).rejects.toThrow(/symbolic link/u);
    await expect(
      assertLocalWorkspaceMountPaths([mount(join(root, "link", "data"))], checkout, [], []),
    ).rejects.toThrow(/checkout/u);
    await symlink(join(root, "missing"), join(root, "dangling"));
    await expect(
      assertLocalWorkspaceMountPaths([mount(join(root, "dangling", "data"))], checkout, [], []),
    ).rejects.toThrow();
  });

  it("checks staged files and protected host roots after resolving ancestors", async () => {
    const { root, checkout, host, mount } = await fixture();
    const data = join(root, "data");
    await mkdir(data);
    await symlink(data, join(root, "alias"));
    await mkdir(join(data, "child"));
    await writeFile(join(data, "child", "config.json"), "secret");
    await expect(
      assertLocalWorkspaceMountPaths(
        [mount(join(root, "alias", "child"))],
        checkout,
        [join(data, "child", "config.json")],
        [],
      ),
    ).rejects.toThrow(/staged file/u);
    await expect(
      assertLocalWorkspaceMountPaths([mount(join(host, "data"))], checkout, [], [host]),
    ).rejects.toThrow(/Worker Host state/u);
  });

  it("uses case-insensitive boundaries on macOS", async () => {
    const { root, checkout, mount } = await fixture();
    await expect(
      assertLocalWorkspaceMountPaths(
        [mount(join(root, "CHECKOUT", "data"))],
        checkout,
        [],
        [],
        true,
      ),
    ).rejects.toThrow(/checkout/u);
  });

  it("refuses a mount redirected into system directories", async () => {
    const { root, checkout, mount } = await fixture();
    await symlink("/etc", join(root, "system"));
    await expect(
      assertLocalWorkspaceMountPaths(
        [mount(join(root, "system", "supertag-data"))],
        checkout,
        [],
        [],
      ),
    ).rejects.toThrow(/sensitive system location/u);
  });

  it("protects macOS and Linux home configuration paths", async () => {
    const { checkout, mount } = await fixture();
    for (const path of [
      join(homedir(), ".claude", "skills", "x"),
      join(homedir(), ".config", "git"),
      join(homedir(), ".codex", "prompts", "x"),
      join(homedir(), "Library", "Keychains"),
    ])
      await expect(
        assertLocalWorkspaceMountPaths([mount(path)], checkout, [], []),
      ).rejects.toThrow();
    for (const path of [
      "/Users/alice/.config/fish/conf.d",
      "/Users/alice/Library/Keychains",
      "/var/root/.config/git",
      "/root/.config/git",
    ])
      expect(isSensitiveWorkspaceMountPath(path)).toBe(true);
  });

  it("detects mounts that become equal after resolving links", async () => {
    const { root, checkout, mount } = await fixture();
    const data = join(root, "data");
    await mkdir(data);
    await symlink(data, join(root, "alias"));
    await expect(
      assertLocalWorkspaceMountPaths(
        [mount(join(data, "a")), mount(join(root, "alias", "a"))],
        checkout,
        [],
        [],
      ),
    ).rejects.toThrow(/another mount/u);
  });

  it("checks the final Harness plan's files, mounts, and secret targets in the Attempt root", async () => {
    const { root, checkout, mount } = await fixture();
    const attemptRoot = join(root, "attempt");
    await mkdir(attemptRoot);
    const plan: EnvironmentPlan = {
      files: [
        { path: ".mcp.json", content: "{}" },
        { path: ".codex/config.toml", content: "" },
      ],
      mounts: [],
      secretBindings: [],
      environmentVariables: {},
      network: { mode: "none" },
    };
    await expect(
      assertLocalWorkspacePlanPaths(
        [mount(join(attemptRoot, ".mcp.json"))],
        checkout,
        plan,
        attemptRoot,
      ),
    ).rejects.toThrow(/staged file/u);
    await expect(
      assertLocalWorkspacePlanPaths(
        [mount(join(attemptRoot, ".codex"))],
        checkout,
        plan,
        attemptRoot,
      ),
    ).rejects.toThrow(/staged file/u);
    await expect(
      assertLocalWorkspacePlanPaths(
        [mount(join(attemptRoot, "secret"))],
        checkout,
        {
          ...plan,
          files: [],
          secretBindings: [{ secretRef: "key", target: "secret/token" }],
        },
        attemptRoot,
      ),
    ).rejects.toThrow(/staged file/u);
  });
});
