import {
  type Objective,
  objectiveClosed,
  parseCreateObjective,
  type Store,
  TagMessagingError,
  TEAM_MAX_MEMBERS,
  type Team,
} from "@supertag/core";
import { type FieldChange, sameValue } from "./field-management.js";
import {
  type ManagedPlan,
  type ManagedWriteOptions,
  planManagedWrite,
  planReport,
} from "./managed-apply.js";
import { money } from "./money.js";

/**
 * Declarative Objectives: the `Objective` manifest kind and the `objectives` map of a project
 * file. `metadata.name` is the Objective ID. The spec declares what the Objective is; its status
 * is observed, never declared.
 *
 * Most of an Objective is fixed once it exists: its owner, its outcome statement, whether it is
 * ongoing, its Workspaces, and which Team it names. The owner reads those as the definition of
 * the work, so changing them in place would change work already under way. A new name creates a
 * new Objective instead. The deadline, a larger budget, and runtime actions have operator update
 * paths, so apply changes them in place.
 *
 * `team` names an existing Team, or declares the Objective's own Team in place. A declared Team
 * has the Objective's ID as its Team ID; apply creates it with the Objective and updates its name,
 * members, and concurrency limit afterwards.
 */

export const OBJECTIVE_SPEC_FIELDS = [
  "owner",
  "outcome",
  "ongoing",
  "workspaces",
  "budget",
  "deadline",
  "runtimeActions",
  "team",
] as const;

const TEAM_FIELDS = ["name", "members", "maxConcurrency"] as const;

/** Fields fixed at creation; changing one means a new Objective under a new name. */
const FIXED_FIELDS = ["owner", "outcome", "ongoing", "workspaces"] as const;

/** Optional fields that keep their value when a manifest stops setting them. */
const RELEASED_FIELDS = new Set([
  "spec.deadline",
  "spec.budget",
  "spec.runtimeActions",
  "spec.team",
]);

/** Fixed fields' defaults: no longer setting one to its default changes nothing. */
const FIXED_DEFAULTS: Readonly<Record<string, unknown>> = {
  "spec.ongoing": false,
  "spec.workspaces": [],
};

/** A Team declared in the Objective manifest; its Team ID is the Objective's ID. */
export interface ObjectiveTeamSpec {
  /** Defaults to the Objective's ID. */
  readonly name?: string;
  /** Member Tag names, sorted and distinct. */
  readonly members: readonly string[];
  /** Optional limit on turns running at once; omitted means Worker Host capacity is the limit. */
  readonly maxConcurrency?: number;
}

/** The manifest form of an Objective spec, with Tags by name. */
export interface ObjectiveManifestSpec {
  readonly owner?: string;
  readonly outcome?: string;
  readonly ongoing?: boolean;
  readonly workspaces?: readonly string[];
  readonly budget?: { readonly minor: number; readonly currency?: string };
  readonly deadline?: string;
  readonly runtimeActions?: readonly string[];
  /** An existing Team's name, or the Objective's own Team. */
  readonly team?: string | ObjectiveTeamSpec;
}

export interface ObjectiveRefusal {
  readonly path: string;
  readonly reason: string;
}

export interface ObjectiveManifestPlan {
  readonly name: string;
  readonly objective?: Objective;
  readonly managed: ManagedPlan;
  /** Changes apply cannot make; any one refuses the whole write. */
  readonly refusals: readonly ObjectiveRefusal[];
  /** Apply starts the owner: on creation, or for a declared Objective that never started. */
  readonly start: boolean;
  /** Why apply leaves a declared Objective unchanged, such as its cancellation. */
  readonly held?: string;
}

/** Validates an Objective manifest and returns its name and normalized spec. */
export function parseObjectiveManifest(value: unknown): {
  readonly name: string;
  readonly spec: ObjectiveManifestSpec;
} {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== "supertag/v1" ||
    value["kind"] !== "Objective" ||
    !isRecord(value["metadata"])
  )
    throw new TagMessagingError(
      400,
      "Objective manifest requires apiVersion supertag/v1, kind Objective, and metadata",
    );
  if (value["status"] !== undefined)
    throw new TagMessagingError(
      400,
      "Objective status is observed, not declared; remove status from the manifest",
    );
  const name = value["metadata"]["name"];
  if (typeof name !== "string" || !name.trim())
    throw new TagMessagingError(400, "Objective metadata.name is required");
  const spec = value["spec"] ?? {};
  if (!isRecord(spec)) throw new TagMessagingError(400, "Objective spec must be a map");
  for (const field of Object.keys(spec))
    if (field === "status")
      throw new TagMessagingError(
        400,
        "spec.status: an Objective's status is observed, not declared. Cancel it with supertag cancel objective, or approve it with supertag approve objective",
      );
    else if (!(OBJECTIVE_SPEC_FIELDS as readonly string[]).includes(field))
      throw new TagMessagingError(
        400,
        `spec.${field} is not an Objective field; expected ${OBJECTIVE_SPEC_FIELDS.join(", ")}`,
      );
  if (typeof spec["owner"] !== "string" || !spec["owner"].trim())
    throw new TagMessagingError(400, "spec.owner is required: the name of the owner Tag");
  if (spec["outcome"] === undefined)
    throw new TagMessagingError(400, "spec.outcome is required: one statement of the outcome");
  const budget = spec["budget"];
  if (budget !== undefined && budget !== null) {
    if (!isRecord(budget))
      throw new TagMessagingError(400, "spec.budget must be a map with minor and currency");
    for (const field of Object.keys(budget))
      if (field !== "minor" && field !== "currency")
        throw new TagMessagingError(400, `spec.budget.${field} is not a budget field`);
  }
  for (const field of ["workspaces", "runtimeActions"] as const)
    if (spec[field] !== undefined && spec[field] !== null && !Array.isArray(spec[field]))
      throw new TagMessagingError(400, `spec.${field} must be a list`);
  // The Objective parser validates and normalizes exactly as creation does.
  const definition = parseCreateObjective({
    id: name.trim(),
    outcome: spec["outcome"],
    ...(spec["ongoing"] === undefined ? {} : { ongoing: spec["ongoing"] }),
    ...(spec["workspaces"] == null ? {} : { workspaces: spec["workspaces"] }),
    ...(isRecord(budget)
      ? {
          budgetLimitMinor: budget["minor"],
          ...(budget["currency"] === undefined ? {} : { budgetCurrency: budget["currency"] }),
        }
      : {}),
    ...(spec["deadline"] == null ? {} : { deadline: dateText(spec["deadline"]) }),
    ...(spec["runtimeActions"] == null ? {} : { runtimeActions: spec["runtimeActions"] }),
  });
  if (isRecord(budget) && definition.budgetLimitMinor === null)
    throw new TagMessagingError(400, "spec.budget.minor is required");
  const team = parseTeam(spec["team"]);
  return {
    name: definition.id,
    spec: {
      owner: spec["owner"].trim(),
      outcome: definition.outcome,
      ...(spec["ongoing"] === undefined ? {} : { ongoing: definition.ongoing === true }),
      ...(spec["workspaces"] == null ? {} : { workspaces: definition.workspaces ?? [] }),
      ...(definition.budgetLimitMinor == null
        ? {}
        : {
            budget: {
              minor: definition.budgetLimitMinor,
              ...(definition.budgetCurrency == null ? {} : { currency: definition.budgetCurrency }),
            },
          }),
      ...(definition.deadline == null ? {} : { deadline: definition.deadline }),
      ...(spec["runtimeActions"] == null
        ? {}
        : { runtimeActions: actionSet(definition.runtimeActions ?? []) }),
      ...(team === undefined ? {} : { team }),
    },
  };
}

function parseTeam(value: unknown): string | ObjectiveTeamSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) throw new TagMessagingError(400, "spec.team must name a Team");
    return value.trim();
  }
  if (!isRecord(value))
    throw new TagMessagingError(
      400,
      "spec.team must name an existing Team, or be a map with members and optional name and maxConcurrency",
    );
  for (const field of Object.keys(value))
    if (!(TEAM_FIELDS as readonly string[]).includes(field))
      throw new TagMessagingError(
        400,
        `spec.team.${field} is not a Team field; expected ${TEAM_FIELDS.join(", ")}`,
      );
  const name = value["name"];
  if (
    name !== undefined &&
    (typeof name !== "string" || !name.trim() || name.trim().length > 200 || /\p{Cc}/u.test(name))
  )
    throw new TagMessagingError(400, "spec.team.name must contain 1–200 characters");
  const members = value["members"];
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    members.length > TEAM_MAX_MEMBERS ||
    members.some((member) => typeof member !== "string" || !member.trim())
  )
    throw new TagMessagingError(400, `spec.team.members must list 1–${TEAM_MAX_MEMBERS} Tag names`);
  const concurrency = value["maxConcurrency"];
  if (
    concurrency !== undefined &&
    concurrency !== null &&
    (!Number.isSafeInteger(concurrency) ||
      (concurrency as number) < 1 ||
      (concurrency as number) > 1000)
  )
    throw new TagMessagingError(400, "spec.team.maxConcurrency must be an integer from 1 to 1000");
  return {
    ...(typeof name === "string" ? { name: name.trim() } : {}),
    members: memberNames((members as string[]).map((member) => member.trim())),
    ...(concurrency === undefined || concurrency === null
      ? {}
      : { maxConcurrency: concurrency as number }),
  };
}

function memberNames(members: readonly string[]): string[] {
  return [...new Set(members)].toSorted();
}

function actionSet(actions: readonly string[]): string[] {
  return [...new Set(actions)].toSorted();
}

function dateText(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The Team an Objective names, or undefined when it names none or the Team is gone. */
async function objectiveTeam(store: Store, objective: Objective): Promise<Team | undefined> {
  return objective.teamId === null ? undefined : store.getTeam(objective.teamId);
}

/** A Team by name or ID. */
async function findTeam(store: Store, nameOrId: string): Promise<Team | undefined> {
  return (
    (await store.getTeam(nameOrId)) ??
    (await store.listTeams()).find((team) => team.name === nameOrId)
  );
}

/** The manifest form of a stored Team: inline when it is the Objective's own, else its name. */
async function teamSpec(
  store: Store,
  objective: Objective,
  team: Team,
): Promise<string | ObjectiveTeamSpec> {
  if (team.id !== objective.id) return team.name;
  const members: string[] = [];
  for (const id of team.memberTagIds) members.push((await store.findTagById(id))?.name ?? id);
  return {
    ...(team.name === objective.id ? {} : { name: team.name }),
    members: memberNames(members),
    ...(team.maxConcurrency === null ? {} : { maxConcurrency: team.maxConcurrency }),
  };
}

/** The stored Objective in manifest form. */
export async function objectiveManifestSpec(
  store: Store,
  objective: Objective,
): Promise<ObjectiveManifestSpec> {
  const tagName = async (id: string) => (await store.findTagById(id))?.name ?? id;
  const team = await objectiveTeam(store, objective);
  return {
    owner: await tagName(objective.ownerTagId),
    outcome: objective.outcome,
    ongoing: objective.ongoing === true,
    workspaces: [...(objective.workspaces ?? [])],
    ...(objective.budgetLimitMinor == null
      ? {}
      : {
          budget: {
            minor: objective.budgetLimitMinor,
            ...(objective.budgetCurrency == null ? {} : { currency: objective.budgetCurrency }),
          },
        }),
    ...(objective.deadline == null ? {} : { deadline: objective.deadline }),
    runtimeActions: actionSet(objective.runtimeActions ?? []),
    ...(team === undefined ? {} : { team: await teamSpec(store, objective, team) }),
  };
}

/** Plans one Objective manifest under field ownership without writing anything. */
export async function planObjectiveManifest(
  store: Store,
  input: {
    readonly name: string;
    readonly spec: ObjectiveManifestSpec;
    readonly options: ManagedWriteOptions;
  },
): Promise<ObjectiveManifestPlan> {
  const objective = await store.getObjective(input.name).catch((error: unknown) => {
    if (error instanceof TagMessagingError && error.statusCode === 404) return undefined;
    throw error;
  });
  const current =
    objective === undefined ? undefined : await objectiveManifestSpec(store, objective);
  const planned = await planManagedWrite(store, {
    kind: "Objective",
    name: input.name,
    currentSpec: current,
    desiredSpec: input.spec,
    options: input.options,
  });
  const managed = fixedConflictsRefused(releaseOptionalFields(planned));
  const refusals: ObjectiveRefusal[] = [];
  // A cancelled Objective never runs again. Its declaration changes nothing and blocks nothing.
  if (objective?.status === "cancelled")
    return {
      name: input.name,
      objective,
      managed: { ...managed, merge: { ...managed.merge, changes: [], conflicts: [] } },
      refusals,
      start: false,
      held: `Objective ${objective.id} was cancelled and cannot run again; remove it from the input, or give the declaration a new name to create a new Objective`,
    };
  if (objective !== undefined && current !== undefined) {
    // Taking ownership cannot change a fixed field, so its conflict is a refusal instead.
    for (const conflict of planned.merge.conflicts)
      if (isFixedPath(conflict.path))
        refusals.push({
          path: conflict.path,
          reason: fixedReason(conflict.path.slice("spec.".length), input.name),
        });
    const closed = objectiveClosed(objective.status);
    for (const change of managed.merge.changes) {
      const reason = closed
        ? `Objective ${objective.id} is completed and cannot change; give the declaration a new name to create a new Objective`
        : changeRefusal(change, current, input.name);
      if (reason !== undefined) refusals.push({ path: change.path, reason });
    }
  } else refusals.push(...(await newTeamRefusals(store, input.name, input.spec.team)));
  return {
    name: input.name,
    ...(objective === undefined ? {} : { objective }),
    managed,
    refusals,
    start:
      objective === undefined ||
      (!objectiveClosed(objective.status) && !objective.executionStartedAt),
  };
}

/**
 * A manifest that stops setting the deadline, budget, or runtime actions releases the field:
 * the Objective keeps its value, since none of them can be cleared.
 */
function releaseOptionalFields(plan: ManagedPlan): ManagedPlan {
  const released = plan.merge.changes.filter(
    (change) =>
      change.action === "remove" &&
      (RELEASED_FIELDS.has(change.path) ||
        (change.path in FIXED_DEFAULTS && sameValue(change.before, FIXED_DEFAULTS[change.path]))),
  );
  if (released.length === 0) return plan;
  const fields = new Map(plan.merge.fields);
  const owners = new Map(plan.merge.owners);
  for (const change of released) {
    fields.set(change.path, change.before);
    owners.delete(change.path);
  }
  return {
    ...plan,
    merge: {
      ...plan.merge,
      fields,
      owners,
      changes: plan.merge.changes.filter((change) => !released.includes(change)),
    },
    spec: { ...plan.spec, ...specOf(released) },
  };
}

function specOf(changes: readonly FieldChange[]): Record<string, unknown> {
  return Object.fromEntries(
    changes.map((change) => [change.path.slice("spec.".length), change.before]),
  );
}

/** Why apply cannot make one change to an open Objective, or undefined when it can. */
function changeRefusal(
  change: FieldChange,
  current: ObjectiveManifestSpec,
  name: string,
): string | undefined {
  const field = change.path.slice("spec.".length);
  if (isFixedPath(change.path)) return fixedReason(field, name);
  if (field === "team") return teamChangeRefusal(change, name);
  if (field === "budget") {
    const before = current.budget;
    const after = change.after as ObjectiveManifestSpec["budget"];
    if (before === undefined)
      return "an Objective created without a budget cannot gain one; give the declaration a new name to create a new Objective";
    if ((after?.currency ?? null) !== (before.currency ?? null))
      return "a budget's currency cannot change";
    if (after === undefined || after.minor <= before.minor)
      return `a budget can only increase above its current limit, ${before.currency ? money(before.minor, before.currency) : `${before.minor} allocation units`}`;
  }
  return undefined;
}

function isFixedPath(path: string): boolean {
  return (FIXED_FIELDS as readonly string[]).includes(path.slice("spec.".length));
}

function fixedReason(field: string, name: string): string {
  return `${field} changed; an Objective's ${field} is fixed once it exists. Give the declaration a new name to create a new Objective, then cancel ${name} or let --prune cancel it`;
}

function fixedConflictsRefused(plan: ManagedPlan): ManagedPlan {
  const conflicts = plan.merge.conflicts.filter((conflict) => !isFixedPath(conflict.path));
  return conflicts.length === plan.merge.conflicts.length
    ? plan
    : { ...plan, merge: { ...plan.merge, conflicts } };
}

/**
 * The Team an Objective names is fixed; only its own declared Team's name, members, and limit
 * change in place.
 */
function teamChangeRefusal(change: FieldChange, name: string): string | undefined {
  if (change.action === "change" && isRecord(change.before) && isRecord(change.after))
    return undefined;
  return change.action === "add"
    ? "an Objective created without a Team cannot gain one; give the declaration a new name to create a new Objective"
    : fixedReason("team", name);
}

/** Why a new Objective's `team` cannot be created as declared, if it cannot. */
async function newTeamRefusals(
  store: Store,
  objectiveId: string,
  team: ObjectiveManifestSpec["team"],
): Promise<ObjectiveRefusal[]> {
  if (team === undefined) return [];
  if (typeof team === "string")
    return (await findTeam(store, team)) === undefined
      ? [
          {
            path: "spec.team",
            reason: `Team ${team} does not exist; create it with supertag create team ${team} --member TAG, or declare the Team in place`,
          },
        ]
      : [];
  const name = team.name ?? objectiveId;
  const own = await store.getTeam(objectiveId);
  const named = (await store.listTeams()).find((candidate) => candidate.name === name);
  if (named !== undefined && named.id !== objectiveId)
    return [
      {
        path: "spec.team",
        reason: `a Team named ${name} already exists; name it with team: ${name} to work with it, or give the declared Team another name`,
      },
    ];
  if (own === undefined) return [];
  // A Team left by an earlier apply that stopped before creating the Objective is resumed.
  const members = await Promise.all(
    own.memberTagIds.map(async (id) => (await store.findTagById(id))?.name ?? id),
  );
  return own.name === name &&
    sameValue(memberNames(members), team.members) &&
    own.maxConcurrency === (team.maxConcurrency ?? null)
    ? []
    : [
        {
          path: "spec.team",
          reason: `Team ${objectiveId} already exists with other members; give the declaration a new name to create a new Objective`,
        },
      ];
}

/** The machine-readable plan for a dry run. */
export function objectivePlanReport(plan: ObjectiveManifestPlan) {
  const report = planReport(plan.managed);
  return {
    ...report,
    action: report.action === "unchanged" && plan.start ? ("update" as const) : report.action,
    refusals: plan.refusals,
    start: plan.start,
    ...(plan.held === undefined ? {} : { held: plan.held }),
  };
}

export function objectiveRefusalMessage(plan: ObjectiveManifestPlan): string {
  return `Objective ${plan.name} cannot be applied: ${plan.refusals
    .map((refusal) => `${refusal.path}: ${refusal.reason}`)
    .join("; ")}.`;
}

/** What applying the write did, beyond reconciling fields. */
export interface ObjectiveApplyResult {
  readonly objective: Objective;
  readonly created: boolean;
  readonly warnings: readonly string[];
  /** The Objective's first turn, when apply started it. */
  readonly started?: { readonly taskId: string };
  readonly notStarted?: string;
}

export interface ObjectiveApplyDependencies {
  readonly store: Store;
  /** Creates an Objective with the owner's runtime actions resolved, as `create objective` does. */
  readonly create: (
    definition: Record<string, unknown>,
    ownerTagId: string,
  ) => Promise<{ readonly objective: Objective; readonly warnings: readonly string[] }>;
  /** Changes deadline, budget, or runtime actions through the operator update path. */
  readonly update: (
    objective: Objective,
    change: {
      readonly deadline?: string;
      readonly budgetLimitMinor?: number;
      readonly runtimeActions?: readonly string[];
    },
  ) => Promise<{ readonly objective: Objective; readonly warnings: readonly string[] }>;
  /** Admits the Objective's first turn. */
  readonly start: (objective: Objective) => Promise<{ readonly taskId: string }>;
  readonly runnable?: (objective: Objective) => Promise<{ readonly reasons: readonly string[] }>;
}

/**
 * Carries out a plan with no refusals or conflicts: creates the declared Team and the Objective,
 * or updates them, then starts the Objective when the plan says so. A failure stops the write;
 * applying again resumes it.
 */
export async function applyObjectiveManifest(
  dependencies: ObjectiveApplyDependencies,
  plan: ObjectiveManifestPlan,
): Promise<ObjectiveApplyResult> {
  const { store } = dependencies;
  const spec = plan.managed.spec as ObjectiveManifestSpec;
  const tagId = async (name: string, field: string) => {
    const tag = await store.findTagByName(name);
    if (tag?.status !== "active")
      throw new TagMessagingError(400, `${field}: Tag ${name} does not exist`);
    return tag.id;
  };
  const memberIds = (team: ObjectiveTeamSpec) =>
    Promise.all(team.members.map((name) => tagId(name, "spec.team.members")));
  let objective = plan.objective;
  const warnings: string[] = [];
  let created = false;
  if (objective === undefined) {
    let teamId: string | undefined;
    if (typeof spec.team === "string") teamId = (await findTeam(store, spec.team))?.id;
    else if (spec.team !== undefined) {
      teamId = plan.name;
      if ((await store.getTeam(plan.name)) === undefined)
        await store.createTeam({
          id: plan.name,
          name: spec.team.name ?? plan.name,
          memberTagIds: await memberIds(spec.team),
          ...(spec.team.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: spec.team.maxConcurrency }),
        });
    }
    const result = await dependencies.create(
      {
        id: plan.name,
        outcome: spec.outcome,
        ...(spec.ongoing === undefined ? {} : { ongoing: spec.ongoing }),
        ...(spec.workspaces === undefined ? {} : { workspaces: spec.workspaces }),
        ...(spec.budget === undefined
          ? {}
          : {
              budgetLimitMinor: spec.budget.minor,
              ...(spec.budget.currency === undefined
                ? {}
                : { budgetCurrency: spec.budget.currency }),
            }),
        ...(spec.deadline === undefined ? {} : { deadline: spec.deadline }),
        ...(spec.runtimeActions === undefined ? {} : { runtimeActions: spec.runtimeActions }),
        ...(teamId === undefined ? {} : { teamId }),
      },
      await tagId(spec.owner ?? "", "spec.owner"),
    );
    objective = result.objective;
    warnings.push(...result.warnings);
    created = true;
  } else {
    const change: {
      deadline?: string;
      budgetLimitMinor?: number;
      runtimeActions?: readonly string[];
    } = {};
    for (const item of plan.managed.merge.changes) {
      if (item.action === "remove") continue;
      if (item.path === "spec.deadline") change.deadline = item.after as string;
      if (item.path === "spec.budget")
        change.budgetLimitMinor = (item.after as { minor: number }).minor;
      if (item.path === "spec.runtimeActions")
        change.runtimeActions = item.after as readonly string[];
      if (item.path === "spec.team" && objective.teamId !== null) {
        const team = item.after as ObjectiveTeamSpec;
        const current = await store.getTeam(objective.teamId);
        if (current === undefined)
          throw new TagMessagingError(409, `Team ${objective.teamId} no longer exists`);
        await store.updateTeam(current.id, {
          expectedRevision: current.revision,
          name: team.name ?? objective.id,
          memberTagIds: await memberIds(team),
          // A manifest that stops setting the limit removes it.
          maxConcurrency: team.maxConcurrency ?? null,
        });
      }
    }
    if (Object.keys(change).length > 0) {
      const result = await dependencies.update(objective, change);
      objective = result.objective;
      warnings.push(...result.warnings);
    }
  }
  if (created && dependencies.runnable && !objectiveClosed(objective.status))
    warnings.push(...(await dependencies.runnable(objective)).reasons);
  let started: ObjectiveApplyResult["started"];
  let notStarted: string | undefined;
  if (plan.start && !objectiveClosed(objective.status))
    try {
      started = await dependencies.start(objective);
    } catch (error) {
      if (!(error instanceof TagMessagingError)) throw error;
      notStarted = error.message;
    }
  return {
    objective,
    created,
    warnings,
    ...(started === undefined ? {} : { started }),
    ...(notStarted === undefined ? {} : { notStarted }),
  };
}

/** The stored Objective as a resource: its manifest spec and observed status. */
export async function objectiveResource(store: Store, objective: Objective) {
  const spec = await objectiveManifestSpec(store, objective);
  return {
    apiVersion: "supertag/v1" as const,
    kind: "Objective" as const,
    metadata: {
      id: objective.id,
      name: objective.id,
      resourceVersion: String(objective.revision),
      createdAt: objective.createdAt,
      updatedAt: objective.updatedAt,
    },
    spec,
    status: {
      phase: objective.status,
      revision: objective.revision,
      started: Boolean(objective.executionStartedAt),
      ...(objective.cancelledAt ? { cancelledAt: objective.cancelledAt } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
