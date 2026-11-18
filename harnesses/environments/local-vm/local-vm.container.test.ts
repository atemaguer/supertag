import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  containerDockerfile,
  containerSandboxProvider,
  nativePlatform,
  type SandboxOwner,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { sandboxProviderConformance } from "@supertag/worker-sdk/internal/rust-workspace-provider/conformance";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_DOCKERFILE, createLocalVmWorkspaceSession, localVmOptions } from "./src/index.js";

// The local-vm provider against real containers on this machine's runtime, with the base image
// it builds itself. Building the image needs the network once; set SUPERTAG_TEST_LOCAL_VM=1 to
// run these, and SUPERTAG_TEST_REQUIRE_CONTAINER=1 to fail where no runtime answers.
const runtime = process.env["SUPERTAG_TEST_CONTAINER_RUNTIME"] ?? "docker";
const wanted = process.env["SUPERTAG_TEST_LOCAL_VM"] === "1";
const answers =
  wanted && spawnSync(runtime, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
if (wanted && !answers && process.env["SUPERTAG_TEST_REQUIRE_CONTAINER"] === "1")
  throw new Error(`${runtime} is required for the local-vm provider`);
const options = { ...localVmOptions({}), runtime };
const BUILD_MS = 20 * 60_000;

function owner(): SandboxOwner {
  return {
    hostId: "local-vm-test",
    hostGeneration: 1n,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    allocationId: randomUUID(),
  };
}

function ownedContainers(): string[] {
  const listed = spawnSync(
    runtime,
    ["ps", "-aq", "--no-trunc", "--filter", "label=supertag.local-vm=1"],
    { encoding: "utf8" },
  );
  return listed.stdout.split("\n").filter(Boolean);
}

describe.skipIf(!answers)("local-vm provider", () => {
  const provider = containerSandboxProvider({
    name: "local-vm",
    label: "supertag.local-vm",
    runtime,
    image: options.image,
    user: options.user,
    buildImages: true,
    runFlags: ["--memory", options.memory],
  });

  beforeAll(async () => {
    // The first allocation builds the base image; the cases after it reuse it.
    const first = owner();
    const workspace = await provider.allocate(first, 60_000, AbortSignal.timeout(BUILD_MS));
    await provider.stop(first, workspace.sandboxId);
  }, BUILD_MS);

  it("runs Task processes as an unprivileged user with no capabilities and no network", async () => {
    const who = owner();
    const workspace = await provider.allocate(who, 60_000, AbortSignal.timeout(60_000));
    try {
      const run = (script: string) =>
        workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
      expect((await run("id -u")).stdout.trim()).toBe("1000");
      expect((await run("grep CapEff /proc/self/status")).stdout).toMatch(/0{16}/u);
      expect((await run("grep NoNewPrivs /proc/self/status")).stdout).toMatch(/1/u);
      expect((await run("ls /sys/class/net")).stdout.trim()).toBe("lo");
      expect((await run("uname -m")).stdout.trim()).toBe(
        nativePlatform() === "linux/arm64" ? "aarch64" : "x86_64",
      );
      for (const tool of ["git", "python3", "node", "rg", "curl", "ps"])
        expect((await run(`command -v ${tool}`)).exitCode, tool).toBe(0);
      expect((await run("command -v sudo")).exitCode).not.toBe(0);
      // The seal's own process gets its capabilities back, for that process only.
      const privileged = await workspace.runPrivileged?.(
        ["sh", "-c", "id -u; grep CapEff /proc/self/status"],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect(privileged?.stdout).toMatch(/^0\n/u);
      expect(privileged?.stdout).not.toMatch(/CapEff:\s+0{16}/u);
    } finally {
      await provider.stop(who, workspace.sandboxId);
    }
  }, 120_000);

  it(
    "builds a devcontainer's layers on the base image and refuses copies from the host",
    async () => {
      const who = owner();
      const environment = {
        dockerfileCommands: ["RUN echo marked > /home/user/marker", "USER user"],
        user: "user",
        setupCommands: [],
      };
      expect(() =>
        containerDockerfile(
          { ...environment, dockerfileCommands: ["COPY / /host", "USER user"] },
          "base",
        ),
      ).toThrow(/copy/u);
      const workspace = await provider.allocate(
        who,
        60_000,
        AbortSignal.timeout(BUILD_MS),
        environment,
      );
      try {
        const marker = await workspace.run(
          ["cat", "/home/user/marker"],
          30_000,
          AbortSignal.timeout(30_000),
        );
        expect(marker.exitCode).toBe(0);
      } finally {
        await provider.stop(who, workspace.sandboxId);
      }
    },
    BUILD_MS,
  );

  it(
    "refuses a Workspace user that is root",
    async () => {
      const who = owner();
      await expect(
        provider.allocate(who, 60_000, AbortSignal.timeout(BUILD_MS), {
          dockerfileCommands: ["USER root"],
          user: "root",
          setupCommands: [],
        }),
      ).rejects.toThrow(/root/u);
      await provider.stop(who);
      expect(ownedContainers()).toEqual([]);
    },
    BUILD_MS,
  );

  for (const check of sandboxProviderConformance(
    async () => ({
      session: createLocalVmWorkspaceSession(options),
      async lose() {
        for (const id of ownedContainers()) spawnSync(runtime, ["rm", "-f", id]);
      },
    }),
    { commands: true, snapshots: true, isolated: true, timeoutMs: 120_000 },
  ))
    it(`local-vm conformance: ${check.name}`, check.run, check.timeoutMs);
});

it("pins the base image to a digest", () => {
  expect(BASE_DOCKERFILE.split("\n")[0]).toMatch(/@sha256:/u);
});
