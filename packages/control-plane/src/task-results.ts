import type {
  DurableInboundEvent,
  InboundSurfaceEvent,
  SurfaceProvider,
  TaskHistoryEntry,
  TaskReference,
  TaskResult,
} from "@supertag/core";
import {
  defaultTaskResult,
  terminalTaskResult,
  type TaskAttemptEvent as WorkerTaskAttemptEvent,
} from "@supertag/worker-sdk";

const MAX_PRIOR_INTENT_CHARACTERS = 2_000;
const MAX_PRIOR_RESPONSE_CHARACTERS = 4_000;

/** Combines Worker results and observed effects into the canonical Task result. */
export function buildTaskResult(
  work: DurableInboundEvent,
  response: string,
  workerEvents: readonly WorkerTaskAttemptEvent[],
): TaskResult {
  const workerResult =
    workerEvents.length === 0 ? defaultTaskResult(response) : terminalTaskResult(workerEvents);
  const result: TaskResult = {
    ...workerResult,
    summary: workerResult.summary.trim().length === 0 ? response : workerResult.summary,
    changes: uniqueTaskChanges([...workerResult.changes, ...toolChangesFromEvents(workerEvents)]),
    artifacts: uniqueArtifacts(workerResult.artifacts),
  };
  const references = uniqueTaskReferences([
    ...taskReferencesFromOrigin(work.event, work.surfaceAccountId),
    ...taskReferencesFromRuntimeInputs(workerEvents),
    ...taskReferencesFromToolCalls(workerEvents),
    ...result.references,
    ...result.artifacts.map(
      (artifact): TaskReference => ({
        provider: work.event.provider,
        surfaceAccountId: work.surfaceAccountId,
        resourceType: "artifact",
        reference: `supertag://artifacts/${artifact.artifactId}`,
        relationship: "produced",
      }),
    ),
  ]);
  return { ...result, references };
}

export function boundedTaskHistory(document: TaskHistoryEntry): TaskHistoryEntry {
  return {
    ...document,
    ...(document.requestText === undefined
      ? {}
      : { requestText: truncate(document.requestText, MAX_PRIOR_INTENT_CHARACTERS) }),
    result: {
      ...document.result,
      summary: truncate(document.result.summary, MAX_PRIOR_RESPONSE_CHARACTERS),
      decisions: document.result.decisions.slice(0, 10).map((decision) => ({
        ...decision,
        text: truncate(decision.text, 1_000),
      })),
      changes: document.result.changes.slice(0, 10).map((change) => ({
        ...change,
        summary: truncate(change.summary, 1_000),
      })),
      unresolved: document.result.unresolved.slice(0, 10).map((item) => truncate(item, 1_000)),
      findings: document.result.findings.slice(0, 25),
      references: document.result.references.slice(0, 25),
      artifacts: document.result.artifacts.slice(0, 25),
    },
  };
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

export function taskReferencesFromOrigin(
  event: InboundSurfaceEvent,
  surfaceAccountId: string,
): readonly TaskReference[] {
  if (event.provider === "github") {
    const repositoryId = textValue(event.source["repositoryId"]) ?? scopeId(event.scope);
    const repository =
      textValue(event.source["repository"]) ??
      (repositoryId === undefined ? undefined : `github:repository:${repositoryId}`);
    if (repository === undefined) return [];
    const references: TaskReference[] = [
      {
        provider: "github",
        surfaceAccountId,
        resourceType: "repository",
        ...(repositoryId === undefined ? {} : { resourceId: repositoryId }),
        reference: repository,
        relationship: "originated-in",
      },
    ];
    const number = textValue(event.source["number"]);
    if (number !== undefined) {
      references.push({
        provider: "github",
        surfaceAccountId,
        resourceType: event.metadata["isPullRequest"] === true ? "pull-request" : "issue",
        resourceId: number,
        reference: `${repository}#${number}`,
        relationship: "originated-in",
      });
    }
    return references;
  }
  if (event.provider === "linear") {
    const issueId = textValue(event.source["issueId"]);
    if (issueId === undefined) return [];
    const teamId = textValue(event.source["teamId"]) ?? scopeId(event.scope);
    return [
      ...(teamId === undefined
        ? []
        : [
            {
              provider: "linear" as const,
              surfaceAccountId,
              resourceType: "project" as const,
              resourceId: teamId,
              reference: `linear:${event.externalAccountId}:team:${teamId}`,
              relationship: "originated-in" as const,
            },
          ]),
      {
        provider: "linear",
        surfaceAccountId,
        resourceType: "issue",
        resourceId: issueId,
        reference: textValue(event.source["issueIdentifier"]) ?? issueId,
        relationship: "originated-in",
      },
    ];
  }
  const channelId = textValue(event.source["channelId"]) ?? scopeId(event.scope);
  if (channelId === undefined) return [];
  return [
    {
      provider: event.provider,
      surfaceAccountId,
      resourceType: "channel",
      resourceId: channelId,
      reference: `${event.provider}:${event.externalAccountId}:${channelId}`,
      relationship: "originated-in",
    },
  ];
}

function taskReferencesFromRuntimeInputs(
  events: readonly WorkerTaskAttemptEvent[],
): readonly TaskReference[] {
  return events.flatMap((event) => {
    if (event.type !== "runtime-inputs.resolved") return [];
    return event.manifest.inputs.flatMap((input): readonly TaskReference[] => {
      const provenance = input.resource?.provenance;
      if (provenance?.["provider"] !== "github") return [];
      const repositoryId = textValue(provenance["repositoryId"]);
      const repository = textValue(provenance["repository"]);
      const surfaceAccountId = textValue(provenance["surfaceAccountId"]);
      if (repository === undefined) return [];
      return [
        {
          provider: "github",
          ...(surfaceAccountId === undefined ? {} : { surfaceAccountId }),
          resourceType: "repository",
          ...(repositoryId === undefined ? {} : { resourceId: repositoryId }),
          reference: repository,
          relationship: "inspected",
        },
      ];
    });
  });
}

function taskReferencesFromToolCalls(
  events: readonly WorkerTaskAttemptEvent[],
): readonly TaskReference[] {
  return events.flatMap((event): readonly TaskReference[] => {
    if (
      event.type !== "tool.call.completed" ||
      event.call.effect !== "write" ||
      event.outcome === undefined ||
      !isSurfaceProvider(event.call.provider)
    ) {
      return [];
    }
    const provider = event.call.provider;
    const resource = event.call.resources[0];
    return event.outcome.references.flatMap((reference): readonly TaskReference[] => {
      if (!/^https?:\/\//iu.test(reference)) return [];
      return [
        {
          provider,
          ...(resource?.surfaceAccountId === undefined
            ? {}
            : { surfaceAccountId: resource.surfaceAccountId }),
          resourceType: externalActionResourceType(
            provider,
            event.call.operation,
            event.call.arguments,
          ),
          ...externalActionResourceId(event.call.operation, event.call.arguments),
          reference,
          relationship: "changed",
        },
      ];
    });
  });
}

function toolChangesFromEvents(events: readonly WorkerTaskAttemptEvent[]): TaskResult["changes"] {
  return events.flatMap((event): TaskResult["changes"] => {
    if (event.type !== "tool.call.completed" || event.call.effect !== "write") return [];
    const summary = externalActionSummary(event.call.provider, event.call.operation);
    const references = event.outcome?.references.filter((reference) =>
      /^https?:\/\//iu.test(reference),
    );
    return references === undefined || references.length === 0
      ? [{ summary }]
      : references.map((reference) => ({ summary, reference }));
  });
}

function isSurfaceProvider(value: string): value is SurfaceProvider {
  return (
    value === "github" ||
    value === "lark" ||
    value === "linear" ||
    value === "slack" ||
    value === "teams"
  );
}

function externalActionResourceType(
  provider: SurfaceProvider,
  operation: string,
  arguments_: Readonly<Record<string, unknown>> | undefined,
): TaskReference["resourceType"] {
  if (operation.includes("pull_request")) return "pull-request";
  if (provider === "github" && operation === "create_branch") return "repository";
  if (provider === "github" || provider === "linear") return "issue";
  if (operation.toLowerCase().includes("reply") || arguments_?.["thread_ts"] !== undefined) {
    return "thread";
  }
  return "channel";
}

function externalActionResourceId(
  operation: string,
  arguments_: Readonly<Record<string, unknown>> | undefined,
): Pick<TaskReference, "resourceId"> | Record<string, never> {
  const candidate = operation.includes("pull_request")
    ? (arguments_?.["pullNumber"] ?? arguments_?.["pull_number"])
    : (arguments_?.["issue_number"] ?? arguments_?.["issueId"] ?? arguments_?.["issue_id"]);
  const id = positiveIntegerText(candidate) ?? textValue(candidate);
  return id === undefined ? {} : { resourceId: id };
}

function externalActionSummary(provider: string, operation: string): string {
  const known: Readonly<Record<string, string>> = {
    "github.add_issue_comment": "Added a GitHub issue comment",
    "github.create_branch": "Created a GitHub branch",
    "github.create_pull_request": "Created a GitHub pull request",
    "github.merge_pull_request": "Merged a GitHub pull request",
    "linear.create_issue": "Created a Linear issue",
    "linear.create_comment": "Added a Linear issue comment",
    "slack.slack_send_message": "Sent a Slack message",
    "teams.mcp_graph_teams_postChannelMessage": "Sent a Teams channel message",
    "teams.mcp_graph_teams_replyToChannelMessage": "Replied to a Teams channel message",
  };
  return known[`${provider}.${operation}`] ?? `Completed ${provider} action ${operation}`;
}

function uniqueTaskChanges(changes: TaskResult["changes"]): TaskResult["changes"] {
  return [
    ...new Map(
      changes.map((change) => [`${change.summary}\u0000${change.reference ?? ""}`, change]),
    ).values(),
  ];
}

function uniqueTaskReferences(references: readonly TaskReference[]): readonly TaskReference[] {
  return [
    ...new Map(
      references.map((reference) => [
        `${reference.provider}\u0000${reference.surfaceAccountId ?? ""}\u0000${reference.resourceType}\u0000${reference.reference}\u0000${reference.relationship}`,
        reference,
      ]),
    ).values(),
  ];
}

function positiveIntegerText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  return value;
}

function uniqueArtifacts(
  artifacts: readonly TaskResult["artifacts"][number][],
): TaskResult["artifacts"] {
  const selections = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    const paths = selections.get(artifact.artifactId) ?? new Set<string>();
    for (const path of artifact.paths) paths.add(path);
    selections.set(artifact.artifactId, paths);
  }
  return [...selections].map(([artifactId, paths]) => ({ artifactId, paths: [...paths].sort() }));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scopeId(scope: string): string | undefined {
  const separator = scope.indexOf(":");
  return separator < 0 ? undefined : textValue(scope.slice(separator + 1));
}
