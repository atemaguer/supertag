import { describe, expect, it } from "vitest";
import { BASE_DOCKERFILE, localVmOptions } from "./src/index.js";

describe("local-vm options", () => {
  it("builds the pinned base image by default", () => {
    const options = localVmOptions({ PATH: "" });
    expect(options).toMatchObject({ runtime: "docker", user: "user", memory: "8g" });
    expect(options.image).toEqual({ dockerfile: BASE_DOCKERFILE });
    // Every stage is pinned by digest: Debian, and the official Node 22 image Node and npm come
    // from.
    const stages = BASE_DOCKERFILE.split("\n").filter((line) => line.startsWith("FROM "));
    expect(stages).toHaveLength(2);
    for (const stage of stages)
      expect(stage).toMatch(
        /^FROM docker\.io\/library\/[a-z0-9:.-]+@sha256:[0-9a-f]{64}( AS node)?$/u,
      );
    expect(stages[0]).toMatch(/^FROM docker\.io\/library\/node:22-/u);
    // The Workspace user has no sudo, so the seal stays a boundary.
    expect(BASE_DOCKERFILE).not.toMatch(/sudo/u);
    // Nor any setuid or setgid program, which would hand a Task process another identity.
    expect(BASE_DOCKERFILE).toMatch(
      /find \/ -xdev -type f -perm \/6000 -exec chmod u-s,g-s \{\} \+\nUSER user\n/u,
    );
    expect(BASE_DOCKERFILE).toMatch(/\nUSER user\n/u);
  });

  it("takes an operator's image, runtime, user, and memory", () => {
    expect(
      localVmOptions({
        SUPERTAG_LOCAL_VM_RUNTIME: "podman",
        SUPERTAG_LOCAL_VM_IMAGE: "registry.example/workspace:1",
        SUPERTAG_LOCAL_VM_USER: "dev",
        SUPERTAG_LOCAL_VM_MEMORY: "4g",
      }),
    ).toEqual({
      runtime: "podman",
      image: "registry.example/workspace:1",
      user: "dev",
      memory: "4g",
    });
  });

  it("finds Podman on PATH when Docker is absent", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "local-vm-path-"));
    await writeFile(join(directory, "podman"), "#!/bin/sh\n", { mode: 0o755 });
    expect(localVmOptions({ PATH: directory }).runtime).toBe("podman");
  });

  it("refuses an unknown runtime, user, or memory", () => {
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_RUNTIME: "sh" })).toThrow(/runtime/u);
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_USER: "a b" })).toThrow(/user/u);
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_MEMORY: "lots" })).toThrow(/memory/u);
  });
});
