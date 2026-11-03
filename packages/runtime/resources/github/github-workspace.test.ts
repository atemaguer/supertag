import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskAttemptSpec } from "@supertag/worker-sdk";
import { create } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApiRepositorySource,
  type GitHubRepositorySource,
  GitHubRepositoryWorkspaceResolver,
  type GitHubWorkerCredentialProvider,
} from "./src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub repository request resolution", () => {
  it("fails before credentials or retrieval when an explicit repository is not permitted", async () => {
    const credentials = { resolve: vi.fn() } satisfies GitHubWorkerCredentialProvider;
    const source = { resolve: vi.fn() } satisfies GitHubRepositorySource;
    const resolver = new GitHubRepositoryWorkspaceResolver({ credentials, source });

    await expect(
      resolver.resolve({
        task: taskAttemptSpec({ text: "Explain this in other-org/private-repo" }),
        profile: workerProfile(),
      }),
    ).rejects.toThrow("not allowed");
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it("resolves a named, permission-bounded workspace without a Context Set", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ token: "worker-secret" })),
    } satisfies GitHubWorkerCredentialProvider;
    const source = {
      resolve: vi.fn(async () => ({
        path: "/tmp/supertag-repository",
        repositoryId: "123",
        fullName: "atemaguer/supertag",
        commitSha: "a".repeat(40),
        requestedRevision: "main",
      })),
    } satisfies GitHubRepositorySource;
    const resolver = new GitHubRepositoryWorkspaceResolver({ credentials, source });

    const input = await resolver.resolve({
      task: taskAttemptSpec({ text: "In atemaguer/supertag, how does this work?" }),
      profile: workerProfile(),
    });

    expect(input).toEqual({
      id: `github-workspace:123:${"a".repeat(40)}`,
      kind: "workspace",
      required: true,
      source: {
        uri: "file:///tmp/supertag-repository",
        digest: `git:${"a".repeat(40)}`,
        provenance: {
          provider: "github",
          surfaceAccountId: "github-account",
          repositoryId: "123",
          repository: "atemaguer/supertag",
          requestedRevision: "main",
          commitSha: "a".repeat(40),
          targetSource: "request",
        },
      },
      mountPath: "workspace",
      readOnly: true,
    });
    expect(JSON.stringify(input)).not.toContain("worker-secret");
    expect(source.resolve).toHaveBeenCalledWith({
      surfaceAccountId: "github-account",
      repositoryId: "123",
      credential: { token: "worker-secret" },
    });
  });

  it("selects the originating GitHub repository when no repository is named", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ token: "worker-secret" })),
    } satisfies GitHubWorkerCredentialProvider;
    const source = {
      resolve: vi.fn(async () => ({
        path: "/tmp/supertag-repository",
        repositoryId: "123",
        fullName: "atemaguer/supertag",
        commitSha: "b".repeat(40),
        requestedRevision: "main",
      })),
    } satisfies GitHubRepositorySource;
    const resolver = new GitHubRepositoryWorkspaceResolver({ credentials, source });

    const input = await resolver.resolve({
      task: taskAttemptSpec({ origin: "github", text: "How does this work?" }),
      profile: workerProfile(),
    });

    expect(input).toMatchObject({
      kind: "workspace",
      source: { provenance: { targetSource: "origin" } },
    });
    expect(source.resolve).toHaveBeenCalledWith({
      surfaceAccountId: "github-account",
      repositoryId: "123",
      credential: { token: "worker-secret" },
    });
  });

  it("asks for a repository instead of selecting arbitrarily among multiple permissions", async () => {
    const credentials = { resolve: vi.fn() } satisfies GitHubWorkerCredentialProvider;
    const source = { resolve: vi.fn() } satisfies GitHubRepositorySource;
    const resolver = new GitHubRepositoryWorkspaceResolver({ credentials, source });

    const input = await resolver.resolve({
      task: taskAttemptSpec({
        resources: [
          {
            surfaceAccountId: "github-account",
            provider: "github",
            scope: "repository:123",
            reference: "atemaguer/supertag",
            actions: ["contents:read"],
            sources: ["permission-set"],
          },
          {
            surfaceAccountId: "github-account",
            provider: "github",
            scope: "repository:456",
            reference: "atemaguer/other",
            actions: ["contents:read"],
            sources: ["permission-set"],
          },
        ],
      }),
      profile: workerProfile(),
    });

    expect(input).toMatchObject({
      id: "github-repository-selection-required",
      kind: "instruction",
      content: expect.stringContaining("atemaguer/other, atemaguer/supertag"),
    });
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it("resolves and caches an immutable GitHub archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-github-context-"));
    temporaryDirectories.push(directory);
    const archiveRoot = join(directory, "archive");
    const topLevel = join(archiveRoot, "atemaguer-supertag-commit");
    await mkdir(topLevel, { recursive: true });
    await writeFile(join(topLevel, "README.md"), "cross-surface context\n");
    const archive = join(directory, "repository.tar.gz");
    await create({ cwd: archiveRoot, file: archive, gzip: true }, ["atemaguer-supertag-commit"]);
    const commitSha = "b".repeat(40);
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/repositories/123")) {
        return Response.json({ id: 123, full_name: "atemaguer/supertag", default_branch: "main" });
      }
      if (path.endsWith("/repos/atemaguer/supertag/commits/main")) {
        return Response.json({ sha: commitSha });
      }
      if (path.endsWith(`/repos/atemaguer/supertag/tarball/${commitSha}`)) {
        return new Response(await readFile(archive), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const source = new GitHubApiRepositorySource({
      cacheDirectory: join(directory, "cache"),
      request,
    });

    const resolved = await source.resolve({
      surfaceAccountId: "github-account",
      repositoryId: "123",
      credential: { token: "worker-secret", apiBaseUrl: "https://api.github.test" },
    });
    const cached = await source.resolve({
      surfaceAccountId: "github-account",
      repositoryId: "123",
      credential: { token: "worker-secret", apiBaseUrl: "https://api.github.test" },
    });

    expect(resolved).toEqual({
      path: join(directory, "cache", "123", commitSha),
      repositoryId: "123",
      fullName: "atemaguer/supertag",
      commitSha,
      requestedRevision: "main",
    });
    expect(cached).toEqual(resolved);
    await expect(readFile(join(resolved.path, "README.md"), "utf8")).resolves.toBe(
      "cross-surface context\n",
    );
    expect(request.mock.calls.filter(([url]) => String(url).includes("/tarball/"))).toHaveLength(1);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer worker-secret",
    });
  });

  it("follows GitHub's archive redirect only to its trusted codeload host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-github-redirect-"));
    temporaryDirectories.push(directory);
    const archiveRoot = join(directory, "archive");
    const topLevel = join(archiveRoot, "atemaguer-supertag-commit");
    await mkdir(topLevel, { recursive: true });
    await writeFile(join(topLevel, "README.md"), "redirected archive\n");
    const archive = join(directory, "repository.tar.gz");
    await create({ cwd: archiveRoot, file: archive, gzip: true }, ["atemaguer-supertag-commit"]);
    const commitSha = "d".repeat(40);
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/repositories/123")) {
        return Response.json({ id: 123, full_name: "atemaguer/supertag", default_branch: "main" });
      }
      if (path.endsWith("/repos/atemaguer/supertag/commits/main")) {
        return Response.json({ sha: commitSha });
      }
      if (path.startsWith("https://api.github.com/") && path.includes("/tarball/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/atemaguer/supertag/tar.gz/${commitSha}`,
          },
        });
      }
      if (path.startsWith("https://codeload.github.com/")) {
        return new Response(await readFile(archive), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const source = new GitHubApiRepositorySource({
      cacheDirectory: join(directory, "cache"),
      request,
    });

    const resolved = await source.resolve({
      surfaceAccountId: "github-account",
      repositoryId: "123",
      credential: { token: "worker-secret" },
    });

    await expect(readFile(join(resolved.path, "README.md"), "utf8")).resolves.toBe(
      "redirected archive\n",
    );
    expect(request.mock.calls.at(-1)?.[0]).toBe(
      `https://codeload.github.com/atemaguer/supertag/tar.gz/${commitSha}`,
    );
    expect(request.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      authorization: "Bearer worker-secret",
    });
  });

  it("rejects an archive redirect to an untrusted host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-github-redirect-deny-"));
    temporaryDirectories.push(directory);
    const commitSha = "e".repeat(40);
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/repositories/123")) {
        return Response.json({ id: 123, full_name: "atemaguer/supertag", default_branch: "main" });
      }
      if (path.endsWith("/repos/atemaguer/supertag/commits/main")) {
        return Response.json({ sha: commitSha });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/archive.tar.gz" },
      });
    });
    const source = new GitHubApiRepositorySource({
      cacheDirectory: join(directory, "cache"),
      request,
    });

    await expect(
      source.resolve({
        surfaceAccountId: "github-account",
        repositoryId: "123",
        credential: { token: "worker-secret" },
      }),
    ).rejects.toThrow("untrusted host");
    expect(request).toHaveBeenCalledTimes(3);
  });
});

function taskAttemptSpec(
  overrides: {
    readonly actions?: readonly string[];
    readonly origin?: "github" | "slack";
    readonly resources?: TaskAttemptSpec["authorization"]["resources"];
    readonly text?: string;
  } = {},
): TaskAttemptSpec {
  const origin = overrides.origin ?? "slack";
  const originAccount = origin === "github" ? "github-account" : "slack-account";
  const originScope = origin === "github" ? "repository:123" : "channel:C123";
  const text = overrides.text ?? "How does this work?";
  const resources = overrides.resources ?? [
    {
      surfaceAccountId: "github-account",
      provider: "github" as const,
      scope: "repository:123",
      reference: "atemaguer/supertag",
      actions: overrides.actions ?? ["contents:read"],
      sources:
        origin === "github"
          ? (["permission-set", "origin"] as const)
          : (["permission-set"] as const),
    },
  ];
  const eligible = resources.filter(
    (resource) => resource.provider === "github" && resource.actions.includes("contents:read"),
  );
  const requestedReference = /(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/u.exec(text)?.[1];
  const requested = requestedReference !== undefined;
  const requestedTarget = eligible.find(
    (resource) => resource.reference?.toLowerCase() === requestedReference?.toLowerCase(),
  );
  const workspacePlan: TaskAttemptSpec["workspacePlan"] =
    requested && requestedTarget === undefined
      ? { version: 1, status: "unavailable", requested: [requestedReference] }
      : origin === "github" && eligible[0] !== undefined
        ? { version: 1, status: "selected", selectedBy: "origin", target: eligible[0] }
        : requestedTarget !== undefined
          ? { version: 1, status: "selected", selectedBy: "request", target: requestedTarget }
          : eligible.length === 1 && eligible[0] !== undefined
            ? { version: 1, status: "selected", selectedBy: "default", target: eligible[0] }
            : eligible.length > 1
              ? { version: 1, status: "selection-required", choices: eligible }
              : { version: 1, status: "none" };
  return {
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "engineering" },
    input: {
      origin: {
        surface: origin,
        accountId: originAccount,
        scope: originScope,
        sessionKey: `${origin}:${originAccount}:${originScope}:thread-1`,
        occurredAt: "2026-08-03T00:00:00.000Z",
      },
      messages: [{ id: "message-1", role: "requester", text }],
    },
    authorization: {
      version: 5,
      capturedAt: "2026-08-03T00:00:00.000Z",
      tag: {
        id: "tag-1",
        name: "engineering",
      },
      origin: {
        tagRouteId: `${origin}-surface`,
        surfaceAccountId: originAccount,
        provider: origin,
        scope: originScope,
      },
      requester: { id: "U123", kind: "user" },
      permissionSets: [{ id: "permission-set-1", name: "engineering-access" }],
      resources,
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: "2026-08-03T00:00:00.000Z", sets: [] },
    workspacePlan,
    execution: {},
    workerProfile: { id: "local-codex", revision: "1" },
  };
}

function workerProfile() {
  return {
    ref: { id: "local-codex", revision: "1" },
    workerType: "supertag",
    harness: { provider: "codex" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
}
