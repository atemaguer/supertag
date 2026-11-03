import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import { createCodexWorker } from "../../packages/runtime/harnesses/codex/src/index.ts";
import {
  type GitHubRepositorySource,
  GitHubRepositoryWorkspaceResolver,
  type GitHubWorkerCredentialProvider,
} from "../../packages/runtime/resources/github/src/index.ts";
import { LocalWorklet, WorkspaceResolverRegistry } from "../../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../../packages/store/src/index.ts";
import { migrateSqlite } from "../support/database.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Permission-bounded GitHub target execution", () => {
  it("answers a Slack invocation from a request-selected, authorized GitHub workspace", async () => {
    const fixture = await createFixture(true);

    try {
      await fixture.controlPlane.start();
      await expect(
        fixture.controlPlane.ingestSurfaceEvent(slackInvocation()),
      ).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(fixture.reply).toHaveBeenCalledTimes(2));

      expect(fixture.reply.mock.calls.map((call) => call[1].markdown)).toEqual([
        "Got it. I’m looking into this in atemaguer/supertag now.",
        expect.stringMatching(/^Repository evidence: deployment writes/u),
      ]);
      expect(taskWorkspacePlan(fixture.databasePath)).toMatchObject({
        status: "selected",
        selectedBy: "request",
        target: { reference: "atemaguer/supertag", scope: "repository:123" },
      });
      expect(fixture.runner).toHaveBeenCalledOnce();
      expect(fixture.credentials.resolve).toHaveBeenCalledWith(fixture.githubAccountId);
      expect(fixture.source.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          surfaceAccountId: fixture.githubAccountId,
          repositoryId: "123",
        }),
      );
      const resolution = runtimeInputsPayload(fixture.databasePath);
      expect(resolution).toMatchObject({
        manifest: {
          workerProfile: { id: "cross-surface-codex", revision: "1" },
          inputs: [
            { id: "supertag-scratch-directory", kind: "instruction" },
            {
              kind: "workspace",
              resource: {
                digest: `git:${"c".repeat(40)}`,
                provenance: {
                  provider: "github",
                  repository: "atemaguer/supertag",
                  commitSha: "c".repeat(40),
                },
              },
            },
          ],
        },
      });
      expect(JSON.stringify(resolution)).not.toContain("worker-github-secret");
    } finally {
      await fixture.controlPlane.stop();
    }
  });

  it("automatically selects the originating GitHub repository", async () => {
    const fixture = await createFixture(true);

    try {
      await fixture.controlPlane.start();
      await expect(
        fixture.controlPlane.ingestSurfaceEvent(githubInvocation()),
      ).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(fixture.reply).toHaveBeenCalledTimes(2));

      expect(fixture.reply.mock.calls[1]?.[1].markdown).toMatch(/^Repository evidence:/u);
      expect(taskWorkspacePlan(fixture.databasePath)).toMatchObject({
        status: "selected",
        selectedBy: "origin",
      });
      expect(fixture.source.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          surfaceAccountId: fixture.githubAccountId,
          repositoryId: "123",
        }),
      );
      expect(runtimeInputsPayload(fixture.databasePath)).toMatchObject({
        manifest: {
          inputs: [
            { id: "supertag-scratch-directory", kind: "instruction" },
            {
              kind: "workspace",
              resource: { provenance: { targetSource: "origin" } },
            },
          ],
        },
      });
    } finally {
      await fixture.controlPlane.stop();
    }
  });

  it("fails before credentials or retrieval when the GitHub read permission is absent", async () => {
    const fixture = await createFixture(false);

    try {
      await fixture.controlPlane.start();
      await fixture.controlPlane.ingestSurfaceEvent(slackInvocation("slack-event-denied"));
      await vi.waitFor(() => expect(inboundStatus(fixture.databasePath)).toBe("failed"));

      await vi.waitFor(() => expect(fixture.reply).toHaveBeenCalledTimes(2));
      expect(fixture.reply.mock.calls.map((call) => call[1].markdown)).toEqual([
        "Got it. I’m looking into this in atemaguer/supertag now.",
        expect.stringContaining("not allowed to use GitHub repository atemaguer/supertag"),
      ]);
      expect(fixture.runner).not.toHaveBeenCalled();
      expect(fixture.credentials.resolve).not.toHaveBeenCalled();
      expect(fixture.source.resolve).not.toHaveBeenCalled();
    } finally {
      await fixture.controlPlane.stop();
    }
  });
});

async function createFixture(withPermission: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-cross-surface-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "supertag.db");
  await migrate(databasePath);
  const workspace = join(directory, "github-workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "deployment.txt"),
    "deployment writes release-primary and release-audit.\n",
  );
  const credentials = {
    resolve: vi.fn(async () => ({ token: "worker-github-secret" })),
  } satisfies GitHubWorkerCredentialProvider;
  const source = {
    resolve: vi.fn(async () => ({
      path: workspace,
      repositoryId: "123",
      fullName: "atemaguer/supertag",
      commitSha: "c".repeat(40),
      requestedRevision: "main",
    })),
  } satisfies GitHubRepositorySource;
  const runner = vi.fn(async function* ({
    workspace: stagedWorkspace,
  }: {
    readonly workspace: string;
  }) {
    const evidence = (await readFile(join(stagedWorkspace, "deployment.txt"), "utf8")).trim();
    yield { type: "output.message" as const, text: `Repository evidence: ${evidence}` };
  });
  const worker = createCodexWorker({
    workerId: "cross-surface-worker",
    profileId: "cross-surface-codex",
    profileRevision: "1",
    workspace: process.cwd(),
    workspaceResolvers: new WorkspaceResolverRegistry([
      new GitHubRepositoryWorkspaceResolver({ credentials, source }),
    ]),
    runner,
  });
  const store = new DrizzleStore({ url: `file:${databasePath}` });
  const reply = vi.fn(async () => undefined);
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
    worklet: new LocalWorklet("cross-surface-worklet", "cross-surface-host", [worker]),
    reply,
    dispatch: {
      pollIntervalMs: 5,
      retryBaseMs: 5,
      maxAttempts: 1,
      onDispatchError: () => undefined,
    },
  });
  await store.connect();
  const slack = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: "T123",
    displayName: "Acme",
    authMethod: "slack-socket-mode",
    credentialId: "test/slack",
    status: "connected",
    configuration: { transport: "socket" },
    verifiedAt: "2026-08-03T00:00:00.000Z",
  });
  const github = await store.saveSurfaceAccount({
    provider: "github",
    externalAccountId: "user-1",
    displayName: "atemaguer",
    authMethod: "github-token",
    credentialId: "test/github",
    status: "connected",
    configuration: { apiBaseUrl: "https://api.github.com" },
    verifiedAt: "2026-08-03T00:00:00.000Z",
  });
  const tag = await store.createTag({
    name: "engineering",
  });
  await store.bindTagWorkerHost(tag.id, "cross-surface-host");
  const slackSurface = await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: slack.id,
    scope: "channel:C123",
  });
  const githubSurface = await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: github.id,
    scope: "repository:123",
  });
  if (withPermission) {
    const permissionSet = await store.createTagPermissionSet({
      tagId: tag.id,
      name: "engineering-access",
    });
    await store.addTagPermission({
      target: "surface",
      permissionSetId: permissionSet.id,
      surfaceAccountId: github.id,
      scope: "repository:123",
      reference: "atemaguer/supertag",
      action: "contents:read",
    });
    await store.activateTagPermissionSet({
      permissionSetId: permissionSet.id,
      tagRouteId: slackSurface.id,
    });
    await store.activateTagPermissionSet({
      permissionSetId: permissionSet.id,
      tagRouteId: githubSurface.id,
    });
  }
  await store.disconnect();
  return {
    controlPlane,
    databasePath,
    githubAccountId: github.id,
    credentials,
    source,
    runner,
    reply,
  };
}

function slackInvocation(eventId = "slack-event-1") {
  return {
    eventId,
    logicalEventId: eventId,
    provider: "slack" as const,
    externalAccountId: "T123",
    kind: "mention" as const,
    scope: "channel:C123",
    sessionKey: "slack:T123:C123:thread-1",
    actor: { id: "U123", displayName: "Atem", kind: "user" as const },
    text: "@SuperTag In atemaguer/supertag, why does deployment create two release records?",
    occurredAt: "2026-08-03T00:00:00.000Z",
    callback: {
      provider: "slack" as const,
      mode: "slack_thread" as const,
      threadKey: "thread-1",
      target: { channel: "C123", threadTs: "thread-1" },
    },
    source: { channel: "C123" },
    metadata: {},
  };
}

function githubInvocation(eventId = "github-event-1") {
  return {
    eventId,
    logicalEventId: eventId,
    provider: "github" as const,
    externalAccountId: "user-1",
    kind: "mention" as const,
    scope: "repository:123",
    sessionKey: "github:user-1:repository:123:issue-1",
    actor: { id: "user-1", displayName: "Atem", kind: "user" as const },
    text: "@SuperTag Why does deployment create two release records?",
    occurredAt: "2026-08-03T00:00:00.000Z",
    callback: {
      provider: "github" as const,
      mode: "github_issue_comment" as const,
      threadKey: "issue-1",
      target: { repository: "atemaguer/supertag", issue: 1 },
    },
    source: { repository: "atemaguer/supertag" },
    metadata: {},
  };
}

async function migrate(databasePath: string): Promise<void> {
  await migrateSqlite(databasePath);
}

function inboundStatus(databasePath: string): string | undefined {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT status FROM DurableInboundEvent LIMIT 1").pluck().get() as
      | string
      | undefined;
  } finally {
    database.close();
  }
}

function runtimeInputsPayload(databasePath: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const payload = database
      .prepare(
        "SELECT payload FROM TaskEvent WHERE type = 'execution.runtime-inputs.resolved' LIMIT 1",
      )
      .pluck()
      .get();
    if (typeof payload !== "string") throw new Error("Runtime Input payload was not recorded");
    return JSON.parse(payload) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function taskWorkspacePlan(databasePath: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const value = database.prepare("SELECT workspacePlan FROM Task LIMIT 1").pluck().get();
    if (typeof value !== "string") throw new Error("Task workspace plan was not recorded");
    return JSON.parse(value) as Record<string, unknown>;
  } finally {
    database.close();
  }
}
