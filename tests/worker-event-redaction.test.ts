import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildTaskResult } from "../packages/control-plane/src/task-results.js";
import { type DurableInboundEvent, emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  DurableLocalWorklet,
  defaultTaskResult,
  FileAttemptJournal,
  type Harness,
  type HarnessEvent,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type TaskAttemptSpec,
  type ToolCall,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { captureTestArtifact } from "./support/captured-artifact.js";

it.each(["worker", "journal", "custom"] as const)(
  "redacts event and stored result copies without mutating execution data (%s)",
  async (mode) => {
    const hostSecret = "host-secret-credential";
    const explicitSecret = "explicit-secret-credential";
    const secret = `${hostSecret}-${explicitSecret}`;
    vi.stubEnv("SUPERTAG_PROBE_SECRET", hostSecret);
    // This password must not rewrite the executable supertag-artifact: URI.
    vi.stubEnv("SUPERTAG_POSTGRES_URL", "postgresql://supertag:supertag@localhost/db");
    const directory = await mkdtemp(join(tmpdir(), "worker-event-redaction-"));
    const url = `file:${join(directory, "store.db")}`;
    let store: DrizzleStore | undefined;
    let durable: DurableLocalWorklet | undefined;
    const uri = `supertag-artifact:sha256:${"a".repeat(64)}`;
    // Artifact selections must use credential-free names to remain executable.
    const selectedPath = "reports/report.txt";
    const reference = `https://example.test/${secret}`;
    const artifact = {
      id: "artifact-1",
      uri: reference,
      name: secret,
      path: `${secret}/report.txt`,
      provenance: { source: secret },
    };
    const sessionState = { ...artifact, id: "session-state-1", format: "probe-session" };
    const call: ToolCall = {
      id: "call-1",
      capabilityId: "github",
      provider: "github",
      binding: { kind: "mcp-http", name: "github" },
      operation: "create_issue",
      effect: "write",
      actions: ["issues:write"],
      resources: [{ surfaceAccountId: "account-1", scope: secret, reference }],
      arguments: { uri, body: secret, issueId: secret },
    };
    const outcome = { references: [reference] };
    const result = {
      ...defaultTaskResult(secret),
      changes: [{ summary: secret, reference }],
      references: [
        {
          provider: "github" as const,
          resourceType: "issue" as const,
          resourceId: secret,
          reference,
          relationship: "changed" as const,
        },
      ],
      findings: [{ id: "F1", severity: "low" as const, summary: secret, location: reference }],
      artifacts: [{ artifactId: "artifact-1", paths: [selectedPath] }],
    };
    const probeEvents: Exclude<HarnessEvent, { type: "output.message" }>[] = [
      { type: "tool.call.started", call },
      { type: "tool.call.completed", call, outcome },
      { type: "tool.call.failed", call, error: { message: secret } },
      { type: "artifact.created", artifact },
      { type: "session.updated", sessionState },
      { type: "artifact.created", artifact: { ...artifact, uri } },
      { type: "session.updated", sessionState: { ...sessionState, uri } },
      {
        type: "usage.updated",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          totalTokens: 2,
          complete: true,
          unpricedModel: secret,
        },
      },
      { type: "result", result },
    ];
    let executionObserved = false;
    const artifactRead = vi.fn(async (resource: { uri: string }) => {
      expect(resource.uri).toBe(uri);
      return Buffer.from("artifact input");
    });
    const artifactWrite = vi.fn(async () => artifact);
    const harness: Harness = {
      id: "probe",
      describe: async () => ({
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "probe",
        version: "1",
        inputKinds: [],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
      }),
      plan: async () => {
        const plan = {
          files: [],
          mounts: [],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" as const },
        };
        return {
          runtime: plan,
          execution: {
            ...plan,
            files: [{ path: "output.txt", content: "generated output" }],
            mounts: [{ source: { uri }, destination: "input.txt", readOnly: true }],
          },
          outputs: [{ path: "output.txt", name: secret }],
        };
      },
      start: async (_plan, _runtime, context) => ({
        async *run() {
          expect(context.attempt.input.attachments?.[0]?.uri).toBe(uri);
          yield* probeEvents;
          // An adapter may reconcile effects after reporting them. Its objects remain raw.
          expect(call.arguments).toEqual({ uri, body: secret, issueId: secret });
          expect(outcome.references).toEqual([reference]);
          expect(result.references[0]?.reference).toBe(reference);
          executionObserved = true;
        },
        sessionState: async () => sessionState,
        close: async () => {},
      }),
    };
    const profile = {
      ref: { id: "probe", revision: "1" },
      workerType: "supertag",
      harness: { provider: "probe" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
    };
    const builtin = createWorker({
      id: "probe-worker",
      profiles: [profile],
      harnesses: [harness],
      environments: [new LocalExecutionEnvironmentProvider()],
      redactValues: [explicitSecret],
      artifactStore: {
        get: artifactRead,
        put: artifactWrite,
      },
    });
    const worker: Worker =
      mode === "custom"
        ? {
            describe: () => builtin.describe(),
            async *execute(spec) {
              for (const event of probeEvents)
                yield { ...event, taskId: spec.taskId, attemptId: spec.attemptId, at: "now" };
              yield {
                type: "execution.completed",
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: "now",
              };
            },
          }
        : builtin;
    const at = "2026-08-02T00:00:00.000Z";
    const spec: TaskAttemptSpec = {
      version: 1,
      taskId: "task-1",
      attemptId: "attempt-1",
      tag: { id: "tag-1", name: "Probe" },
      input: {
        origin: {
          surface: "slack",
          accountId: "account-1",
          scope: "channel:general",
          sessionKey: "session-1",
          occurredAt: at,
        },
        messages: [],
        attachments: [{ uri }],
      },
      authorization: {
        version: 5,
        capturedAt: at,
        tag: { id: "tag-1", name: "Probe" },
        origin: {
          tagRouteId: "route-1",
          surfaceAccountId: "account-1",
          provider: "slack",
          scope: "channel:general",
        },
        requester: { id: "user-1", kind: "user" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
      contextPlan: emptyTagContextPlan(at),
      execution: {},
      workerProfile: profile.ref,
    };
    try {
      // Custom Workers have no createWorker options: the journal learns this secret from the host.
      if (mode === "custom") vi.stubEnv("SUPERTAG_CUSTOM_SECRET", explicitSecret);
      durable =
        mode === "worker"
          ? undefined
          : new DurableLocalWorklet(
              new LocalWorklet("local", "host", [worker]),
              new FileAttemptJournal(join(directory, "journal")),
            );
      const events = [];
      if (durable) {
        await durable.accept(spec);
        for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
        expect(await durable.inspect(spec.attemptId)).toMatchObject({ status: "completed" });
      } else events.push(...(await collectTaskAttemptEvents(worker.execute(spec))));
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(probeEvents.map((event) => event.type)),
      );
      if (mode !== "custom") {
        expect(executionObserved).toBe(true);
        expect(artifactRead).toHaveBeenCalledExactlyOnceWith({ uri });
        expect(artifactWrite).toHaveBeenCalledExactlyOnceWith({
          bytes: Buffer.from("generated output"),
          name: secret,
        });
        expect(events.filter((event) => event.type === "artifact.created")).toHaveLength(3);
        expect(events.filter((event) => event.type === "session.updated")).toHaveLength(3);
      }
      expect.soft(events).toContainEqual(
        expect.objectContaining({
          type: "artifact.created",
          artifact: expect.objectContaining({ uri }),
        }),
      );
      expect.soft(events).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          sessionState: expect.objectContaining({ uri }),
        }),
      );
      for (const event of events) {
        const diagnostic =
          event.type === "result"
            ? { ...event, result: { ...event.result, artifacts: [] } }
            : event;
        expect.soft(JSON.stringify(diagnostic), event.type).not.toContain(hostSecret);
        expect.soft(JSON.stringify(diagnostic), event.type).not.toContain(explicitSecret);
      }
      // Surface settlement adds references and changes from tool outcome events.
      const work = {
        surfaceAccountId: "account-1",
        event: {
          provider: "slack",
          externalAccountId: "slack-1",
          source: { channelId: "general" },
          scope: "channel:general",
        },
      } as DurableInboundEvent;
      const canonical = buildTaskResult(work, "done", events);
      expect(
        canonical.references.filter((ref) => ref.relationship === "changed").length,
      ).toBeGreaterThan(0);
      expect.soft(canonical.changes).toContainEqual({
        summary: expect.any(String),
        reference: "https://example.test/[REDACTED]-[REDACTED]",
      });
      await migrateDatabase({ url });
      store = new DrizzleStore({ url });
      await store.connect();
      const owner = await store.createTag({ name: "owner" });
      await store.bindTagWorkerHost(owner.id, "fixture-host");
      const at = new Date().toISOString();
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: "T0PROBE",
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: at,
      });
      const route = await store.addTagRoute({
        tagId: owner.id,
        surfaceAccountId: account.id,
        scope: "channel:probe",
      });
      const authorization = {
        version: 5,
        capturedAt: at,
        tag: { id: owner.id, name: owner.name },
        origin: {
          provider: "slack",
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          scope: "channel:probe",
        },
        requester: { id: "human", kind: "user" },
        roles: [],
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      } as const;
      const contextPlan = emptyTagContextPlan(at);
      const inbound = {
        eventId: "probe-event",
        logicalEventId: "probe-event",
        provider: "slack",
        externalAccountId: account.externalAccountId,
        kind: "message",
        scope: "channel:probe",
        sessionKey: "conversation",
        actor: { id: "human", kind: "user" },
        text: "Probe",
        occurredAt: at,
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: "conversation",
          target: { channelId: "probe", threadTs: "conversation" },
        },
        source: {},
        metadata: {},
      } as const;
      const admitted = await store.admitInboundEvent({
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        tagId: owner.id,
        authorization,
        contextPlan,
        event: inbound,
      });
      const session = await store.openSession({
        tagId: owner.id,
        sessionKey: "conversation",
        origin: {},
        at,
      });
      const task = await store.openTask({
        inboundEventId: admitted.work.id,
        tagId: owner.id,
        sessionId: session.id,
        execution: {},
        actor: inbound.actor,
        trigger: {},
        workspacePlan: { version: 1, status: "none" },
        sessionHistory: [],
        authorizationSnapshot: authorization,
        contextPlan,
        createdAt: at,
      });
      const captured = await captureTestArtifact(store, task.id, { path: selectedPath });
      expect.soft(canonical.artifacts[0]?.paths).toEqual([selectedPath]);
      await store.closeTask({
        taskId: task.id,
        status: "completed",
        endedAt: new Date().toISOString(),
        responseText: canonical.summary,
        result: {
          ...canonical,
          artifacts: canonical.artifacts.map((selection) => ({
            ...selection,
            artifactId: captured.id,
          })),
        },
      });
      const stored = (await store.findTaskById(task.id))?.result;
      expect(stored).toBeDefined();
      expect(stored?.artifacts).toEqual([{ artifactId: captured.id, paths: [selectedPath] }]);
      const storedDiagnostics = { ...stored, artifacts: [] };
      expect.soft(JSON.stringify(storedDiagnostics)).not.toContain(hostSecret);
      expect.soft(JSON.stringify(storedDiagnostics)).not.toContain(explicitSecret);
      if (durable) {
        await durable.close();
        durable = new DurableLocalWorklet(
          new LocalWorklet("local", "host", [worker]),
          new FileAttemptJournal(join(directory, "journal")),
        );
        const replay = [];
        for await (const entry of durable.events(spec.attemptId)) replay.push(entry.event);
        expect(replay).toEqual(events);
      }
    } finally {
      await durable?.close();
      await store?.disconnect();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
