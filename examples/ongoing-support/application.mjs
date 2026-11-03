import { createHash } from "node:crypto";
import { applyReviewedPolicy, policyRequest } from "./policy-client.mjs";

export function coordinationClient(spec) {
  if (!spec.coordination) throw new Error("Missing coordination authority");
  const { controlPlaneUrl, token } = spec.coordination;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, input) => {
    const response = await fetch(`${controlPlaneUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000),
    });
    // A metadata-only receipt, such as catalog/upload, answers 204 with no body.
    const value = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  return {
    call: async (name, args = {}) => {
      const value = await post("/internal/v1/coordination/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (value.error || value.result?.isError) throw new Error(JSON.stringify(value));
      return JSON.parse(value.result.content[0].text);
    },
    catalog: (name, input) => post(`/internal/v1/artifacts/catalog/${name}`, input),
  };
}

// Executable reference policy. Native mode uses the Role instructions instead of this code.
// `artifactStore(spec)` keeps artifact bytes on this Worker Host, as worker.mjs shows.
export function supportWorker({ name, config, artifactStore, afterApply, onError = () => {} }) {
  return {
    async describe() {
      return {
        id: `support-${name}`,
        type: "reference-policy",
        profiles: [{ id: `support-${name}`, revision: "1" }],
        profileCapabilities: [
          {
            profile: { id: `support-${name}`, revision: "1" },
            capabilities: [
              { id: "supertag.task-attempt.events", version: 1 },
              { id: "supertag.coordination", version: 1 },
            ],
            contextTypes: [],
          },
        ],
        contextTypes: [],
        maxConcurrency: 1,
        capabilities: [
          { id: "supertag.task-attempt.events", version: 1 },
          { id: "supertag.coordination", version: 1 },
        ],
      };
    },
    async *execute(spec) {
      const event = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...event, type: "execution.started", workerId: `support-${name}` };
      const { call, catalog } = coordinationClient(spec);
      const artifacts = artifactStore(spec);
      try {
        if (name === "analyst") {
          const task = await call("read_task", { taskId: spec.taskId });
          const proposal = JSON.parse(task.instruction);
          const bytes = Buffer.from(JSON.stringify(proposal));
          const ref = await artifacts.put({ bytes });
          const { artifact } = await catalog("capture", {
            operationId: "policy",
            title: `Policy for ${proposal.incidentId}`,
            kind: "proposal",
            entries: [
              {
                path: "outputs/policy.json",
                uri: ref.uri,
                digest: ref.digest,
                sizeBytes: bytes.length,
                mediaType: "application/json",
              },
            ],
          });
          yield {
            ...event,
            type: "artifact.created",
            artifact: {
              ...ref,
              id: artifact.id,
              artifactId: artifact.id,
              path: "outputs/policy.json",
            },
          };
          yield {
            ...event,
            type: "output.message",
            message: { role: "teammate", text: "Proposal captured for manager review." },
          };
          yield {
            ...event,
            type: "result",
            result: {
              summary: "Policy proposal",
              decisions: [],
              changes: [],
              unresolved: [],
              findings: [],
              references: [],
              artifacts: [{ artifactId: artifact.id, paths: ["outputs/policy.json"] }],
            },
          };
          yield { ...event, type: "execution.completed" };
          return;
        }
        // One page bounds delegation and review backlog. Do not move its cursor until every
        // independent incident on the page is applied and evidenced in durable Team state.
        let team = await call("read_team", { teamId: "support-team" });
        const updateContext = async (change) => {
          for (let retry = 0; retry < 3; retry++) {
            try {
              team = await call("update_team", {
                teamId: team.id,
                expectedRevision: team.revision,
                context: change(team.context ?? {}),
              });
              return;
            } catch (error) {
              if (!error.message.includes("Team revision changed")) throw error;
              team = await call("read_team", { teamId: team.id });
            }
          }
          throw new Error(
            "Repeated Team edits need operator attention; retain the provider receipt",
          );
        };
        const cursor = team.context?.cursor ?? 0;
        const { posts } = await call("read_workstream", {
          workstreamId: "support-observations",
          afterSequence: cursor,
          limit: 2,
        });
        if (!posts.length) {
          await call("wait_for", {
            workstreamPosts: { workstreamId: "support-observations", afterSequence: cursor },
          });
          return;
        }
        const pending = [];
        for (const post of posts) {
          const { incidentId } = JSON.parse(post.body);
          if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(incidentId))
            throw new Error("Invalid incident observation");
          if (Object.hasOwn(team.context?.applied ?? {}, incidentId)) continue;
          // Inspect a stable Task first: the provider revision changes after application,
          // so recomputing a Task ID from live provider state would duplicate recovered work.
          const taskId = `support:${incidentId}`;
          let task;
          let offset = 0;
          while (offset !== null) {
            const objective = await call("read_objective", { offset });
            task = objective.tasks.find((entry) => entry.taskId === taskId);
            if (task) break;
            offset = objective.pages.tasks.nextOffset;
          }
          if (!task) {
            const policy = await policyRequest(
              config.policyUrl,
              config.policyToken,
              `/policy?incidentId=${encodeURIComponent(incidentId)}`,
            );
            task = await call("assign_task", {
              taskId,
              teamId: team.id,
              assignedTagId: config.analystTagId,
              instruction: JSON.stringify({
                incidentId,
                expectedRevision: policy.revision,
                responseMinutes: 30,
              }),
              acceptanceCriteria: [
                "Capture policy.json with the requested incident, revision, and thirty-minute response.",
              ],
              maxCostMinor: 0,
            });
          } else task = await call("read_task", { taskId });
          if (!["submitted", "accepted"].includes(task.status)) {
            if (["failed", "cancelled", "rejected"].includes(task.status))
              throw new Error(`Incident ${incidentId} needs operator attention: ${task.status}`);
            pending.push(taskId);
            continue;
          }
          const selection = task.result?.taskResult?.artifacts?.[0];
          if (!selection?.paths?.includes("outputs/policy.json"))
            throw new Error("No exact policy artifact submitted");
          const { artifact } = await catalog("inspect", { artifactId: selection.artifactId });
          await catalog("acquire", {
            operationId: `review:${artifact.id}`,
            artifactId: artifact.id,
            paths: ["outputs/policy.json"],
            delivery: "read",
          });
          const entry = artifact.entries.find((item) => item.path === "outputs/policy.json");
          if (!entry) throw new Error("Missing policy.json");
          const bytes = await artifacts.get(entry);
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (digest !== entry.digest) throw new Error("Artifact digest mismatch");
          const proposal = JSON.parse(Buffer.from(bytes).toString());
          const requested = JSON.parse(task.instruction);
          if (
            proposal.incidentId !== incidentId ||
            proposal.expectedRevision !== requested.expectedRevision ||
            proposal.responseMinutes !== 30
          )
            throw new Error("Proposal failed review");
          if (task.status === "submitted")
            await call("update_task", {
              taskId,
              expectedStatus: "submitted",
              status: "accepted",
              assessment: `Reviewed ${artifact.id}/outputs/policy.json (${digest})`,
            });
          const applied = await applyReviewedPolicy(config.policyUrl, config.policyToken, {
            ...proposal,
            operationId: taskId,
            sourceArtifactId: artifact.id,
            sourceDigest: digest,
          });
          await afterApply?.(applied, spec);
          await updateContext((context) => ({
            ...context,
            applied: {
              ...context.applied,
              [incidentId]: {
                ...applied.receipt,
                recovered: applied.recovered,
                taskId,
                reviewedAttemptId: artifact.attemptId,
              },
            },
          }));
        }
        if (pending.length) {
          await call("wait_for", { submittedTaskIds: [...new Set(pending)] });
          return;
        }
        const lastSequence = posts.at(-1).sequence;
        await updateContext((context) => ({ ...context, cursor: lastSequence }));
        // Existing posts beyond this page immediately satisfy this wait. Waiting releases the slot.
        await call("wait_for", {
          workstreamPosts: { workstreamId: "support-observations", afterSequence: lastSequence },
        });
      } catch (error) {
        onError(error);
        throw error;
      }
    },
  };
}
