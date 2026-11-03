import { describe, expect, it } from "vitest";
import { assertWorkspaceMountPaths, parseWorkspaceSpec } from "./src/workspace.js";

const source = "https://github.com/acme/app.git";

describe("Workspace mounts", () => {
  it("accepts and defaults a named read-only copy mount", () => {
    expect(
      parseWorkspaceSpec({ source, mounts: [{ volume: "datasets", path: "/mnt/datasets" }] })
        .mounts,
    ).toEqual([
      { volume: "datasets", path: "/mnt/datasets", access: "read-only", strategy: "copy" },
    ]);
    expect(
      parseWorkspaceSpec({
        source,
        mounts: [
          {
            volume: "datasets",
            path: "/mnt/datasets",
            access: "read-only",
            strategy: "copy",
            maxBytes: 1024,
          },
        ],
      }).mounts?.[0]?.maxBytes,
    ).toBe(1024);
  });

  it("preserves a native read-only mount without downgrading to copy", () => {
    expect(
      parseWorkspaceSpec({
        source,
        mounts: [{ volume: "data", path: "/mnt/data", strategy: "mount" }],
      }).mounts,
    ).toEqual([{ volume: "data", path: "/mnt/data", strategy: "mount", access: "read-only" }]);
  });

  it("accepts an explicit read-write copy or native mount", () => {
    expect(
      parseWorkspaceSpec({
        source,
        mounts: [{ volume: "data", path: "/mnt/data", access: "read-write" }],
      }).mounts,
    ).toEqual([{ volume: "data", path: "/mnt/data", strategy: "copy", access: "read-write" }]);
    expect(
      parseWorkspaceSpec({
        source,
        mounts: [{ volume: "data", path: "/mnt/data", strategy: "mount", access: "read-write" }],
      }).mounts,
    ).toEqual([{ volume: "data", path: "/mnt/data", strategy: "mount", access: "read-write" }]);
  });

  it("requires a git source for mounted Workspaces", () => {
    expect(() => parseWorkspaceSpec({ mounts: [{ volume: "data", path: "/mnt/data" }] })).toThrow(
      /source.*git/u,
    );
  });

  it.each([
    [{ volume: "../secret", path: "/mnt/data" }, /volume/u],
    [{ volume: "data", path: "mnt/data" }, /absolute/u],
    [{ volume: "data", path: "/mnt/../repo" }, /normalized/u],
    [{ volume: "data", path: "/mnt/data/" }, /end in/u],
    [{ volume: "data", path: `/mnt/${"x".repeat(4096)}` }, /absolute POSIX/u],
    [{ volume: "data", path: "/mnt/\u202edata" }, /absolute POSIX/u],
    [{ volume: "data", path: "/proc/self" }, /sensitive/u],
    [{ volume: "data", path: "/usr/bin" }, /sensitive/u],
    [{ volume: "data", path: "/lib32/objects" }, /sensitive/u],
    [{ volume: "data", path: "/root/.ssh/key" }, /sensitive/u],
    [{ volume: "data", path: "/home/worker/.ssh/key" }, /sensitive/u],
    [{ volume: "data", path: "/" }, /root/u],
    [{ volume: "data", path: "/mnt/data", access: "write-only" }, /access/u],
    [{ volume: "data", path: "/mnt/data", maxBytes: 0 }, /positive integer/u],
    [{ volume: "data", path: "/mnt/data", maxBytes: 1.5 }, /positive integer/u],
    [{ volume: "data", path: "/mnt/data", unknown: true }, /unknown fields/u],
  ])("rejects invalid mount %#", (mount, reason) => {
    expect(() => parseWorkspaceSpec({ source, mounts: [mount] })).toThrow(reason as RegExp);
  });

  it("rejects overlapping and duplicate mount destinations", () => {
    expect(() =>
      parseWorkspaceSpec({
        source,
        mounts: [
          { volume: "a", path: "/mnt/a" },
          { volume: "b", path: "/mnt/a/child" },
        ],
      }),
    ).toThrow(/overlap/u);
  });

  it("rejects mounts overlapping the checkout or staged files", () => {
    const mounts =
      parseWorkspaceSpec({ source, mounts: [{ volume: "a", path: "/work/input" }] }).mounts ?? [];
    expect(() => assertWorkspaceMountPaths(mounts, "/work/repo", ["/work/input/token"])).toThrow(
      /staged file/u,
    );
    expect(() => assertWorkspaceMountPaths(mounts, "/work", [])).toThrow(/checkout/u);
    expect(() => assertWorkspaceMountPaths(mounts, "/work/input/repo", [])).toThrow(/checkout/u);
    expect(() => assertWorkspaceMountPaths(mounts, "/work/repo", ["/work/other"])).not.toThrow();
  });

  it("keeps path boundaries distinct while detecting trailing-slash overlaps", () => {
    const mounts =
      parseWorkspaceSpec({ source, mounts: [{ volume: "a", path: "/work/input" }] }).mounts ?? [];
    expect(() => assertWorkspaceMountPaths(mounts, "/work/input-other", [])).not.toThrow();
    expect(() => assertWorkspaceMountPaths(mounts, "/work/input/", [])).toThrow(/checkout/u);
  });
});
