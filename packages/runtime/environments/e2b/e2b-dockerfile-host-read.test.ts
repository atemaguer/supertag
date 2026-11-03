import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Template } from "e2b";
import { expect, it, vi } from "vitest";
import { workspaceDevcontainerFixture } from "../../../../tests/support/workspace-devcontainer.js";
import {
  type E2BTemplateBuildSpec,
  E2BWorkspaceEnvironment,
  nativeTemplateClient,
  stageE2BDockerfile,
} from "./src/index.js";

async function rejectedDockerfile(content: string, instruction: RegExp) {
  const fixture = await workspaceDevcontainerFixture({
    ".devcontainer/devcontainer.json": JSON.stringify({ build: { dockerfile: "Dockerfile" } }),
    ".devcontainer/Dockerfile": content,
  });
  try {
    const build = vi.fn(async (_spec: E2BTemplateBuildSpec) => "unexpected");
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: join(fixture.root, "staging"),
      templateClient: { build, delete: async () => {} },
    });
    const definition = {
      workspace: "app",
      source: "https://example.test/app.git",
      trustedCommit: fixture.trustedCommit,
      trustedRepository: fixture.repository,
      content: fixture.content,
      devcontainer: fixture.devcontainer,
      harness: { commands: [] },
    };
    expect(environment.refuse(definition)).toMatch(instruction);
    await expect(environment.prepare(definition)).rejects.toThrow(instruction);
    expect(build).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
}

it("refuses a COPY brace pattern before e2b can read host files", async () => {
  await rejectedDockerfile(
    "FROM ubuntu:22.04\nCOPY {Dockerfile,../../host-home/*} /tmp/loot/\n",
    /build\.dockerfile.*COPY/u,
  );
  await rejectedDockerfile("FROM ubuntu:22.04\nONBUILD COPY x /tmp/\n", /ONBUILD/u);
  await rejectedDockerfile("FROM ubuntu:22.04\nADD x /tmp/\n", /ADD/u);
});

it("refuses Dockerfile content that names a host file before invoking e2b", async () => {
  const home = await mkdtemp(join(tmpdir(), "supertag-e2b-host-proof-"));
  const secret = join(home, "Dockerfile");
  try {
    await writeFile(secret, "FROM alpine\nRUN echo HOST-ONLY\n");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      await rejectedDockerfile(secret, /invalid instruction/u);
      expect(read.mock.calls.some(([path]) => String(path) === secret)).toBe(false);
    } finally {
      read.mockRestore();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("stages Dockerfile content as a private file for e2b's ambiguous parser", async () => {
  const context = await mkdtemp(join(tmpdir(), "supertag-e2b-context-proof-"));
  try {
    const spec = {
      name: "proof",
      from: "base",
      baseKind: "dockerfile" as const,
      dockerfile: "FROM alpine\nRUN echo safe\n",
      contextDirectory: context,
      contentFile: "content.bundle",
      contentDestination: "/transfer/content.bundle",
      script: "true",
    };
    const path = await stageE2BDockerfile(spec);
    expect(path.startsWith(`${context}/`)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(spec.dockerfile);
    const parsed = JSON.parse(
      await Template.toJSON(Template({ fileContextPath: context }).fromDockerfile(path)),
    );
    expect(JSON.stringify(parsed)).toContain("echo safe");
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

it("switches to the selected user before lifecycle and setup commands", async () => {
  const context = await mkdtemp(join(tmpdir(), "supertag-e2b-user-proof-"));
  try {
    await writeFile(join(context, "content.bundle"), "bundle");
    const build = vi
      .spyOn(Template, "build")
      .mockResolvedValue({ templateId: "template" } as never);
    try {
      await nativeTemplateClient.build({
        name: "proof",
        from: "node:22",
        baseKind: "image",
        contextDirectory: context,
        contentFile: "content.bundle",
        contentDestination: "/transfer/content.bundle",
        workspaceFolder: "/home/user/workspace",
        user: "node",
        script: "echo lifecycle && echo setup",
      });
      const template = build.mock.calls[0]?.[0];
      expect(template).toBeDefined();
      const steps = JSON.parse(await Template.toJSON(template as never)).steps as Array<{
        type: string;
        args: string[];
      }>;
      const user = steps.findIndex((step) => step.type === "USER" && step.args[0] === "node");
      const setup = steps.findIndex(
        (step) => step.type === "RUN" && step.args[0]?.includes("echo lifecycle"),
      );
      expect(user).toBeGreaterThanOrEqual(0);
      expect(setup).toBeGreaterThan(user);
    } finally {
      build.mockRestore();
    }
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
