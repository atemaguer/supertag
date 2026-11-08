import type { TaskAttemptRunningCommand } from "@supertag/control-plane";
import {
  type CoordinationInboxPage,
  type Objective,
  type SpendUsage,
  storedTaskFindings,
  type Tag,
  type Task,
  type TaskAttempt,
} from "@supertag/core";
import { COORDINATION_CAPABILITY } from "@supertag/worker-sdk";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import type { WorkerHostResource } from "./control-plane-resources.js";
import { type DiskSpace, lowDiskWarning } from "./disk-space.js";
import { money } from "./money.js";
import { takeOutputFlag } from "./output-flag.js";
import { runningCommandText } from "./running-command.js";
import { terminalText } from "./terminal-text.js";

/** Running Task Attempts against total capacity for one harness on one Worker Host. */
export interface HarnessLoad {
  readonly harness: string;
  readonly running: number;
  /** Regular slots plus owner-only coordination slots. */
  readonly capacity: number;
  readonly coordinationCapacity: number;
}

/** `GET /api/v1/organization`: what the organization is doing right now. */
export interface OrganizationStatus {
  readonly asOf: string;
  readonly workerHosts: readonly {
    readonly id: string;
    readonly phase: WorkerHostResource["status"]["phase"];
    readonly running: number;
    /** Regular slots plus owner-only coordination slots. */
    readonly capacity: number;
    readonly coordinationCapacity: number;
    readonly harnesses: readonly HarnessLoad[];
    readonly diskSpace?: DiskSpace;
    readonly diskWarning?: string;
  }[];
  readonly tags: readonly {
    readonly id: string;
    readonly name: string;
    /** Tasks whose Attempts are running now; empty when the Tag is idle. */
    readonly runningTaskIds: readonly string[];
    /**
     * The command each running Task's harness reports as running, when it reports commands.
     * The text is AI-authored and untrusted; it is plain, single-line text.
     */
    readonly runningCommands: readonly {
      readonly taskId: string;
      readonly command: string;
      readonly startedAt: string;
    }[];
  }[];
  /** Objectives that are not completed or cancelled, newest first. */
  readonly objectives: readonly {
    readonly id: string;
    readonly status: Objective["status"];
    readonly ownerTagId: string;
    readonly ownerName: string;
    readonly deadline: string | null;
    /** Provider-reported spend in minor units, such as 1380 for $13.80; 0 when none is known. */
    readonly spentMinor: number;
    readonly budgetLimitMinor: number | null;
    /** The budget's currency; null when the budget counts allocation units. */
    readonly currency: string | null;
    /** The currency of spentMinor; null when spend counts allocation units. */
    readonly spendCurrency: string | null;
    /** Usage with no published model price, when present. */
    readonly unpricedAttempts?: number;
    readonly unpricedTokens?: number;
    readonly highFindings?: readonly {
      readonly taskId: string;
      readonly id: string;
      readonly summary: string;
      readonly location?: string;
    }[];
  }[];
}

/** What `supertag status` prints: the organization plus the operator inbox. */
export interface OrganizationStatusView extends OrganizationStatus {
  readonly objectives: readonly (OrganizationStatus["objectives"][number] & {
    /** Operator inbox items for this Objective. */
    readonly needsOperator: number;
  })[];
  /** truncated: the inbox scan hit its limit, so items is a lower bound. */
  readonly inbox: { readonly items: number; readonly truncated: boolean };
}

/** Builds the organization view from stored records. Pure, so the API and tests share it. */
export function organizationStatus(input: {
  readonly asOf: string;
  readonly workerHosts: readonly WorkerHostResource[];
  readonly tags: readonly Tag[];
  readonly runningAttempts: readonly TaskAttempt[];
  /** The Tag of each Task with a running Attempt. */
  readonly taskTagIds: ReadonlyMap<string, string>;
  /** The running command of each Task whose harness reports one. */
  readonly runningCommands?: ReadonlyMap<string, TaskAttemptRunningCommand>;
  readonly objectives: readonly Objective[];
  /** The Tasks of each Objective's Sessions, for their reported findings. */
  readonly objectiveTasks?: ReadonlyMap<string, readonly Pick<Task, "id" | "result">[]>;
  readonly objectiveSpend?: ReadonlyMap<string, SpendUsage>;
}): OrganizationStatus {
  const placements = input.runningAttempts.map((attempt) => ({
    taskId: attempt.taskId,
    ...attemptPlacement(attempt),
  }));
  const workerHosts = input.workerHosts
    .filter((host) => host.status.phase !== "revoked")
    .map((host) => {
      const id = host.metadata.id;
      const diskWarning = lowDiskWarning(host.status.diskSpace);
      const onHost = placements.filter((placement) => placement.workerHostId === id);
      const loads = new Map<
        string,
        { running: number; capacity: number; coordinationCapacity: number }
      >();
      let coordinationCapacity = 0;
      for (const worker of host.status.workers) {
        const ownerSlot = worker.profileCapabilities?.some((profile) =>
          profile.capabilities?.some(
            (capability) =>
              capability.id === COORDINATION_CAPABILITY.id &&
              capability.version === COORDINATION_CAPABILITY.version,
          ),
        )
          ? 1
          : 0;
        coordinationCapacity += ownerSlot;
        // A Worker serving several harnesses shares one capacity, so it is shown under all of them.
        const harnesses = [
          ...new Set(
            (worker.profileCapabilities ?? []).flatMap((entry) =>
              entry.harness === undefined ? [] : [entry.harness],
            ),
          ),
        ].toSorted();
        const served = harnesses.length ? harnesses : [worker.type];
        const ids = new Set([worker.id, `${id}/${worker.id}`]);
        const onWorker = onHost.filter(
          (placement) => placement.workerId !== undefined && ids.has(placement.workerId),
        );
        // A Worker serving several harnesses counts its capacity under each of them, and each
        // running Attempt under the harness it runs on.
        for (const harness of served) {
          const load = loads.get(harness) ?? {
            running: 0,
            capacity: 0,
            coordinationCapacity: 0,
          };
          load.capacity += (worker.maxConcurrency ?? 1) + ownerSlot;
          load.coordinationCapacity += ownerSlot;
          load.running += onWorker.filter((placement) =>
            placement.harness === undefined ? harness === served[0] : placement.harness === harness,
          ).length;
          loads.set(harness, load);
        }
      }
      return {
        id,
        phase: host.status.phase,
        running: onHost.length,
        capacity: host.status.capacity + coordinationCapacity,
        coordinationCapacity,
        harnesses: [...loads]
          .map(([harness, load]) => ({ harness, ...load }))
          .toSorted((left, right) => left.harness.localeCompare(right.harness)),
        ...(host.status.diskSpace === undefined
          ? {}
          : {
              diskSpace: host.status.diskSpace,
              ...(diskWarning === undefined ? {} : { diskWarning }),
            }),
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const busy = new Map<string, Set<string>>();
  for (const placement of placements) {
    const tagId = input.taskTagIds.get(placement.taskId);
    if (tagId === undefined) continue;
    busy.set(tagId, (busy.get(tagId) ?? new Set()).add(placement.taskId));
  }
  const tagNames = new Map(input.tags.map((tag) => [tag.id, tag.name]));
  const tags = input.tags
    .filter((tag) => tag.status !== "retired")
    .map((tag) => {
      const runningTaskIds = [...(busy.get(tag.id) ?? [])].toSorted();
      return {
        id: tag.id,
        name: tag.name,
        runningTaskIds,
        runningCommands: runningTaskIds.flatMap((taskId) => {
          const running = input.runningCommands?.get(taskId);
          return running === undefined ? [] : [{ taskId, ...running }];
        }),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const objectives = input.objectives
    .filter((objective) => objective.status !== "completed" && objective.status !== "cancelled")
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    .map((objective) => {
      const reported = objective.limitState?.reportedSpend;
      const usage = input.objectiveSpend?.get(objective.id);
      const unpricedAttempts = Object.values(usage?.unpricedModels ?? {}).reduce(
        (a, b) => a + b,
        0,
      );
      return {
        id: objective.id,
        status: objective.status,
        ownerTagId: objective.ownerTagId,
        ownerName: tagNames.get(objective.ownerTagId) ?? objective.ownerTagId,
        deadline: objective.deadline ?? null,
        spentMinor: reported?.amountMinor ?? 0,
        budgetLimitMinor: objective.budgetLimitMinor ?? null,
        currency: objective.budgetCurrency ?? null,
        spendCurrency: reported?.currency ?? objective.budgetCurrency ?? null,
        ...(unpricedAttempts > 0
          ? { unpricedAttempts, unpricedTokens: usage?.unpricedTokens ?? 0 }
          : {}),
        highFindings: (input.objectiveTasks?.get(objective.id) ?? []).flatMap((task) =>
          storedTaskFindings(task.result)
            .filter((finding) => finding.severity === "high")
            .map((finding) => ({
              taskId: task.id,
              id: finding.id,
              summary: finding.summary,
              ...(finding.location ? { location: finding.location } : {}),
            })),
        ),
      };
    });
  return { asOf: input.asOf, workerHosts, tags, objectives };
}

function attemptPlacement(attempt: TaskAttempt): {
  readonly workerHostId?: string;
  readonly workerId?: string;
  readonly harness?: string;
} {
  const snapshot = attempt.workerSnapshot;
  const placement =
    typeof snapshot["placement"] === "object" &&
    snapshot["placement"] !== null &&
    !Array.isArray(snapshot["placement"])
      ? (snapshot["placement"] as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const workerHostId = text(snapshot["workerHostId"]) ?? text(placement["workerHostId"]);
  const workerId = text(snapshot["workerId"]) ?? text(placement["workerId"]);
  const harness = text(snapshot["harness"]) ?? text(placement["harness"]);
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(workerHostId === undefined ? {} : { workerHostId }),
    ...(workerId === undefined ? {} : { workerId }),
  };
}

export function statusHelp(): string {
  return `Usage: supertag status [--output text|json]

Shows what the organization is doing right now, on one screen: each Worker Host with its
connection and running Task Attempts against capacity per harness, each Tag as idle or busy with
its running Tasks, each Objective that is not finished with its status, spend against budget,
time to deadline, and items waiting for the operator, and the operator inbox count.
Unpriced Task Attempts show token counts and a warning that their monetary budget cannot be enforced.
Worker Hosts with reported low free disk show a warning below their row. The threshold is the
smaller of 10 GiB and 5% of the host's temporary filesystem volume.

  --output text|json     Output format (default: text)
`;
}

export async function runStatusCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  now: () => Date = () => new Date(),
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) return statusHelp();
  const output = takeOutputFlag(args);
  if (output.args.length > 0)
    throw new Error(`supertag status takes no arguments: ${output.args.join(" ")}`);
  const client = new ControlPlaneClient(target);
  const [organization, inbox] = await Promise.all([
    client.request<OrganizationStatus>("/api/v1/organization"),
    operatorInbox(client),
  ]);
  const items = inbox.items;
  const byObjective = new Map<string, number>();
  for (const { objectiveId } of items)
    if (objectiveId !== null) byObjective.set(objectiveId, (byObjective.get(objectiveId) ?? 0) + 1);
  const view: OrganizationStatusView = {
    ...organization,
    objectives: organization.objectives.map((objective) => ({
      ...objective,
      needsOperator: byObjective.get(objective.id) ?? 0,
    })),
    inbox: { items: items.length, truncated: inbox.truncated },
  };
  return output.json ? `${JSON.stringify(view, null, 2)}\n` : formatOrganizationStatus(view, now());
}

/** Every item the operator decides, as `supertag list inbox` counts them. */
async function operatorInbox(client: ControlPlaneClient): Promise<{
  items: CoordinationInboxPage["items"][number][];
  truncated: boolean;
}> {
  const items: CoordinationInboxPage["items"][number][] = [];
  let truncated = false;
  let cursor: string | undefined;
  do {
    const page: CoordinationInboxPage = await client.request<CoordinationInboxPage>(
      `/api/v1/coordination/inbox${cursor === undefined ? "" : `?${new URLSearchParams({ cursor })}`}`,
      { method: "GET" },
    );
    items.push(...page.items.filter((item) => item.operatorEligible));
    if ((page.truncatedKinds ?? []).length > 0) truncated = true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { items, truncated };
}

export function formatOrganizationStatus(view: OrganizationStatusView, now: Date): string {
  const lines: string[] = ["Worker Hosts"];
  if (view.workerHosts.length === 0)
    lines.push("  none; add one with supertag up or supertag connect worklet");
  for (const host of view.workerHosts) {
    const loads = host.harnesses.length
      ? host.harnesses
          .map(
            (load) =>
              `${load.harness} ${load.running}/${load.capacity}${load.coordinationCapacity ? ` (${load.coordinationCapacity} owner-only slot${load.coordinationCapacity === 1 ? "" : "s"})` : ""}`,
          )
          .join(", ")
      : "no Workers";
    lines.push(
      `  ${host.id}  ${host.phase}  ${host.running}/${host.capacity} Task Attempts running (${loads})`,
    );
    if (host.diskWarning) lines.push(`    ${host.diskWarning}`);
  }
  lines.push("", "Tags");
  if (view.tags.length === 0) lines.push("  none");
  for (const tag of view.tags) {
    lines.push(
      `  ${tag.name}  ${tag.runningTaskIds.length ? `busy: ${tag.runningTaskIds.join(", ")}` : "idle"}`,
    );
    for (const running of tag.runningCommands) {
      const command = runningCommandText(running, now.getTime());
      if (command) lines.push(`    ${running.taskId}  ${command}`);
    }
  }
  lines.push("", "Objectives not finished");
  if (view.objectives.length === 0) lines.push("  none");
  for (const objective of view.objectives) {
    const details = [
      objective.status,
      `owner ${objective.ownerName}`,
      spendText(objective),
      deadlineText(objective.deadline, now),
      ...(objective.needsOperator > 0 ? [`${objective.needsOperator} need you`] : []),
    ];
    lines.push(`  ${objective.id}  ${details.join("; ")}`);
    if (objective.unpricedAttempts)
      lines.push(
        `    unpriced; ${objective.unpricedAttempts} Task Attempts; ${objective.unpricedTokens ?? 0} tokens${objective.budgetLimitMinor !== null && objective.currency !== null ? "; budget cannot be enforced for these Task Attempts" : ""}`,
      );
    for (const finding of objective.highFindings ?? [])
      lines.push(
        `    High finding: ${finding.taskId} ${finding.id}: ${finding.summary}${finding.location ? ` (${finding.location})` : ""}`,
      );
  }
  lines.push(
    "",
    view.inbox.items === 0 && !view.inbox.truncated
      ? "Operator inbox: empty; see supertag list inbox --all for Tag decisions"
      : `Operator inbox: ${view.inbox.truncated ? "at least " : ""}${view.inbox.items} ${view.inbox.items === 1 ? "item" : "items"}; see supertag list inbox`,
  );
  return `${lines.map(terminalText).join("\n")}\n`;
}

function spendText(objective: OrganizationStatus["objectives"][number]): string {
  const { spentMinor, budgetLimitMinor, currency, spendCurrency } = objective;
  const spent =
    objective.unpricedAttempts && spentMinor === 0
      ? "unpriced"
      : spendCurrency === null
        ? `${spentMinor} units`
        : money(spentMinor, spendCurrency);
  if (budgetLimitMinor === null)
    return spendCurrency === null ? "no budget" : `${spent} spent, no budget`;
  // Keep the measures distinct: an allocation budget is never shown as money.
  const budget =
    currency === null ? `${budgetLimitMinor} budget units` : money(budgetLimitMinor, currency);
  return `${spent} of ${budget}`;
}

function deadlineText(deadline: string | null, now: Date): string {
  if (deadline === null) return "no deadline";
  const minutes = Math.round((Date.parse(deadline) - now.getTime()) / 60_000);
  const span = (total: number) => {
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours >= 48) return `${Math.floor(hours / 24)}d`;
    return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  };
  return minutes >= 0 ? `deadline in ${span(minutes)}` : `deadline passed ${span(-minutes)} ago`;
}
