import {
  advertisedWorkspaces,
  advertisesWorkspaceClone,
  advertisesWorkspaceEnvironment,
  COMMANDS_EXECUTE_ACTION,
  hostCommandSupport,
  mcpServerOfLabel,
  type Objective,
  objectiveAdmissionBlocker,
  type TaskAttempt,
  unsandboxedCommandsReason,
  type WorkerHost,
  workspaceEnvironmentRefusals,
} from "@supertag/core";

import { harnessSignInFailure } from "./harness-signin.js";

/**
 * Facts that decide whether an Objective's Tasks can run. Gathered by the Control Plane so the
 * rule itself stays pure and can grow new host requirements, such as labels or clone support.
 */
export interface ObjectiveRunnableFacts {
  readonly objective: Pick<
    Objective,
    | "status"
    | "deadline"
    | "budgetLimitMinor"
    | "budgetCurrency"
    | "limitState"
    | "workspaces"
    | "runtimeActions"
  >;
  readonly owner: { readonly id: string; readonly name: string };
  /** Worker Hosts bound to the owner Tag. */
  readonly boundHostIds: readonly string[];
  /** The owner Tag's placement labels; a bound host must carry every one. */
  readonly runsOn?: readonly string[];
  /** The harness the owner Tag's execution settings name, if any. */
  readonly harness?: string;
  /** Enrolled Worker Host records with their latest connection and advertised Workspaces. */
  readonly hosts: readonly Pick<
    WorkerHost,
    "id" | "enrollmentStatus" | "connectionStatus" | "workerSnapshot" | "labels"
  >[];
  /** Workspaces with a `source`, which hosts advertising clone support can reach. */
  readonly cloneableWorkspaces?: readonly string[];
  /** Hosts an embedded or single connected Worklet reports directly, which may have no record. */
  /** Latest recorded Attempts, scoped to the owner Tag and this Objective. */
  readonly signInAttempts?: readonly HarnessSignInAttempt[];
  readonly directHosts: readonly {
    readonly id: string;
    readonly workerSnapshot?: Readonly<Record<string, unknown>>;
    readonly workspaces?: readonly string[];
    readonly labels?: readonly string[];
  }[];
}

export interface ObjectiveRunnableCondition {
  readonly type: "Runnable";
  readonly status: boolean;
  /** Plain-language reasons the Objective's Tasks would wait; empty when runnable. */
  readonly reasons: readonly string[];
}

/** The conditions that would hold an Objective's Tasks, each with the next step to clear it. */
export function objectiveRunnableReasons(facts: ObjectiveRunnableFacts, at: string): string[] {
  const reasons: string[] = [];
  const { objective, owner } = facts;
  const blocker = objectiveAdmissionBlocker(objective, at);
  if (blocker) reasons.push(`${blocker}; new Tasks are refused.`);
  else if (objective.budgetLimitMinor === 0)
    reasons.push("The budget is 0, so no Task can be allocated. Raise it with --budget-minor.");
  const bound = new Set(facts.boundHostIds);
  if (bound.size === 0) {
    reasons.push(
      `Tag ${owner.name} has no Worker Host, so its Tasks cannot run. Create an Auth Key and join a host with it: supertag create auth-key NAME --tag ${owner.name}`,
    );
    return reasons;
  }
  // Labels choose among bound hosts; a host missing any runsOn label never runs these Tasks.
  const runsOn = facts.runsOn ?? [];
  const carries = (labels: readonly string[] | undefined) =>
    runsOn.every((label) => labels?.includes(label) === true);
  const boundActive = facts.hosts.filter(
    (host) => bound.has(host.id) && host.enrollmentStatus === "active",
  );
  const boundDirect = facts.directHosts.filter((host) => bound.has(host.id));
  const eligible = boundActive.filter((host) => carries(host.labels));
  const direct = boundDirect.filter((host) => carries(host.labels));
  if (runsOn.length > 0 && eligible.length === 0 && direct.length === 0) {
    const servers = runsOn.flatMap((label) => mcpServerOfLabel(label) ?? []);
    reasons.push(
      `No Worker Host bound to Tag ${owner.name} has labels: ${runsOn.join(", ")}. Its Tasks wait until one does. Add labels with: supertag connect worklet --label LABEL, or change the Tag's runsOn.`,
      ...(servers.length === 0
        ? []
        : [
            `Missing MCP server${servers.length > 1 ? "s" : ""}: ${servers.join(", ")}. Add ${servers.length > 1 ? "them" : "it"} to a bound host service's mcp map in supertag.yaml.`,
          ]),
    );
    return reasons;
  }
  const connected =
    direct.length > 0 || eligible.some((host) => host.connectionStatus === "connected");
  if (!connected)
    reasons.push(
      `No Worker Host bound to Tag ${owner.name} is connected (${[...bound].sort().join(", ")}). Its Tasks wait until one connects.`,
    );
  for (const workspace of objective.workspaces ?? []) {
    const declared =
      direct.some((host) => host.workspaces?.includes(workspace)) ||
      eligible.some((host) => advertisedWorkspaces(host.workerSnapshot).includes(workspace));
    const cloneable =
      facts.cloneableWorkspaces?.includes(workspace) === true &&
      eligible.some(
        (host) =>
          advertisesWorkspaceClone(host.workerSnapshot) ||
          advertisesWorkspaceEnvironment(host.workerSnapshot),
      );
    if (!declared && !cloneable) {
      reasons.push(
        facts.cloneableWorkspaces?.includes(workspace)
          ? `No Worker Host bound to Tag ${owner.name} declares a checkout of Workspace ${workspace}, can clone it, or has a Workspace environment provider. Connect a capable host or declare a checkout: supertag connect worklet --workspace ${workspace}=PATH`
          : `No Worker Host bound to Tag ${owner.name} declares a checkout of Workspace ${workspace}. Connect one with: supertag connect worklet --workspace ${workspace}=PATH`,
      );
      if (facts.cloneableWorkspaces?.includes(workspace))
        reasons.push(
          ...eligible.flatMap((host) =>
            workspaceEnvironmentRefusals(host.workerSnapshot).map(
              (reason) => `Worker Host ${host.id}: ${reason}`,
            ),
          ),
        );
    }
  }
  // A Task that may run commands needs a host whose harness sandboxes them, or one the host
  // operator allowed to run them unsandboxed. Hosts that report neither are not checked.
  if (objective.runtimeActions?.includes(COMMANDS_EXECUTE_ACTION) === true) {
    const recorded = new Set(eligible.map((host) => host.id));
    const held = eligible.flatMap((host) => {
      const support = hostCommandSupport(host.workerSnapshot, facts.harness);
      return support.reported && !support.permitted && support.refused.length > 0
        ? [{ workerHostId: host.id, harnesses: support.refused }]
        : [];
    });
    if (
      held.length > 0 &&
      held.length === eligible.length &&
      direct.every((host) => recorded.has(host.id))
    )
      reasons.push(...held.map(unsandboxedCommandsReason));
  }
  const connectedHosts = new Map([
    ...eligible
      .filter((host) => host.connectionStatus === "connected")
      .map((host) => [host.id, host.workerSnapshot] as const),
    ...direct.map(
      (host) =>
        [
          host.id,
          host.workerSnapshot ??
            eligible.find((record) => record.id === host.id)?.workerSnapshot ??
            {},
        ] as const,
    ),
  ]);
  const failures = [...connectedHosts].flatMap(([id, snapshot]) => {
    if (
      !(objective.workspaces ?? []).every(
        (workspace) =>
          advertisedWorkspaces(snapshot).includes(workspace) ||
          (facts.cloneableWorkspaces?.includes(workspace) &&
            (advertisesWorkspaceClone(snapshot) || advertisesWorkspaceEnvironment(snapshot))),
      )
    )
      return [];
    const workers = Array.isArray(snapshot["workers"]) ? snapshot["workers"] : [];
    // An unreported Worker is unknown, never evidence that every option failed.
    if (workers.length === 0) return [undefined];
    return workers.flatMap((worker) => {
      if (!isRecord(worker)) return [undefined];
      const profiles = Array.isArray(worker["profileCapabilities"])
        ? worker["profileCapabilities"]
        : [];
      if (profiles.length === 0) return [undefined];
      return profiles.flatMap((profile) => {
        if (!isRecord(profile) || typeof profile["harness"] !== "string") return [undefined];
        const harness = profile["harness"];
        if (facts.harness !== undefined && harness !== facts.harness) return [];
        if (objective.runtimeActions?.includes(COMMANDS_EXECUTE_ACTION)) {
          const support = hostCommandSupport(
            { workers: [{ profileCapabilities: [profile] }] },
            harness,
          );
          if (support.reported && !support.permitted) return [];
        }
        const latest = (facts.signInAttempts ?? [])
          .filter(
            (attempt) =>
              attempt.workerHostId === id &&
              attempt.workerId === worker["id"] &&
              attempt.harness === harness,
          )
          .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        return [
          latest?.status === "failed" &&
          latest.error &&
          harnessSignInFailure(latest.error, harness, latest.failureKind)
            ? `Worker Host ${id}, ${harness}: the latest Task Attempt failed sign-in: ${latest.error}`
            : undefined,
        ];
      });
    });
  });
  if (failures.length > 0 && failures.every((failure) => failure !== undefined))
    reasons.push(...new Set(failures));
  return reasons;
}

export interface HarnessSignInAttempt {
  readonly workerHostId: string;
  readonly workerId: string;
  readonly harness: string;
  readonly status: string;
  readonly startedAt: string;
  readonly error?: string | undefined;
  readonly failureKind?: string | undefined;
}

/** Read only recorded placement and harness identity; never infer them from profile names. */
export function harnessSignInAttempt(
  attempt: TaskAttempt,
  outcome?: unknown,
): HarnessSignInAttempt | undefined {
  const snapshot = attempt.workerSnapshot;
  const placement = snapshot["placement"];
  const execution = snapshot["execution"];
  if (!isRecord(placement) || !isRecord(execution)) return undefined;
  const host = snapshot["workerHostId"] ?? placement["workerHostId"];
  const worker = snapshot["workerId"] ?? placement["workerId"];
  const harness = execution["harness"];
  if (typeof host !== "string" || typeof worker !== "string" || typeof harness !== "string")
    return undefined;
  return {
    workerHostId: host,
    workerId: worker,
    harness,
    status: attempt.status,
    startedAt: attempt.startedAt,
    ...(isRecord(outcome) && typeof outcome["error"] === "string"
      ? { error: outcome["error"] }
      : {}),
    ...(isRecord(outcome) && typeof outcome["failureKind"] === "string"
      ? { failureKind: outcome["failureKind"] }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectiveRunnableCondition(
  facts: ObjectiveRunnableFacts,
  at: string,
): ObjectiveRunnableCondition {
  const reasons = objectiveRunnableReasons(facts, at);
  return { type: "Runnable", status: reasons.length === 0, reasons };
}

/**
 * An Objective's runtime actions at creation or update. Omitted, they default to every action the
 * owner Tag's Permission Sets allow. An explicit list narrows that set and never widens it: actions
 * the owner lacks are dropped, keeping the requested order.
 */
export function resolveObjectiveRuntimeActions(
  allowed: readonly string[],
  requested?: readonly string[],
): string[] {
  if (requested === undefined) return [...new Set(allowed)].sort();
  return [...new Set(requested)].filter((action) => allowed.includes(action));
}

/**
 * Notes about an Objective's runtime actions. They never hold its Tasks, so they stay out of the
 * Runnable condition and appear only beside a created or updated Objective.
 */
export function objectiveRuntimeActionWarnings(input: {
  readonly objectiveId: string;
  readonly owner: { readonly name: string };
  /** What the owner Tag's Permission Sets allow. */
  readonly allowed: readonly string[];
  /** The operator's explicit list, when one was given. */
  readonly requested?: readonly string[];
}): string[] {
  const warnings: string[] = [];
  const { owner, allowed } = input;
  const dropped = [...new Set(input.requested ?? [])].filter((action) => !allowed.includes(action));
  const pronoun = dropped.length === 1 ? "it" : "them";
  // An update replaces the whole list, so the suggested command names every requested action.
  const flags = [...new Set(input.requested ?? [])]
    .map((action) => `--runtime-action ${action}`)
    .join(" ");
  if (dropped.length > 0)
    warnings.push(
      `Tag ${owner.name}'s Permission Sets do not allow ${dropped.join(", ")}, so the Objective omits ${pronoun}. Grant ${pronoun} in a Permission Set on one of the Tag's Roles, then run: supertag update objective ${input.objectiveId} ${flags}`,
    );
  if (allowed.length === 0)
    warnings.push(
      `Owner Tag ${owner.name}'s Permission Sets allow no runtime actions; its Tasks cannot edit files or run commands. Grant files:write or commands:execute in a Permission Set on one of the Tag's Roles.`,
    );
  return warnings;
}
