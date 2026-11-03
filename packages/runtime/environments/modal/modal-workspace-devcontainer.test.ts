import { expect, it, vi } from "vitest";
import { workspaceDevcontainerFixture } from "../../../../tests/support/workspace-devcontainer.js";
import {
  type ModalSetupSandboxClient,
  type ModalWorkspaceClient,
  ModalWorkspaceEnvironment,
} from "./src/index.js";

it("omits the harness install from a split execution image", async () => {
  const fixture = await workspaceDevcontainerFixture({ "app.txt": "trusted" });
  try {
    const buildImage = vi.fn<ModalWorkspaceClient["buildImage"]>(async () => "split-base");
    const environment = new ModalWorkspaceEnvironment({
      appName: "existing",
      stagingDirectory: fixture.root,
      workspaceClient: {
        buildImage,
        createSetupSandbox: async () => setupSandbox(),
        deleteImage: async () => {},
      },
    });
    await environment.prepare({
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      content: fixture.content,
      harness: { commands: [], install: "install-claude-in-sandbox" },
    });
    expect(JSON.stringify(buildImage.mock.calls)).not.toContain("install-claude-in-sandbox");
  } finally {
    await fixture.cleanup();
  }
});

function setupSandbox(): ModalSetupSandboxClient {
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  return {
    sandboxId: "fake-setup",
    exec: async () => ({
      stdin: { writeBytes: async () => {}, close: async () => {} },
      stdout: stream(),
      stderr: stream(),
      wait: async () => 0,
    }),
    snapshotFilesystem: async () => "prepared-image",
    terminate: async () => 0,
  };
}

it("translates a Dockerfile and lifecycle setup to Modal image layers and a setup sandbox", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({
      build: { dockerfile: "Dockerfile", args: { VERSION: "22" } },
      containerEnv: { MODE: "test" },
      onCreateCommand: "echo create",
      updateContentCommand: "echo update",
      postCreateCommand: "echo post",
    }),
    ".devcontainer/Dockerfile": "FROM node:20\nARG VERSION=20\nRUN echo $VERSION\n",
  });
  try {
    const buildImage = vi.fn<ModalWorkspaceClient["buildImage"]>(async () => "base-image");
    const createSetupSandbox = vi.fn<ModalWorkspaceClient["createSetupSandbox"]>(async () =>
      setupSandbox(),
    );
    const deleteImage = vi.fn<ModalWorkspaceClient["deleteImage"]>(async () => {});
    const environment = new ModalWorkspaceEnvironment({
      appName: "existing",
      stagingDirectory: fixture.root,
      workspaceClient: { buildImage, createSetupSandbox, deleteImage },
    });
    await environment.prepare({
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
    });
    expect(buildImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "node:20",
        commands: expect.arrayContaining([
          "ARG VERSION=22",
          "RUN echo $VERSION",
          'ENV MODE="test"',
        ]),
      }),
    );
    expect(createSetupSandbox).toHaveBeenCalledOnce();
    expect(deleteImage).toHaveBeenCalledWith({ imageId: "base-image" });
  } finally {
    await fixture.cleanup();
  }
});

it("refuses a Modal Dockerfile with local COPY before calling the provider", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({ build: { dockerfile: "Dockerfile" } }),
    ".devcontainer/Dockerfile": "FROM node:22\nCOPY package.json /app/\n",
  });
  try {
    const buildImage = vi.fn<ModalWorkspaceClient["buildImage"]>(async () => "unused");
    const environment = new ModalWorkspaceEnvironment({
      appName: "existing",
      stagingDirectory: fixture.root,
      workspaceClient: {
        buildImage,
        createSetupSandbox: async () => setupSandbox(),
        deleteImage: async () => {},
      },
    });
    const definition = {
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
    };
    expect(environment.refuse(definition)).toMatch(/build\.dockerfile.*COPY/u);
    await expect(environment.prepare(definition)).rejects.toThrow(/build\.dockerfile.*COPY/u);
    expect(buildImage).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});

it("refuses Dockerfile instructions outside the shared subset before Modal builds", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({ build: { dockerfile: "Dockerfile" } }),
    ".devcontainer/Dockerfile": "FROM node:22\nHEALTHCHECK NONE\n",
  });
  try {
    const buildImage = vi.fn<ModalWorkspaceClient["buildImage"]>(async () => "unused");
    const environment = new ModalWorkspaceEnvironment({
      appName: "existing",
      stagingDirectory: fixture.root,
      workspaceClient: {
        buildImage,
        createSetupSandbox: async () => setupSandbox(),
        deleteImage: async () => {},
      },
    });
    const definition = {
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
    };
    expect(environment.refuse(definition)).toMatch(/HEALTHCHECK/u);
    await expect(environment.prepare(definition)).rejects.toThrow(/HEALTHCHECK/u);
    expect(buildImage).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});

it("deletes the temporary Modal base image and terminates setup after a snapshot failure", async () => {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({ image: "node:22" }),
  });
  try {
    const sandbox = setupSandbox();
    const terminate = vi.fn(sandbox.terminate);
    const deleteImage = vi.fn<ModalWorkspaceClient["deleteImage"]>(async () => {});
    const environment = new ModalWorkspaceEnvironment({
      appName: "existing",
      stagingDirectory: fixture.root,
      workspaceClient: {
        buildImage: async () => "temporary-base",
        createSetupSandbox: async () => ({
          ...sandbox,
          terminate,
          snapshotFilesystem: async () => {
            throw new Error("snapshot failed");
          },
        }),
        deleteImage,
      },
    });
    await expect(
      environment.prepare({
        workspace: "app",
        source: "https://example.test/app.git",
        trustedCommit: fixture.trustedCommit,
        content: fixture.content,
        devcontainer: fixture.devcontainer,
        harness: { commands: [] },
      }),
    ).rejects.toThrow("snapshot failed");
    expect(terminate).toHaveBeenCalledOnce();
    expect(deleteImage).toHaveBeenCalledWith({ imageId: "temporary-base" });
  } finally {
    await fixture.cleanup();
  }
});
