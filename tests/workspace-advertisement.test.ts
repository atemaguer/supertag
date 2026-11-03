import { mkdtemp, rm } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workerHostResource, workspaceResource } from "../apps/cli/src/control-plane-resources.js";
import { assertGitCheckouts, parseWorkletWorkspaces } from "../apps/cli/src/worklet-workspaces.js";
import type { WorkerHost, Workspace } from "../packages/core/src/index.js";
import {
  LocalWorklet,
  type Worker,
  type WorkerDescriptor,
  type WorkletDescriptor,
} from "../packages/runtime/sdk/src/index.js";
import { decodeHostFrame, encodeHostFrame } from "../packages/runtime/transport/src/grpc-codec.js";
import { createRepository, isolateGitConfiguration } from "./support/git-repository.js";

const descriptor: WorkletDescriptor = {
  id: "worklet",
  protocolVersion: 1,
  durableProtocolVersion: 1,
  host: {
    id: "laptop",
    workspaces: ["app", "docs"],
    workers: [
      {
        profileCapabilities: [
          {
            profile: { id: "local-claude-code", revision: "1" },
            capabilities: [{ id: "supertag.workspace.in-place", version: 1 }],
            contextTypes: [],
          },
        ],
        id: "local-claude-code",
        type: "supertag",
        capabilities: [{ id: "supertag.workspace.in-place", version: 1 }],
        profiles: [{ id: "local-claude-code", revision: "1" }],
        contextTypes: [],
      },
    ],
  },
};

describe("Workspace checkout declarations", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("parses repeated --workspace NAME=PATH values and keeps the unnamed PATH meaning", () => {
    expect(
      parseWorkletWorkspaces(["app=~/code/app", "./docs-site", "docs=/srv/docs"], "/work"),
    ).toEqual({
      defaultPath: "/work/docs-site",
      checkouts: [
        { name: "app", path: join(homedir(), "code/app") },
        { name: "docs", path: "/srv/docs" },
      ],
    });
    expect(parseWorkletWorkspaces(undefined)).toEqual({ checkouts: [] });
    // A path that merely contains "=" is still the unnamed folder.
    expect(parseWorkletWorkspaces(["/tmp/a=b"]).defaultPath).toBe("/tmp/a=b");
    expect(() => parseWorkletWorkspaces(["app=/a", "app=/b"])).toThrow("more than once");
    expect(() => parseWorkletWorkspaces(["/a", "/b"])).toThrow("Only one unnamed");
    expect(() => parseWorkletWorkspaces(["App=/a"])).toThrow("invalid Workspace");
    expect(() => parseWorkletWorkspaces(["app="])).toThrow("needs a checkout path");
  });

  it("refuses to declare a checkout that is missing or not a git repository", async () => {
    cleanups.push(await isolateGitConfiguration());
    const repository = await createRepository();
    const plain = await mkdtemp(join(tmpdir(), "supertag-plain-"));
    cleanups.push(() => rm(repository, { recursive: true, force: true }));
    cleanups.push(() => rm(plain, { recursive: true, force: true }));
    await expect(assertGitCheckouts([{ name: "app", path: repository }])).resolves.toBeUndefined();
    await expect(assertGitCheckouts([{ name: "app", path: plain }])).rejects.toThrow(
      "is not a git repository",
    );
    await expect(
      assertGitCheckouts([{ name: "app", path: join(plain, "missing") }]),
    ).rejects.toThrow("is not a directory");
  });

  it("advertises names, never paths, over gRPC", () => {
    const frame = encodeHostFrame({ type: "hello", protocolVersions: [18], worklet: descriptor });
    expect(decodeHostFrame(frame, "credential")).toMatchObject({
      worklet: { host: { id: "laptop", workspaces: ["app", "docs"] } },
    });
    const withoutWorkspaces = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: { ...descriptor, host: { ...descriptor.host, workspaces: [] } },
    });
    expect(
      (decodeHostFrame(withoutWorkspaces, "credential") as { worklet: { host: object } }).worklet
        .host,
    ).not.toHaveProperty("workspaces");
    const leaking = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: { ...descriptor, host: { ...descriptor.host, workspaces: ["/Users/me/code/app"] } },
    });
    expect(() => decodeHostFrame(leaking, "credential")).toThrow("never paths");
  });

  it("advertises placement labels over gRPC and rejects malformed ones", () => {
    const labels = ["arm64", "gpu", "harness:claude-code", "macos", "workspace:app"];
    const frame = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: { ...descriptor, host: { ...descriptor.host, labels } },
    });
    expect(decodeHostFrame(frame, "credential")).toMatchObject({ worklet: { host: { labels } } });
    const unlabeled = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: descriptor,
    });
    expect(
      (decodeHostFrame(unlabeled, "credential") as { worklet: { host: object } }).worklet.host,
    ).not.toHaveProperty("labels");
    const malformed = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: { ...descriptor, host: { ...descriptor.host, labels: ["GPU"] } },
    });
    expect(() => decodeHostFrame(malformed, "credential")).toThrow("lowercase labels");
  });

  it("advertises checkouts from a mixed-profile host with automatic and declared labels", async () => {
    const worker = (describe: WorkerDescriptor): Worker => ({
      describe: async () => describe,
      // biome-ignore lint/correctness/useYield: Advertisement never executes.
      async *execute() {
        throw new Error("not executed");
      },
    });
    const local = { id: "local", revision: "1" };
    const remote = { id: "remote", revision: "1" };
    const inPlace = { id: "supertag.workspace.in-place", version: 1 };
    const mixed = worker({
      id: "mixed",
      type: "supertag",
      capabilities: [],
      profiles: [local, remote],
      contextTypes: [],
      profileCapabilities: [
        { harness: "claude-code", profile: local, capabilities: [inPlace], contextTypes: [] },
        { harness: "codex", profile: remote, capabilities: [], contextTypes: [] },
      ],
    });
    const described = await new LocalWorklet("w", "laptop", [mixed], {
      workspaces: ["app"],
      labels: ["GPU", "gpu"],
    }).describe();
    const os = { darwin: "macos", linux: "linux", win32: "windows" }[platform() as string];
    expect(described.host.workspaces).toEqual(["app"]);
    expect(described.host.labels).toEqual(
      [os ?? platform(), arch(), "gpu", "harness:claude-code", "harness:codex", "workspace:app"]
        .filter(Boolean)
        .sort(),
    );

    // No profile can use a checkout in place, so the host does not advertise it.
    const remoteOnly = worker({
      id: "remote-only",
      type: "supertag",
      capabilities: [],
      profiles: [remote],
      contextTypes: [],
      profileCapabilities: [
        { harness: "codex", profile: remote, capabilities: [], contextTypes: [] },
      ],
    });
    const withoutCheckout = await new LocalWorklet("w", "server", [remoteOnly], {
      workspaces: ["app"],
    }).describe();
    expect(withoutCheckout.host).not.toHaveProperty("workspaces");
    expect(withoutCheckout.host.labels).not.toContain("workspace:app");
    expect(() => new LocalWorklet("w", "bad", [], { labels: ["no spaces"] })).toThrow("is invalid");
  });

  it("records which Worker Hosts can serve each Workspace", () => {
    const at = "2026-09-29T00:00:00.000Z";
    const host = (id: string, workspaces: string[], connected = true): WorkerHost => ({
      id,
      credentialId: id,
      credentialRevision: 1,
      enrollmentStatus: "active",
      connectionGeneration: 1,
      connectionStatus: connected ? "connected" : "disconnected",
      workerSnapshot: { ...descriptor.host, id, workspaces },
      capacity: 1,
      availableSlots: 1,
      activeAttempts: 0,
      ready: true,
      draining: false,
      failedAuthenticationCount: 0,
      createdAt: at,
      updatedAt: at,
    });
    const hosts = [host("laptop", ["app"]), host("server", ["app", "docs"], false), host("ci", [])];
    const workspace: Workspace = {
      id: "workspace-1",
      name: "app",
      delivery: "branch",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    expect(workspaceResource(workspace, hosts).status).toEqual({
      phase: "active",
      workerHosts: [
        { id: "laptop", connectionStatus: "connected" },
        { id: "server", connectionStatus: "disconnected" },
      ],
    });
    expect(workerHostResource(hosts[1] as WorkerHost).status.workspaces).toEqual(["app", "docs"]);
    expect(workerHostResource(hosts[2] as WorkerHost).status.workspaces).toEqual([]);
  });
});
