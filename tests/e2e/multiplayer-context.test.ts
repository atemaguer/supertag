import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane, type OutboundReplyHandler } from "../../packages/control-plane/src/index.ts";
import { createCodexWorker } from "../../packages/runtime/harnesses/codex/src/index.ts";
import {
  type GitHubRepositorySource,
  GitHubRepositoryWorkspaceResolver,
  type GitHubWorkerCredentialProvider,
} from "../../packages/runtime/resources/github/src/index.ts";
import {
  ArtifactContextResolver,
  ContextResolverRegistry,
  LocalWorklet,
  type TaskAttemptSpec,
  WorkspaceResolverRegistry,
} from "../../packages/runtime/sdk/src/index.ts";
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

describe("multiplayer work continuity", () => {
  it("restores canonical same-Session history without making chat into reusable artifacts", {
    timeout: 60_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-session-continuity-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "supertag.db");
    await migrate(databasePath);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "release.txt"), "release-primary\n");
    const prompts: string[] = [];
    const runner = vi.fn(async function* ({ prompt }: { readonly prompt: string }) {
      prompts.push(prompt);
      yield {
        type: "output.message" as const,
        text: prompt.includes("<supertag-history>")
          ? "The earlier Task established release-primary."
          : "Deployment uses release-primary.",
      };
    });
    const worker = createCodexWorker({
      workerId: "session-worker",
      profileId: "session-codex",
      profileRevision: "1",
      workspace,
      contextResolvers: new ContextResolverRegistry([new ArtifactContextResolver()]),
      runner,
    });
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const { reply, waitForFinalReply } = recordReplies();
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      worklet: new LocalWorklet("session-worklet", "session-host", [worker]),
      reply,
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5, maxAttempts: 1 },
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
    const tag = await store.createTag({
      name: "engineering",
    });
    await store.bindTagWorkerHost(tag.id, "session-host");
    const slackRoute = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: slack.id,
      scope: "channel:C123",
    });
    const contextSet = await store.createTagContextSet({
      tagId: tag.id,
      name: "shared-channel-work",
    });
    await store.addTagContextItem({
      contextSetId: contextSet.id,
      itemKey: `artifacts:${slackRoute.id}:shared-resource`,
      type: "supertag/artifacts",
      version: 1,
      required: true,
      config: {
        sourceRouteId: slackRoute.id,
        selection: {
          match: "shared-resource",
          maxAgeDays: 30,
          limit: 5,
        },
      },
    });
    await store.activateTagContextSet({
      contextSetId: contextSet.id,
      tagRouteId: slackRoute.id,
    });
    await store.disconnect();

    try {
      await controlPlane.start();
      await controlPlane.ingestSurfaceEvent(slackInvocation());
      await waitForFinalReply(1);
      expect(prompts).toHaveLength(1);
      await controlPlane.ingestSurfaceEvent({
        ...slackInvocation(),
        eventId: "slack-alice-2",
        logicalEventId: "slack-alice-2",
        text: "@SuperTag What did we establish earlier in this thread?",
        occurredAt: "2026-08-03T00:01:00.000Z",
      });
      await waitForFinalReply(2);
      expect(prompts).toHaveLength(2);
      await controlPlane.ingestSurfaceEvent({
        ...slackInvocation(),
        eventId: "slack-bob-1",
        logicalEventId: "slack-bob-1",
        sessionKey: "slack:T123:C123:thread-bob",
        actor: { id: "U-BOB", displayName: "Bob", kind: "user" },
        text: "@SuperTag What did the other thread establish?",
        occurredAt: "2026-08-03T00:02:00.000Z",
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: "thread-bob",
          target: { channelId: "C123", threadTs: "thread-bob" },
        },
      });
      await waitForFinalReply(3);
      expect(prompts).toHaveLength(3);

      expect(prompts[0]).not.toContain("<supertag-history>");
      expect(prompts[1]).toContain("automatic continuity from the current Session");
      expect(prompts[1]).toContain("Deployment uses release-primary.");
      expect(prompts[2]).not.toContain("<supertag-history>");
      expect(prompts[2]).not.toContain("<supertag-artifacts>");
      expect(prompts[2]).not.toContain("Deployment uses release-primary.");
      expect((await store.listCapturedArtifacts({})).artifacts).toEqual([]);
      expect(reply).toHaveBeenCalledTimes(6);
      expect(finalReplyTexts(reply)[1]).toMatch(/^The earlier Task established release-primary\./u);
    } finally {
      await controlPlane.stop();
    }
  });

  it("selects captured Slack artifacts for a related GitHub Task and nothing else", {
    timeout: 60_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-multiplayer-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "supertag.db");
    await migrate(databasePath);
    const workspace = join(directory, "github-workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "deployment.txt"), "deployment uses release-primary\n");
    const credentials = {
      resolve: vi.fn(async () => ({ token: "worker-secret" })),
    } satisfies GitHubWorkerCredentialProvider;
    const source = {
      resolve: vi.fn(async ({ repositoryId }: { readonly repositoryId: string }) => ({
        path: workspace,
        repositoryId,
        fullName: repositoryId === "123" ? "atemaguer/supertag" : "atemaguer/unrelated",
        commitSha: repositoryId === "123" ? "a".repeat(40) : "b".repeat(40),
        requestedRevision: "main",
      })),
    } satisfies GitHubRepositorySource;
    const prompts: string[] = [];
    let currentAttempt: TaskAttemptSpec;
    const runner = vi.fn(async function* ({ prompt }: { readonly prompt: string }) {
      prompts.push(prompt);
      if (prompt.includes("<supertag-artifacts>")) {
        yield {
          type: "output.message" as const,
          text: "Alice's artifact established release-primary.",
        };
        return;
      }
      if (!prompt.includes("Has anyone already established")) {
        const summary = prompt.includes("restricted deployment path")
          ? "The restricted deployment path is release-secret."
          : "The deployment path uses release-primary; no code change was required.";
        const digest = `sha256:${"a".repeat(64)}`;
        await store.recordArtifactUpload({
          taskId: currentAttempt.taskId,
          attemptId: currentAttempt.attemptId,
          digest,
          sizeBytes: 12,
        });
        if (!currentAttempt.session) throw new Error("Expected a Session");
        await store.commitCapturedArtifact({
          operationId: "capture-deployment",
          taskId: currentAttempt.taskId,
          attemptId: currentAttempt.attemptId,
          tagId: currentAttempt.authorization.tag.id,
          sessionId: currentAttempt.session.id,
          title: "Deployment investigation",
          summary,
          kind: "research",
          entries: [
            {
              path: "deployment.md",
              uri: `supertag-artifact:${digest}`,
              digest,
              sizeBytes: 12,
              mediaType: "text/markdown",
            },
          ],
        });
        yield { type: "output.message" as const, text: summary };
        if (prompt.includes("restricted deployment path")) {
          // A Worker may report arbitrary references, but cannot change its Task's source.
          yield {
            type: "result" as const,
            result: {
              summary,
              decisions: [],
              changes: [],
              unresolved: [],
              findings: [],
              artifacts: [],
              references: [
                {
                  provider: "slack" as const,
                  surfaceAccountId: slack.id,
                  resourceType: "channel" as const,
                  resourceId: "C123",
                  reference: "slack:T123:C123",
                  relationship: "originated-in" as const,
                },
              ],
            },
          };
        }
        return;
      }
      yield {
        type: "output.message" as const,
        text: prompt.includes("Has anyone already established")
          ? "No related prior work was selected for this repository."
          : "The deployment path uses release-primary; no code change was required.",
      };
    });
    const worker = createCodexWorker({
      workerId: "multiplayer-worker",
      profileId: "multiplayer-codex",
      profileRevision: "1",
      workspace: process.cwd(),
      contextResolvers: new ContextResolverRegistry([new ArtifactContextResolver()]),
      workspaceResolvers: new WorkspaceResolverRegistry([
        new GitHubRepositoryWorkspaceResolver({ credentials, source }),
      ]),
      runner,
    });
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const { reply, waitForFinalReply } = recordReplies();
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      worklet: new LocalWorklet("multiplayer-worklet", "multiplayer-host", [
        {
          id: worker.id,
          describe: () => worker.describe(),
          execute: (spec, signal) => {
            currentAttempt = spec;
            return worker.execute(spec, signal);
          },
        },
      ]),
      reply,
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5, maxAttempts: 1 },
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
      externalAccountId: "installation-42",
      displayName: "Acme GitHub",
      authMethod: "github-app",
      credentialId: "test/github",
      status: "connected",
      configuration: { installationId: "42" },
      verifiedAt: "2026-08-03T00:00:00.000Z",
    });
    const restrictedGitHub = await store.saveSurfaceAccount({
      provider: "github",
      externalAccountId: "installation-99",
      displayName: "Restricted GitHub",
      authMethod: "github-app",
      credentialId: "test/github-restricted",
      status: "connected",
      configuration: { installationId: "99" },
      verifiedAt: "2026-08-03T00:00:00.000Z",
    });
    const tag = await store.createTag({
      name: "engineering",
    });
    await store.bindTagWorkerHost(tag.id, "multiplayer-host");
    const slackSurface = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: slack.id,
      scope: "channel:C123",
    });
    const privateSlackSurface = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: slack.id,
      scope: "channel:C999",
    });
    const githubSurface = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: github.id,
      scope: "repository:123",
    });
    const unrelatedGitHubSurface = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: github.id,
      scope: "repository:456",
    });
    const restrictedGitHubSurface = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: restrictedGitHub.id,
      scope: "repository:123",
    });
    const permissions = await store.createTagPermissionSet({
      tagId: tag.id,
      name: "repository-read",
    });
    await store.addTagPermission({
      target: "surface",
      permissionSetId: permissions.id,
      surfaceAccountId: github.id,
      scope: "repository:123",
      reference: "atemaguer/supertag",
      action: "contents:read",
    });
    await store.addTagPermission({
      target: "surface",
      permissionSetId: permissions.id,
      surfaceAccountId: github.id,
      scope: "repository:456",
      reference: "atemaguer/unrelated",
      action: "contents:read",
    });
    const restrictedPermissions = await store.createTagPermissionSet({
      tagId: tag.id,
      name: "restricted-repository-read",
    });
    await store.addTagPermission({
      target: "surface",
      permissionSetId: restrictedPermissions.id,
      surfaceAccountId: restrictedGitHub.id,
      scope: "repository:123",
      reference: "atemaguer/supertag",
      action: "contents:read",
    });
    for (const tagRouteId of [
      slackSurface.id,
      privateSlackSurface.id,
      githubSurface.id,
      unrelatedGitHubSurface.id,
    ]) {
      await store.activateTagPermissionSet({ permissionSetId: permissions.id, tagRouteId });
    }
    await store.activateTagPermissionSet({
      permissionSetId: restrictedPermissions.id,
      tagRouteId: restrictedGitHubSurface.id,
    });
    const contextSet = await store.createTagContextSet({
      tagId: tag.id,
      name: "related-engineering-work",
    });
    await store.addTagContextItem({
      contextSetId: contextSet.id,
      itemKey: `artifacts:${slackSurface.id}:shared-resource`,
      type: "supertag/artifacts",
      version: 1,
      required: true,
      config: {
        sourceRouteId: slackSurface.id,
        selection: {
          match: "shared-resource",
          maxAgeDays: 30,
          limit: 5,
        },
      },
    });
    for (const tagRouteId of [githubSurface.id, unrelatedGitHubSurface.id]) {
      await store.activateTagContextSet({ contextSetId: contextSet.id, tagRouteId });
    }
    await store.disconnect();

    try {
      await controlPlane.start();
      await controlPlane.ingestSurfaceEvent(slackInvocation());
      await waitForFinalReply(1);
      expect(prompts).toHaveLength(1);

      const [artifact] = (await store.listCapturedArtifacts({})).artifacts;
      expect(artifact).toMatchObject({
        title: "Deployment investigation",
        kind: "research",
        summary: "The deployment path uses release-primary; no code change was required.",
        attemptId: expect.any(String),
        taskId: expect.any(String),
        tagId: tag.id,
      });
      if (!artifact) throw new Error("Expected captured research artifact");

      await controlPlane.ingestSurfaceEvent({
        ...slackInvocation(),
        eventId: "slack-private-1",
        logicalEventId: "slack-private-1",
        scope: "channel:C999",
        sessionKey: "slack:T123:C999:thread-private",
        text: "@SuperTag Inspect atemaguer/supertag for the restricted deployment path.",
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: "thread-private",
          target: { channelId: "C999", threadTs: "thread-private" },
        },
        source: { channelId: "C999" },
      });
      await waitForFinalReply(2);
      expect(prompts).toHaveLength(2);
      const privateArtifact = (await store.listCapturedArtifacts({})).artifacts.find((entry) =>
        entry.summary?.includes("release-secret"),
      );
      if (!privateArtifact) throw new Error("Expected the private captured artifact");
      const privateTask = await store.findTaskById(privateArtifact.taskId);
      expect(privateTask?.result?.references).toContainEqual(
        expect.objectContaining({
          provider: "slack",
          resourceId: "C123",
          relationship: "originated-in",
        }),
      );
      expect(privateTask?.trigger["origin"]).toMatchObject({ scope: "channel:C999" });

      await controlPlane.ingestSurfaceEvent(githubInvocation());
      await waitForFinalReply(3);
      expect(prompts).toHaveLength(3);

      expect(runner).toHaveBeenCalledTimes(3);
      expect(prompts[2]).toContain("<supertag-artifacts>");
      expect(prompts[2]).toContain(artifact.id);
      expect(prompts[2]).toContain(artifact.attemptId);
      expect(prompts[2]).toContain("The deployment path uses release-primary");
      expect(prompts[2]).not.toContain("release-secret");
      expect(prompts[2]).not.toContain(privateArtifact.id);
      expect(prompts[2]).toContain('"provider":"slack"');
      expect(prompts[2]).toContain("inspect_artifact");
      expect(finalReplyTexts(reply)[2]).toMatch(/^Alice's artifact established release-primary\./u);

      await controlPlane.ingestSurfaceEvent(
        githubInvocation({
          eventId: "github-unrelated-1",
          repositoryId: "456",
          repository: "atemaguer/unrelated",
          issue: 12,
        }),
      );
      await waitForFinalReply(4);
      expect(prompts).toHaveLength(4);
      expect(prompts[3]).not.toContain("<supertag-artifacts>");
      expect(finalReplyTexts(reply)[3]).toMatch(
        /^No related prior work was selected for this repository\./u,
      );

      await controlPlane.ingestSurfaceEvent(
        githubInvocation({
          eventId: "github-outside-audience-1",
          externalAccountId: "installation-99",
        }),
      );
      await waitForFinalReply(5);
      expect(prompts).toHaveLength(5);
      expect(prompts[4]).not.toContain("<supertag-artifacts>");
      expect(finalReplyTexts(reply)[4]).toMatch(
        /^No related prior work was selected for this repository\./u,
      );

      await expect(
        controlPlane.ingestSurfaceEvent({
          ...slackInvocation(),
          eventId: "slack-outsider-1",
          logicalEventId: "slack-outsider-1",
          scope: "channel:C888",
          sessionKey: "slack:T123:C888:thread-outsider",
          source: { channelId: "C888" },
        }),
      ).resolves.toMatchObject({ status: "unconfigured" });
      expect(runner).toHaveBeenCalledTimes(5);
      expect((await store.listCapturedArtifacts({})).artifacts).toHaveLength(2);
    } finally {
      await controlPlane.stop();
    }
  });
});

/** Follow-ups need the completed Task, not a one-second deadline for dispatch under load. */
function recordReplies() {
  let completed = 0;
  const pending = new Map<number, () => void>();
  const reply = vi.fn<OutboundReplyHandler>(async (_event, presentation) => {
    if (presentation.kind === "final-result") {
      completed += 1;
      pending.get(completed)?.();
      pending.delete(completed);
    }
    return undefined;
  });
  return {
    reply,
    waitForFinalReply: (count: number): Promise<void> => {
      if (completed >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        // Fail inside the test so its finally block stops the Control Plane before teardown.
        const timeout = setTimeout(() => {
          pending.delete(count);
          reject(new Error(`Timed out waiting for final reply ${count}`));
        }, 10_000);
        pending.set(count, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

function finalReplyTexts(reply: ReturnType<typeof vi.fn>): readonly string[] {
  return reply.mock.calls
    .filter((call) => call[1]?.kind === "final-result")
    .map((call) => call[1]?.markdown)
    .filter((text): text is string => typeof text === "string");
}

function slackInvocation() {
  return {
    eventId: "slack-alice-1",
    logicalEventId: "slack-alice-1",
    provider: "slack" as const,
    externalAccountId: "T123",
    kind: "mention" as const,
    scope: "channel:C123",
    sessionKey: "slack:T123:C123:thread-alice",
    actor: { id: "U-ALICE", displayName: "Alice", kind: "user" as const },
    text: "@SuperTag In atemaguer/supertag, which release path does deployment use?",
    occurredAt: "2026-08-03T00:00:00.000Z",
    callback: {
      provider: "slack" as const,
      mode: "slack_thread" as const,
      threadKey: "thread-alice",
      target: { channelId: "C123", threadTs: "thread-alice" },
    },
    source: { channelId: "C123" },
    metadata: {},
  };
}

function githubInvocation(
  options: {
    readonly eventId?: string;
    readonly externalAccountId?: string;
    readonly repositoryId?: string;
    readonly repository?: string;
    readonly issue?: number;
  } = {},
) {
  const eventId = options.eventId ?? "github-bob-1";
  const externalAccountId = options.externalAccountId ?? "installation-42";
  const repositoryId = options.repositoryId ?? "123";
  const repository = options.repository ?? "atemaguer/supertag";
  const issue = options.issue ?? 77;
  return {
    eventId,
    logicalEventId: eventId,
    provider: "github" as const,
    externalAccountId,
    kind: "mention" as const,
    scope: `repository:${repositoryId}`,
    sessionKey: `github:${externalAccountId}:${repository}:issue:${issue}`,
    actor: { id: "U-BOB", displayName: "Bob", kind: "user" as const },
    text: "@SuperTag Has anyone already established which release path we use?",
    occurredAt: "2026-08-03T00:05:00.000Z",
    callback: {
      provider: "github" as const,
      mode: "github_issue_comment" as const,
      threadKey: `issue-${issue}`,
      target: { repository, issue },
    },
    source: {
      repositoryId,
      repository,
      number: String(issue),
      url: `https://github.com/${repository}/issues/${issue}`,
    },
    metadata: {},
  };
}

async function migrate(databasePath: string): Promise<void> {
  await migrateSqlite(databasePath);
}
