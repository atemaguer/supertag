import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  materializeTrustedBuildContext,
  modalDevcontainerBase,
  parseDevcontainerSubset,
  readTrustedDevcontainer,
  resolvedDevcontainerEnv,
  validatedDevcontainerDockerfile,
} from "./src/devcontainer-subset.js";
import { devcontainerCommands } from "./src/sandbox-workspace-environment.js";
import { preparedWorkspaceDigest, preparedWorkspaceKey } from "./src/workspace-environment.js";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it("accepts only the listed subset, all lifecycle forms, and listed ignored properties", () => {
  const parsed = parseDevcontainerSubset(`{
    // A devcontainer file may contain comments and trailing commas.
    "image": "node:22",
    "onCreateCommand": "npm ci",
    "updateContentCommand": ["npm", "run", "build"],
    "postCreateCommand": {"first": "echo one", "second": ["echo", "two"]},
    "containerEnv": {"MODE": "test"},
    "remoteEnv": {"EDITOR": "vim"},
    "remoteUser": "node", "containerUser": "node",
    "workspaceFolder": "/work/app",
    "postStartCommand": "never run", "postAttachCommand": "never run",
    "forwardPorts": [3000], "customizations": {"vscode": {}},
  }`);
  expect(parsed).toMatchObject({
    image: "node:22",
    onCreateCommand: "npm ci",
    updateContentCommand: ["npm", "run", "build"],
    postCreateCommand: { first: "echo one", second: ["echo", "two"] },
  });
  expect(JSON.stringify(parsed)).not.toContain("never run");
});

it.each(["features", "initializeCommand", "mounts", "dockerComposeFile", "unknownField"])(
  "refuses %s by property name",
  (property) => {
    expect(() => parseDevcontainerSubset(JSON.stringify({ [property]: {} }))).toThrow(property);
  },
);

it("refuses host environment interpolation and malformed nested properties", () => {
  const localReference = "$" + "{localEnv:AWS_SECRET_ACCESS_KEY}";
  expect(() =>
    parseDevcontainerSubset(JSON.stringify({ remoteEnv: { TOKEN: localReference } })),
  ).toThrow("localEnv");
  expect(() =>
    parseDevcontainerSubset('{"build":{"dockerfile":"Dockerfile","target":"prod"}}'),
  ).toThrow("build.target");
  expect(() =>
    parseDevcontainerSubset('{"image":"node:22","build":{"dockerfile":"Dockerfile"}}'),
  ).toThrow(/image.*build/u);
});

it.each([
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "HTTPS_PROXY",
  "NODE_OPTIONS",
  "PATH",
  "GIT_CONFIG_GLOBAL",
  "SUPERTAG_STATE_DIR",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
])("refuses reserved container environment name %s", (name) => {
  for (const property of ["containerEnv", "remoteEnv"])
    expect(() => parseDevcontainerSubset(JSON.stringify({ [property]: { [name]: "x" } }))).toThrow(
      `${property}.${name}`,
    );
});

it("refuses reserved names in a directly supplied provider definition", () => {
  expect(() => resolvedDevcontainerEnv({ remoteEnv: { PATH: "/tmp" } }, "/work/app")).toThrow(
    "remoteEnv.PATH",
  );
});

it("uses an explicit Dockerfile instruction allowlist for both providers", () => {
  for (const instruction of [
    "COPY x /x",
    "ADD x /x",
    "ONBUILD RUN echo x",
    "HEALTHCHECK NONE",
    "STOPSIGNAL SIGTERM",
  ])
    expect(() =>
      validatedDevcontainerDockerfile(`FROM alpine\n${instruction}\n`, undefined),
    ).toThrow(instruction.split(" ")[0]);
  expect(() =>
    validatedDevcontainerDockerfile("FROM alpine\nR\u001b[31mUN echo x\n", undefined),
  ).toThrow("control character");
});

it("reads the trusted commit, not Task branch or working tree", async () => {
  const path = await mkdtemp(join(tmpdir(), "supertag-devcontainer-"));
  directories.push(path);
  await run("git", ["init", "-q", path]);
  await run("git", ["-C", path, "config", "user.name", "Test"]);
  await run("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await mkdir(join(path, ".devcontainer"));
  await writeFile(join(path, ".devcontainer", "devcontainer.json"), '{"image":"node:22"}');
  await run("git", ["-C", path, "add", ".devcontainer/devcontainer.json"]);
  await run("git", ["-C", path, "commit", "-qm", "trusted"]);
  const trusted = (await run("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(path, ".devcontainer", "devcontainer.json"), '{"features":{"evil":{}}}');
  expect(await readTrustedDevcontainer(path, trusted)).toMatchObject({ image: "node:22" });
});

it("runs only updateContentCommand on warm preparation", () => {
  const devcontainer = parseDevcontainerSubset(
    JSON.stringify({
      onCreateCommand: "echo create",
      updateContentCommand: "echo update",
      postCreateCommand: "echo post",
    }),
  );
  expect(devcontainerCommands(devcontainer, false, "/work/app").join("\n")).toContain(
    "echo create",
  );
  const warm = devcontainerCommands(devcontainer, true, "/work/app").join("\n");
  expect(warm).toContain("echo update");
  expect(warm).not.toContain("echo create");
  expect(warm).not.toContain("echo post");
});

it("keys a Dockerfile by digest without storing its body or host repository path", () => {
  const environment = {
    provider: "e2b",
    base: "base",
    capabilities: { sharedPrepare: true },
  } as const;
  const definition = {
    workspace: "app",
    source: "https://example.test/app.git",
    trustedCommit: "a".repeat(40),
    trustedRepository: "/private/host/repository",
    harness: { commands: [] },
    devcontainer: {
      build: {
        dockerfile: "Dockerfile",
        dockerfilePath: ".devcontainer/Dockerfile",
        dockerfileContent: "FROM node:22\nRUN echo secret-looking-value",
        dockerfileDigest: "a".repeat(64),
      },
    },
  };
  const key = preparedWorkspaceKey(environment, definition);
  expect(JSON.stringify(key)).not.toContain("secret-looking-value");
  expect(JSON.stringify(key)).not.toContain("/private/host/repository");
  expect(preparedWorkspaceDigest(environment, definition)).not.toBe(
    preparedWorkspaceDigest(environment, {
      ...definition,
      devcontainer: {
        build: { ...definition.devcontainer.build, dockerfileDigest: "b".repeat(64) },
      },
    }),
  );
});

it("translates a Dockerfile ARG used by Modal's registry FROM", () => {
  expect(
    modalDevcontainerBase(
      {
        build: {
          dockerfile: "Dockerfile",
          dockerfileDigest: "a".repeat(64),
          dockerfileContent: "ARG VERSION=20\nFROM node:$" + "{VERSION}\nRUN node --version",
          args: { VERSION: "22" },
        },
      },
      "fallback",
    ),
  ).toEqual({ image: "node:22", commands: ["RUN node --version"] });
});

it("refuses a symlink in the trusted Docker build context", async () => {
  const path = await mkdtemp(join(tmpdir(), "supertag-devcontainer-context-"));
  directories.push(path);
  await run("git", ["init", "-q", path]);
  await mkdir(join(path, "context"));
  await symlink("/private/host-secret", join(path, "context", "linked"));
  await run("git", ["-C", path, "add", "context/linked"]);
  await run("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "trusted",
  ]);
  const trustedCommit = (await run("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
  await expect(
    materializeTrustedBuildContext({
      repository: path,
      trustedCommit,
      context: "context",
      destination: join(path, "output"),
    }),
  ).rejects.toThrow(/symlink.*context\/linked/u);
});
