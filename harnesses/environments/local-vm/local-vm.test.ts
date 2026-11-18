import { describe, expect, it } from "vitest";
import { BASE_DOCKERFILE, localVmOptions } from "./src/index.js";

describe("local-vm options", () => {
  it("builds the pinned base image by default", () => {
    const options = localVmOptions({});
    expect(options).toMatchObject({ runtime: "docker", user: "user", memory: "8g" });
    expect(options.image).toEqual({ dockerfile: BASE_DOCKERFILE });
    expect(BASE_DOCKERFILE).toMatch(/^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}\n/u);
    // The Workspace user has no sudo, so the seal stays a boundary.
    expect(BASE_DOCKERFILE).not.toMatch(/sudo/u);
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

  it("refuses an unknown runtime, user, or memory", () => {
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_RUNTIME: "sh" })).toThrow(/runtime/u);
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_USER: "a b" })).toThrow(/user/u);
    expect(() => localVmOptions({ SUPERTAG_LOCAL_VM_MEMORY: "lots" })).toThrow(/memory/u);
  });
});
