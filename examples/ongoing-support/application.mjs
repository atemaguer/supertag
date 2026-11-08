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

/** The text of the turn SuperTag delivered: an operator message, a report, or an instruction. */
function requestText(spec) {
  return spec.input.messages
    .filter((message) => message.role !== "system")
    .map((message) => message.text)
    .join("\n");
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
          // A work Session sees only its own work: its instruction is this turn's request.
          const proposal = JSON.parse(requestText(spec));
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
            type: "result",
            result: {
              // The reply returns to the Objective that started this Session.
              summary: JSON.stringify({
                incidentId: proposal.incidentId,
                artifactId: artifact.id,
                digest: ref.digest,
              }),
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
        // The manager's own turn of the Objective's conversation. Every turn reconciles durable
        // state: the provider's receipts and this Objective's work Sessions, titled
        // `support:<incidentId>`. Incident reports arrive as operator messages in this turn.
        const objective = await call("read_objective");
        const sessions = new Map(
          objective.sessions
            .filter((session) => typeof session.title === "string")
            .map((session) => [session.title, session]),
        );
        const incidents = [
          ...new Set(
            [...requestText(spec).matchAll(/"incidentId"\s*:\s*"([^"]*)"/gu)].map(
              (match) => match[1],
            ),
          ),
        ];
        for (const incidentId of incidents)
          if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(incidentId))
            throw new Error("Invalid incident observation");
        const applied = [];
        // Every known incident is reconsidered, so a report wakes the review of its own Session.
        const known = [
          ...new Set([
            ...incidents,
            ...[...sessions.keys()].map((title) => title.slice("support:".length)),
          ]),
        ];
        const started = [];
        for (const incidentId of known) {
          const title = `support:${incidentId}`;
          const session = sessions.get(title);
          // Inspect the stable operation first: the provider revision changes after application,
          // so a receipt is the only proof that this incident is already done.
          const receipt = (
            await policyRequest(
              config.policyUrl,
              config.policyToken,
              `/operation?operationId=${encodeURIComponent(title)}`,
            )
          ).operation;
          if (receipt) continue;
          if (session === undefined) {
            const policy = await policyRequest(
              config.policyUrl,
              config.policyToken,
              `/policy?incidentId=${encodeURIComponent(incidentId)}`,
            );
            const instruction = JSON.stringify({
              incidentId,
              expectedRevision: policy.revision,
              responseMinutes: 30,
            });
            started.push(
              await call("start_session", {
                title,
                instruction,
                tag: config.analystTagId,
              }),
            );
            continue;
          }
          if (session.status !== "completed") continue;
          // The Session reported: review its exact artifact before applying anything.
          const history = await call("read_session", { sessionId: session.sessionId, limit: 10 });
          const reply = history.entries.findLast((entry) => entry.responseText)?.responseText;
          const request = history.entries.find((entry) => entry.requestText)?.requestText;
          if (!reply || !request) throw new Error(`Session ${title} reported nothing to review`);
          const reported = JSON.parse(reply);
          const requested = JSON.parse(request);
          const { artifact } = await catalog("inspect", { artifactId: reported.artifactId });
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
          if (
            proposal.incidentId !== incidentId ||
            proposal.expectedRevision !== requested.expectedRevision ||
            proposal.responseMinutes !== 30
          ) {
            await call("continue_session", {
              sessionId: session.sessionId,
              message: `The proposal does not match ${request}. Capture policy.json with exactly those fields.`,
            });
            continue;
          }
          const result = await applyReviewedPolicy(config.policyUrl, config.policyToken, {
            ...proposal,
            operationId: title,
            sourceArtifactId: artifact.id,
            sourceDigest: digest,
          });
          await afterApply?.(result, spec);
          applied.push({
            incidentId,
            ...result.receipt,
            recovered: result.recovered,
            sessionId: session.sessionId,
            reviewedAttemptId: artifact.attemptId,
          });
        }
        yield {
          ...event,
          type: "result",
          result: {
            // The reply is this Objective's record of the turn; it starts nothing new.
            summary: JSON.stringify({ applied, started }),
            decisions: [],
            changes: [],
            unresolved: [],
            findings: [],
            references: [],
            artifacts: [],
          },
        };
        yield { ...event, type: "execution.completed" };
      } catch (error) {
        onError(error);
        throw error;
      }
    },
  };
}
