import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workspaceDevcontainerFixture } from "../../../../tests/support/workspace-devcontainer.js";
import { type E2BTemplateBuildSpec, E2BWorkspaceEnvironment } from "./src/index.js";

it("omits the harness install from a split execution sandbox", async () => {
  const fixture = await workspaceDevcontainerFixture({ "app.txt": "trusted" });
  try {
    const build = vi.fn(async (_spec: E2BTemplateBuildSpec) => "split-template");
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: fixture.root,
      templateClient: { build, delete: async () => {} },
    });
    await environment.prepare({
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      trustedRepository: fixture.repository,
      content: fixture.content,
      harness: { commands: [], install: "install-claude-in-sandbox" },
    });
    expect(build.mock.calls[0]?.[0]?.harnessInstall).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

it("translates image, environment, folder, and lifecycle steps into an E2B template build", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({
      image: "node:22",
      containerEnv: { MODE: "test" },
      remoteEnv: { APP_MODE: "$" + "{containerEnv:MODE}" },
      workspaceFolder: "/home/user/workspace",
      onCreateCommand: "echo create",
      updateContentCommand: ["echo", "update"],
      postCreateCommand: { last: "echo post" },
    }),
  });
  try {
    const build = vi.fn(async (_spec: E2BTemplateBuildSpec) => "template-one");
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: fixture.root,
      templateClient: { build, delete: async () => {} },
    });
    const prepared = await environment.prepare({
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      trustedRepository: fixture.repository,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
      setup: "echo setup",
    });
    expect(prepared.workspaceDirectory).toBe("/home/user/workspace");
    const spec = build.mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      from: "node:22",
      baseKind: "image",
      workspaceFolder: "/home/user/workspace",
      containerEnv: { MODE: "test", APP_MODE: "test" },
    });
    expect(spec?.script.indexOf("echo create")).toBeLessThan(
      spec?.script.indexOf("'echo' 'update'") ?? 0,
    );
    expect(spec?.script.indexOf("'echo' 'update'")).toBeLessThan(
      spec?.script.indexOf("echo post") ?? 0,
    );
    expect(spec?.script.indexOf("echo post")).toBeLessThan(spec?.script.indexOf("echo setup") ?? 0);
  } finally {
    await fixture.cleanup();
  }
});

it("builds E2B Docker context from tracked trusted blobs, not changed worktree files", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({
      build: { dockerfile: "Dockerfile", context: "..", args: { VERSION: "22" } },
    }),
    ".devcontainer/Dockerfile": "FROM node:20\nARG VERSION=20\nRUN echo $VERSION\n",
    "app.txt": "trusted",
  });
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${fixture.repository}/app.txt`, "untrusted task edit");
    const build = vi.fn(async (spec: E2BTemplateBuildSpec) => {
      expect(await readFile(`${spec.contextDirectory}/app.txt`, "utf8")).toBe("trusted");
      return "template-two";
    });
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: fixture.root,
      templateClient: { build, delete: async () => {} },
    });
    await environment.prepare({
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      trustedRepository: fixture.repository,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
    });
    expect(build.mock.calls[0]?.[0]).toMatchObject({
      baseKind: "dockerfile",
      dockerfile: expect.stringContaining("ARG VERSION=22"),
    });
  } finally {
    await fixture.cleanup();
  }
});
