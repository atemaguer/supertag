import {
  type Objective,
  objectiveClosed,
  parseCreateObjective,
  type Store,
  TagMessagingError,
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
 * ongoing, its Workspaces, and the Workstreams it observes. Owners and Tasks read those as the
 * definition of the work, so changing them in place would change work already accepted. A new
 * name creates a new Objective instead. The deadline, a larger budget, and runtime actions have
 * operator update paths, so apply changes them in place. Nested Teams are created, updated, and
 * dissolved under field ownership: apply dissolves only Teams it created and the input dropped.
 */

export const OBJECTIVE_SPEC_FIELDS = [
  "owner",
  "outcome",
  "ongoing",
  "workspaces",
  "observe",
  "budget",
  "deadline",
  "runtimeActions",
  "teams",
] as const;

const TEAM_FIELDS = ["lead", "members", "maxConcurrency"] as const;

/** The Team every started Objective has; its owner leads it, and it is never declared. */
const LEADERSHIP_TEAM = "leadership";

const TEAM_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** Fields fixed at creation; changing one means a new Objective under a new name. */
const FIXED_FIELDS = ["owner", "outcome", "ongoing", "workspaces", "observe"] as const;

/** Optional fields that keep their value when a manifest stops setting them. */
const RELEASED_FIELDS = new Set(["spec.deadline", "spec.budget", "spec.runtimeActions"]);

/** Fixed fields' defaults: no longer setting one to its default changes nothing. */
const FIXED_DEFAULTS: Readonly<Record<string, unknown>> = {
  "spec.ongoing": false,
  "spec.workspaces": [],
  "spec.observe": [],
};

export interface ObjectiveTeamSpec {
  readonly lead: string;
  readonly members: readonly string[];
  /** Optional throttle; omitted means Worker Host capacity is the only limit. */
  readonly maxConcurrency?: number;
}

/** The manifest form of an Objective spec, with Tags by name. */
export interface ObjectiveManifestSpec {
  readonly owner?: string;
  readonly outcome?: string;
  readonly ongoing?: boolean;
  readonly workspaces?: readonly string[];
  readonly observe?: readonly string[];
  readonly budget?: { readonly minor: number; readonly currency?: string };
  readonly deadline?: string;
  readonly runtimeActions?: readonly string[];
  readonly teams?: Readonly<Record<string, ObjectiveTeamSpec>>;
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
  for (const field of ["workspaces", "observe", "runtimeActions"] as const)
    if (spec[field] !== undefined && spec[field] !== null && !Array.isArray(spec[field]))
      throw new TagMessagingError(400, `spec.${field} must be a list`);
  // The Objective parser validates and normalizes exactly as creation does.
  const definition = parseCreateObjective({
    id: name.trim(),
    outcome: spec["outcome"],
    ...(spec["ongoing"] === undefined ? {} : { ongoing: spec["ongoing"] }),
    ...(spec["workspaces"] == null ? {} : { workspaces: spec["workspaces"] }),
    ...(spec["observe"] == null
      ? {}
      : {
          observations: (spec["observe"] as unknown[]).map((workstreamId) => ({ workstreamId })),
        }),
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
  const teams = parseTeams(spec["teams"]);
  return {
    name: definition.id,
    spec: {
      owner: spec["owner"].trim(),
      outcome: definition.outcome,
      ...(spec["ongoing"] === undefined ? {} : { ongoing: definition.ongoing === true }),
      ...(spec["workspaces"] == null ? {} : { workspaces: definition.workspaces ?? [] }),
      ...(spec["observe"] == null
        ? {}
        : { observe: (definition.observations ?? []).map((source) => source.workstreamId) }),
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
      ...(teams === undefined ? {} : { teams }),
    },
  };
}

function parseTeams(value: unknown): Record<string, ObjectiveTeamSpec> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    throw new TagMessagingError(
      400,
      "spec.teams must map Team names to lead, members, and an optional maxConcurrency",
    );
  const teams: Record<string, ObjectiveTeamSpec> = {};
  for (const [key, team] of Object.entries(value)) {
    const field = `spec.teams.${key}`;
    if (!TEAM_KEY.test(key))
      throw new TagMessagingError(
        400,
        `${field}: Team names use 1-63 lowercase letters, digits, hyphens, or underscores`,
      );
    if (key === LEADERSHIP_TEAM)
      throw new TagMessagingError(
        400,
        `${field}: leadership is the owner's own Team, formed when the Objective starts; choose another name`,
      );
    if (!isRecord(team))
      throw new TagMessagingError(400, `${field} must be a map with lead and members`);
    for (const name of Object.keys(team))
      if (!(TEAM_FIELDS as readonly string[]).includes(name))
        throw new TagMessagingError(
          400,
          `${field}.${name} is not a Team field; expected ${TEAM_FIELDS.join(", ")}`,
        );
    const lead = team["lead"];
    if (typeof lead !== "string" || !lead.trim())
      throw new TagMessagingError(400, `${field}.lead is required: the lead Tag's name`);
    const members = team["members"] ?? [];
    if (
      !Array.isArray(members) ||
      members.length > 100 ||
      members.some((member) => typeof member !== "string" || !member.trim())
    )
      throw new TagMessagingError(400, `${field}.members must be a list of Tag names`);
    const concurrency = team["maxConcurrency"];
    if (
      concurrency !== undefined &&
      concurrency !== null &&
      (!Number.isSafeInteger(concurrency) ||
        (concurrency as number) < 1 ||
        (concurrency as number) > 1000)
    )
      throw new TagMessagingError(400, `${field}.maxConcurrency must be an integer from 1 to 1000`);
    teams[key] = {
      lead: lead.trim(),
      members: memberNames(
        lead.trim(),
        (members as string[]).map((member) => member.trim()),
      ),
      ...(concurrency === undefined || concurrency === null
        ? {}
        : { maxConcurrency: concurrency as number }),
    };
  }
  return teams;
}

/** Members other than the lead, sorted and distinct; the lead is always a member. */
function memberNames(lead: string, members: readonly string[]): string[] {
  return [...new Set(members)].filter((member) => member !== lead).toSorted();
}

function actionSet(actions: readonly string[]): string[] {
  return [...new Set(actions)].toSorted();
}

function dateText(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The Team ID of a declared Team: Team IDs are global, so each is scoped to its Objective. */
export function declaredTeamId(objectiveId: string, key: string): string {
  return `${objectiveId}:${key}`;
}

/** The stored Objective in manifest form, with its declarable Teams. */
export async function objectiveManifestSpec(
  store: Store,
  objective: Objective,
): Promise<ObjectiveManifestSpec & { readonly teams: Record<string, ObjectiveTeamSpec> }> {
  const tagName = async (id: string) => (await store.findTagById(id))?.name ?? id;
  const teams: Record<string, ObjectiveTeamSpec> = {};
  for (const team of await declarableTeams(store, objective.id)) {
    const lead = await tagName(team.leadTagId);
    const members: string[] = [];
    for (const id of team.memberTagIds) members.push(await tagName(id));
    teams[team.id.slice(objective.id.length + 1)] = {
      lead,
      members: memberNames(lead, members),
      ...(team.maxConcurrency === null ? {} : { maxConcurrency: team.maxConcurrency }),
    };
  }
  return {
    owner: await tagName(objective.ownerTagId),
    outcome: objective.outcome,
    ongoing: objective.ongoing === true,
    workspaces: [...(objective.workspaces ?? [])],
    observe: (objective.observations ?? []).map((source) => source.workstreamId),
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
    teams,
  };
}

/** Active Teams of an Objective whose IDs follow the declared form `OBJECTIVE:NAME`. */
async function declarableTeams(store: Store, objectiveId: string): Promise<readonly Team[]> {
  const prefix = `${objectiveId}:`;
  return (await store.listTeams(objectiveId)).filter(
    (team) =>
      team.status === "active" &&
      team.objectiveId === objectiveId &&
      team.id.startsWith(prefix) &&
      TEAM_KEY.test(team.id.slice(prefix.length)) &&
      team.id.slice(prefix.length) !== LEADERSHIP_TEAM,
  );
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
        : changeRefusal(change, current, objective, input.name);
      if (reason !== undefined) refusals.push({ path: change.path, reason });
    }
    for (const change of managed.merge.changes) {
      const key = teamKey(change.path);
      if (key === undefined || change.action !== "add" || closed) continue;
      const prior = await store.getTeam(declaredTeamId(objective.id, key)).catch(() => undefined);
      if (prior !== undefined)
        refusals.push({
          path: change.path,
          reason:
            prior.status === "dissolved"
              ? `Team ${prior.id} was dissolved, and dissolved Teams cannot return; give the Team a new name`
              : `Team ${prior.id} exists but is not declarable here; give the Team a new name`,
        });
    }
  }
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
  objective: Objective,
  name: string,
): string | undefined {
  const field = change.path.slice("spec.".length);
  if (isFixedPath(change.path)) return fixedReason(field, name);
  if (field === "budget") {
    const before = current.budget;
    const after = change.after as ObjectiveManifestSpec["budget"];
    if (before === undefined)
      return "an Objective created without a budget cannot gain one; give the declaration a new name to create a new Objective";
    if ((after?.currency ?? null) !== (before.currency ?? null))
      return "a budget's currency cannot change";
    if (
      after === undefined ||
      after.minor <= before.minor ||
      after.minor < objective.spentMinor + objective.reservedMinor
    )
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

function teamKey(path: string): string | undefined {
  return /^spec\.teams\[(.+)\]$/su.exec(path)?.[1];
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
  readonly started?: { readonly taskId: string; readonly teamId: string };
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
  readonly start: (
    objective: Objective,
  ) => Promise<{ readonly taskId: string; readonly teamId: string }>;
  readonly runnable?: (objective: Objective) => Promise<{ readonly reasons: readonly string[] }>;
  readonly createTeam: (input: Record<string, unknown>) => Promise<unknown>;
  readonly updateTeam: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Carries out a plan with no refusals or conflicts: creates or updates the Objective, starts its
 * owner when the plan says so, then creates and updates declared Teams before dissolving the
 * ones the input dropped. A failure stops the write; applying again resumes it.
 */
export async function applyObjectiveManifest(
  dependencies: ObjectiveApplyDependencies,
  plan: ObjectiveManifestPlan,
): Promise<ObjectiveApplyResult> {
  const { store } = dependencies;
  const spec = plan.managed.spec as ObjectiveManifestSpec;
  const tagId = async (name: string, field: string) => {
    const tag = await store.findTagByName(name);
    if (!tag) throw new TagMessagingError(400, `${field}: Tag ${name} does not exist`);
    return tag.id;
  };
  let objective = plan.objective;
  const warnings: string[] = [];
  let created = false;
  if (objective === undefined) {
    const result = await dependencies.create(
      {
        id: plan.name,
        outcome: spec.outcome,
        ...(spec.ongoing === undefined ? {} : { ongoing: spec.ongoing }),
        ...(spec.workspaces === undefined ? {} : { workspaces: spec.workspaces }),
        ...(spec.observe === undefined
          ? {}
          : { observations: spec.observe.map((workstreamId) => ({ workstreamId })) }),
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
  await reconcileTeams(dependencies, objective, plan.managed, tagId);
  return {
    objective,
    created,
    warnings,
    ...(started === undefined ? {} : { started }),
    ...(notStarted === undefined ? {} : { notStarted }),
  };
}

async function reconcileTeams(
  dependencies: ObjectiveApplyDependencies,
  objective: Objective,
  plan: ManagedPlan,
  tagId: (name: string, field: string) => Promise<string>,
): Promise<void> {
  const changes = plan.merge.changes.filter((change) => teamKey(change.path) !== undefined);
  const members = async (key: string, team: ObjectiveTeamSpec) => ({
    leadTagId: await tagId(team.lead, `spec.teams.${key}.lead`),
    memberTagIds: await Promise.all(
      team.members.map((name) => tagId(name, `spec.teams.${key}.members`)),
    ),
  });
  const current = async (id: string) =>
    (await dependencies.store.getTeam(id)) as { readonly revision: number };
  // Creating and updating first leaves room for work to move before any Team dissolves.
  for (const change of changes.filter((item) => item.action !== "remove")) {
    const key = teamKey(change.path) as string;
    const team = change.after as ObjectiveTeamSpec;
    const id = declaredTeamId(objective.id, key);
    if (change.action === "add")
      await dependencies.createTeam({
        objectiveId: objective.id,
        id,
        name: key,
        ...(await members(key, team)),
        ...(team.maxConcurrency === undefined ? {} : { maxConcurrency: team.maxConcurrency }),
      });
    else
      await dependencies.updateTeam({
        objectiveId: objective.id,
        teamId: id,
        expectedRevision: (await current(id)).revision,
        ...(await members(key, team)),
        // A manifest that stops setting a throttle removes it.
        maxConcurrency: team.maxConcurrency ?? null,
      });
  }
  for (const change of changes.filter((item) => item.action === "remove")) {
    const id = declaredTeamId(objective.id, teamKey(change.path) as string);
    const team = await dependencies.store.getTeam(id).catch(() => undefined);
    if (team === undefined || team.status === "dissolved") continue;
    try {
      await dependencies.updateTeam({
        objectiveId: objective.id,
        teamId: id,
        expectedRevision: team.revision,
        status: "dissolved",
      });
    } catch (error) {
      throw new TagMessagingError(
        error instanceof TagMessagingError ? error.statusCode : 409,
        `Team ${id} left the input but could not be dissolved: ${error instanceof Error ? error.message : String(error)}. Apply again once that is resolved`,
      );
    }
  }
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
