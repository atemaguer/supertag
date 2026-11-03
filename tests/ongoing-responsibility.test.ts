import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import type { CapturedArtifact, TaskAssignment, Team } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { hostArtifactStore } from "./support/host-artifact-store.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

// A deterministic application of the existing primitives, with real HTTP authorization,
// durable Worklet cleanup, artifact bytes, database recovery, and optimistic updates.
it.each([false, true])(
  "maintains a responsibility across observations and restart (conflict=%s)",
  async (conflict) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-responsibility-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const owner = await store.createTag({ name: "support-manager" });
    const specialist = await store.createTag({ name: "support-analyst" });
    const role = await store.createRole({
      name: "Support Policy Owner",
      purpose: "Maintain a reviewed response policy for overdue support tickets.",
      instructions:
        "Observe incident reports, review exact proposals, preserve concurrent edits, and wait when no action is needed.",
    });
    await store.assignRole({ roleId: role.id, tagId: owner.id });
    for (const tag of [owner, specialist]) await store.bindTagWorkerHost(tag.id, "support-host");
    await store.createObjective({
      id: "support",
      ownerTagId: owner.id,
      outcome: "Maintain a response policy for overdue tickets",
    });
    await store.createTeam({
      id: "support-team",
      objectiveId: "support",
      name: "Support",
      leadTagId: owner.id,
      memberTagIds: [specialist.id],
      maxConcurrency: 1,
    });
    await store.updateTeam("support-team", {
      expectedRevision: 1,
      context: { unrelated: "preserve me" },
    });
    // The specialist posts observations, so it is a member of the Team whose channel carries them.
    await store.createTeam({
      id: "observations",
      objectiveId: "support",
      name: "Support observations",
      leadTagId: owner.id,
      memberTagIds: [specialist.id],
    });

    const errors: unknown[] = [];
    const deniedWrites: string[] = [];
    const conflicts: string[] = [];
    const managerAttempts: string[] = [];
    const proposals = new Map<string, CapturedArtifact>();
    type Proposal = { incidentId: string; expectedRevision: number; responseMinutes: number };
    // Artifact bytes stay on this Worker Host; the Control Plane records only their metadata.
    const hostArtifacts = hostArtifactStore(join(directory, "artifacts"));
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "support", revision: "1" },
              capabilities: [
                { id: "supertag.task-attempt.events", version: 1 },
                { id: "supertag.coordination", version: 1 },
              ],
              contextTypes: [],
            },
          ],
          id: "support-worker",
          type: "deterministic",
          profiles: [{ id: "support", revision: "1" }],
          contextTypes: [],
          maxConcurrency: 1,
          capabilities: [
            { id: "supertag.task-attempt.events", version: 1 },
            { id: "supertag.coordination", version: 1 },
          ],
        };
      },
      async *execute(spec) {
        const identity = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        yield { ...identity, type: "execution.started", workerId: "support-worker" };
        if (!spec.coordination) throw new Error("Missing scoped coordination authority");
        const { controlPlaneUrl, token } = spec.coordination;
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
          const response = await fetch(`${controlPlaneUrl}/internal/v1/coordination/mcp`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          const body = (await response.json()) as {
            error?: unknown;
            result?: { isError?: boolean; content: { text: string }[] };
          };
          if (!response.ok || body.error || body.result?.isError)
            throw new Error(JSON.stringify(body));
          const text = body.result?.content[0]?.text;
          if (!text) throw new Error("Missing coordination result");
          return JSON.parse(text) as T;
        };
        const catalog = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
          const response = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/${name}`, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(JSON.stringify(body));
          return body as T;
        };
        try {
          if (spec.tag.id === specialist.id) {
            const assignment = await call<TaskAssignment>("read_task", { taskId: spec.taskId });
            const proposal = JSON.parse(assignment.instruction) as Proposal;
            // An analyst can produce evidence, but cannot apply a Team policy.
            await expect(
              call("update_team", {
                teamId: "support-team",
                expectedRevision: proposal.expectedRevision,
                context: { unauthorized: true },
              }),
            ).rejects.toThrow("Unknown tool");
            deniedWrites.push(spec.taskId);
            const bytes = Buffer.from(JSON.stringify(proposal));
            const ref = await hostArtifacts(spec).put({ bytes });
            const { artifact } = await catalog<{ artifact: CapturedArtifact }>("capture", {
              operationId: "response-policy",
              title: "Proposed support response policy",
              kind: "proposal",
              entries: [
                {
                  path: "policy.json",
                  uri: ref.uri,
                  digest: ref.digest,
                  sizeBytes: bytes.length,
                  mediaType: "application/json",
                },
              ],
            });
            proposals.set(spec.taskId, artifact);
            yield {
              ...identity,
              type: "output.message",
              message: { role: "teammate", text: "Saved a response-policy proposal for review." },
            };
            yield {
              ...identity,
              type: "result",
              result: {
                summary: "Policy proposed; no authoritative update applied",
                decisions: [],
                changes: [],
                unresolved: [],
                findings: [],
                references: [],
                artifacts: [{ artifactId: artifact.id, paths: ["policy.json"] }],
              },
            };
          } else {
            managerAttempts.push(spec.attemptId);
            const stream = await call<{ posts: { sequence: number; body: string }[] }>(
              "read_workstream",
              { workstreamId: "observations", afterSequence: 0, limit: 100 },
            );
            const cursor = stream.posts.at(-1)?.sequence ?? 0;
            if (stream.posts.length) {
              const incidentId = JSON.parse(stream.posts.at(-1)?.body ?? "{}").incidentId as string;
              let team = await call<Team>("read_team", { teamId: "support-team" });
              if (team.context?.["incidentId"] !== incidentId) {
                const taskId = `policy:${incidentId}:r${team.revision}`;
                // Stable identity prevents replayed observations from creating another assignment.
                const definition = {
                  taskId,
                  teamId: "support-team",
                  assignedTagId: specialist.id,
                  instruction: JSON.stringify({
                    incidentId,
                    expectedRevision: team.revision,
                    responseMinutes: 30,
                  }),
                  acceptanceCriteria: [
                    "Propose a thirty-minute response policy against the observed revision",
                  ],
                  requiresApproval: true,
                };
                const child = await call<TaskAssignment>("assign_task", definition);
                expect((await call<TaskAssignment>("assign_task", definition)).taskId).toBe(taskId);
                if (child.status === "submitted" || child.status === "accepted") {
                  const result = child.result?.["taskResult"] as {
                    artifacts: { artifactId: string; paths: string[] }[];
                  };
                  const selection = result.artifacts[0];
                  if (!selection) throw new Error("Missing submitted artifact");
                  const { artifact } = await catalog<{ artifact: CapturedArtifact }>("inspect", {
                    artifactId: selection.artifactId,
                  });
                  await catalog("acquire", {
                    operationId: `review:${artifact.id}`,
                    artifactId: artifact.id,
                    paths: ["policy.json"],
                    delivery: "read",
                  });
                  const entry = artifact.entries[0];
                  if (!entry) throw new Error("Missing policy entry");
                  const bytes = await hostArtifacts(spec).get(entry);
                  expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
                    entry.digest,
                  );
                  const proposal = JSON.parse(Buffer.from(bytes).toString()) as Proposal;
                  expect(proposal).toEqual({
                    incidentId,
                    expectedRevision: team.revision,
                    responseMinutes: 30,
                  });
                  if (child.status === "submitted")
                    await call("update_task", {
                      taskId,
                      expectedStatus: "submitted",
                      status: "accepted",
                      assessment: `Reviewed exact policy bytes ${entry.digest}`,
                    });
                  try {
                    // The test injects a concurrent administrator edit at this exact boundary.
                    await beforeApply?.();
                    await call("update_team", {
                      teamId: team.id,
                      expectedRevision: proposal.expectedRevision,
                      context: {
                        ...team.context,
                        incidentId,
                        responseMinutes: proposal.responseMinutes,
                        sourceArtifactId: artifact.id,
                        sourceDigest: entry.digest,
                      },
                    });
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      !error.message.includes("Team revision changed")
                    )
                      throw error;
                    conflicts.push(taskId);
                    team = await call<Team>("read_team", { teamId: team.id });
                    const replacement = `policy:${incidentId}:r${team.revision}`;
                    await call("assign_task", {
                      ...definition,
                      taskId: replacement,
                      instruction: JSON.stringify({
                        incidentId,
                        expectedRevision: team.revision,
                        responseMinutes: 30,
                      }),
                    });
                    await call("wait_for", { submittedTaskIds: [replacement] });
                    return;
                  }
                } else {
                  await call("wait_for", { submittedTaskIds: [taskId] });
                  return;
                }
              }
            }
            await call("wait_for", {
              workstreamPosts: { workstreamId: "observations", afterSequence: cursor },
            });
            return;
          }
          yield { ...identity, type: "execution.completed" };
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
    };
    let beforeApply: (() => Promise<void>) | undefined;
    const local = new LocalWorklet("support-host", "support-host", [worker]);
    const durable = new DurableLocalWorklet(
      local,
      new FileAttemptJournal(join(directory, "journal")),
    );
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
    const start = (port: number) =>
      startControlPlaneRuntime({
        host: "127.0.0.1",
        port,
        databaseUrl,
        workletTransport: "remote",
        adminToken: "test-admin",
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      });
    const admin = async (name: string, input: Record<string, unknown> = {}) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/${name}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "support", ...input }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    const waiting = () =>
      expect
        .poll(async () => (await store.getTaskAssignment("support:start"))?.status, {
          timeout: 10000,
        })
        .toBe("waiting");
    const observe = (idempotencyKey: string) =>
      store.postWorkstream({
        workstreamId: "observations",
        authorTagId: specialist.id,
        body: JSON.stringify({ incidentId: "ticket-42", overdueMinutes: 90 }),
        idempotencyKey,
      });
    try {
      runtime = await start(0);
      const port = Number(new URL(runtime.url).port);
      const credential = await enrollWorkerHost(runtime.url, "test-admin", "support-host");
      connection = await connectWorklet({
        url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
        credential,
        worklet: local,
        durableWorklet: durable,
        reconnectIntervalMs: 20,
      });
      await admin("start_objective");
      await waiting();
      const first = await observe("observation-1");
      expect(await observe("observation-1")).toEqual(first);
      await expect
        .poll(async () => (await store.getTaskAssignment("policy:ticket-42:r2"))?.approval)
        .toBe("pending");
      await waiting();
      expect(await store.listTaskAttempts("policy:ticket-42:r2")).toHaveLength(0);
      // A fresh Control Plane reconstructs the responsibility from stored work, not model history.
      await runtime.close();
      runtime = await start(port);
      await expect.poll(() => connection?.isConnected).toBe(true);
      if (conflict)
        beforeApply = async () => {
          beforeApply = undefined;
          await admin("update_team", {
            teamId: "support-team",
            expectedRevision: 2,
            context: { unrelated: "preserve me", concurrentEdit: "retain this too" },
          });
        };
      await admin("update_task", {
        taskId: "policy:ticket-42:r2",
        expectedStatus: "queued",
        approval: "approved",
      });
      if (conflict) {
        await expect
          .poll(async () => (await store.getTaskAssignment("policy:ticket-42:r3"))?.approval, {
            timeout: 10000,
          })
          .toBe("pending");
        expect((await store.getTeam("support-team")).context).not.toHaveProperty("incidentId");
        await admin("update_task", {
          taskId: "policy:ticket-42:r3",
          expectedStatus: "queued",
          approval: "approved",
        });
      }
      await expect
        .poll(async () => (await store.getTeam("support-team")).context?.["incidentId"], {
          timeout: 10000,
        })
        .toBe("ticket-42");
      await waiting();
      const committed = await store.getTeam("support-team");
      expect(committed.context).toMatchObject({
        unrelated: "preserve me",
        responseMinutes: 30,
        ...(conflict ? { concurrentEdit: "retain this too" } : {}),
      });
      const appliedTask = `policy:ticket-42:r${conflict ? 3 : 2}`;
      const artifact = proposals.get(appliedTask);
      expect(artifact).toBeDefined();
      expect((await store.getTaskAssignment(appliedTask))?.status).toBe("accepted");
      expect(committed.context?.["sourceArtifactId"]).toBe(artifact?.id);
      expect(committed.context?.["sourceDigest"]).toBe(artifact?.entries[0]?.digest);
      expect((await store.getTaskAssignment(appliedTask))?.result?.["reviewedAttemptId"]).toBe(
        artifact?.attemptId,
      );
      const count = managerAttempts.length;
      await runtime.close();
      runtime = await start(port);
      await expect.poll(() => connection?.isConnected).toBe(true);
      // A different observation delivery about the same incident must not apply it again.
      await observe("observation-2");
      await expect.poll(() => managerAttempts.length).toBe(count + 1);
      await waiting();
      expect((await store.getTeam("support-team")).revision).toBe(committed.revision);
      expect(await store.listTaskAssignments("support")).toHaveLength(conflict ? 3 : 2);
      expect(conflicts).toHaveLength(conflict ? 1 : 0);
      expect(deniedWrites).toHaveLength(conflict ? 2 : 1);
      expect(errors).toEqual([]);
      expect((await store.readCoordinationMetrics()).taskAssignments.waiting).toBe(1);
    } finally {
      await connection?.stop();
      await runtime?.close();
      await durable.shutdown("Example finished");
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
