import type { CoordinationOperatorPrincipal } from "@supertag/control-plane";
import { parseApplySetName, TagMessagingError } from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import type { PruneItem } from "./apply-set-prune.js";
import { APPLY_MANAGER, CLI_MANAGER, locationKey } from "./field-management.js";
import type { ManagedWriteOptions } from "./managed-apply.js";
import {
  label,
  type ManifestDocument,
  manifestDocuments,
  messageOf,
  orderForApply,
} from "./manifest-documents.js";
import {
  listResourceViews,
  type PlannedResource,
  planResource,
  pruneResources,
  type ResourceApplyContext,
  readResourceView,
  writeResource,
} from "./resource-apply.js";
import type { ResourcePath, ResourceView } from "./resource-protos.js";
import {
  parseSurfaceAccountManifest,
  type SurfaceAccountManifest,
} from "./surface-account-manifest.js";

/**
 * Whole manifest inputs, as `ResourceService.DiffManifests` and `ApplyManifests` take them:
 * validation of the whole input before any write, provider verification of changed Surface
 * Account credentials, dependency order, field ownership, apply sets and prune.
 */

/** Verifies resolved Surface Account secrets with the provider, as `supertag setup surface` does. */
export type SurfaceVerifier = (
  manifest: SurfaceAccountManifest,
  secrets: Readonly<Record<string, string>>,
) => Promise<VerifiedSurfaceAccount>;

export interface ManifestApplyContext extends ResourceApplyContext {
  readonly verifySurface: SurfaceVerifier;
}

/** One document of an input as the caller read it. */
export interface ManifestInput {
  readonly manifest: unknown;
  /** Names the document in messages. Empty uses `documents[INDEX]`. */
  readonly source: string;
  /** A Surface Account's resolved secret values by name. */
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface ManifestApplyOptions {
  readonly applySet?: string;
  readonly prune: boolean;
  readonly force: boolean;
  /** Applies only documents whose resource does not exist yet. */
  readonly createOnly?: boolean;
  /** Writes as field manager `cli`: listed fields replace, others stay. */
  readonly imperative?: boolean;
}

/** A refused input: every problem, each naming the document it is about. */
export class ManifestInputError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "conflict",
    readonly fields: readonly {
      readonly path: string;
      readonly description: string;
      readonly manager?: string;
    }[],
  ) {
    super(message);
    this.name = "ManifestInputError";
  }
}

/** What applying one document would change. */
export interface DocumentPlan {
  /** The document's index in the request. */
  readonly document: number;
  readonly kind: string;
  readonly name: string;
  readonly plan: PlannedResource["plan"];
}

/** What applying one document did. */
export interface DocumentResult {
  readonly document: number;
  readonly kind: string;
  readonly name: string;
  readonly outcome: "applied" | "existed" | "failed" | "not_applied";
  readonly action?: "create" | "update" | "unchanged";
  readonly warnings: readonly string[];
  readonly startedTaskId?: string;
  readonly notStarted?: string;
  readonly verification?: {
    readonly provider: VerifiedSurfaceAccount["provider"];
    readonly displayName: string;
    readonly externalAccountId: string;
  };
  readonly failure?: Error;
}

/** A document of the request, at its index in the request. */
interface RequestDocument extends ManifestDocument {
  readonly request: number;
  readonly secrets?: Readonly<Record<string, string>>;
}

/** What validating a Surface Account established before anything is written. */
interface SurfacePreparation {
  readonly manifest: SurfaceAccountManifest;
  /** Present when apply must store credentials: the account is new, or something changed. */
  readonly verified?: VerifiedSurfaceAccount;
  /** The provider account it names, once known: stored, or just verified. */
  readonly externalAccountId?: string;
  /** No account has this name yet, so Tag locations cannot resolve it before apply. */
  readonly pending: boolean;
}

const REFERENCE_KINDS = {
  roles: "Role",
  "permission-sets": "Permission Set",
  "context-sets": "Context Set",
  tags: "Tag",
  workspaces: "Workspace",
} as const;

type ReferencePath = keyof typeof REFERENCE_KINDS;

/** Plans an apply without changing anything; never reads Surface Account secrets. */
export async function diffManifests(
  context: ManifestApplyContext,
  inputs: readonly ManifestInput[],
  options: ManifestApplyOptions,
): Promise<{ readonly plans: readonly DocumentPlan[]; readonly pruned: readonly PruneItem[] }> {
  const writeOptions = managedOptions(options);
  const documents = requestDocuments(inputs, "diff");
  const secretful = documents.filter((document) => document.secrets !== undefined);
  if (secretful.length > 0)
    throw invalid(
      "diff never reads Surface Account secrets; send documents without secrets",
      secretful.map((document) => ({
        path: `documents[${document.request}].secrets`,
        description: "not read by diff",
      })),
    );
  const { plans } = await validate(context, documents, "diff", writeOptions);
  return {
    plans: orderForApply(documents).flatMap((document) => {
      const planned = plans.get(document);
      return planned === undefined ? [] : [documentPlan(document, planned)];
    }),
    pruned:
      options.prune && writeOptions.applySet !== undefined
        ? await pruneResources(
            context,
            { applySet: writeOptions.applySet, keep: keepOf(documents), dryRun: true },
            undefined,
          )
        : [],
  };
}

/** Applies an input in dependency order, then prunes its apply set when asked. */
export async function applyManifests(
  context: ManifestApplyContext,
  inputs: readonly ManifestInput[],
  options: ManifestApplyOptions,
  principal: CoordinationOperatorPrincipal,
): Promise<{
  readonly results: readonly DocumentResult[];
  readonly complete: boolean;
  readonly pruned: readonly PruneItem[];
}> {
  const writeOptions = managedOptions(options);
  const all = requestDocuments(inputs, "apply");
  for (const document of all)
    if (document.secrets !== undefined && document.path !== "surface-accounts")
      throw invalid(`${document.source}: only a SurfaceAccount carries secrets`, [
        { path: `documents[${document.request}].secrets`, description: "only for SurfaceAccount" },
      ]);
  if (options.imperative === true) return applyImperatively(context, all, writeOptions, principal);
  const existed = new Set<RequestDocument>();
  if (options.createOnly === true)
    for (const document of all)
      if ((await getOptional(context, document.path, document.name)) !== undefined)
        existed.add(document);
  const documents = all.filter((document) => !existed.has(document));
  const { plans, surfaces } =
    documents.length === 0
      ? { plans: new Map(), surfaces: new Map() }
      : await validate(context, documents, "apply", writeOptions);
  refuseConflicts(documents, plans);
  const results = await applyDocuments(
    context,
    documents,
    writeOptions,
    principal,
    plans,
    surfaces,
  );
  const complete = results.every((result) => result.outcome === "applied");
  const ordered = [
    ...orderForApply([...existed]).map(
      (document): DocumentResult => ({
        document: document.request,
        kind: document.resource.kind,
        name: document.name,
        outcome: "existed",
        warnings: [],
      }),
    ),
    ...results,
  ];
  return {
    results: ordered,
    complete,
    pruned:
      complete && options.prune && writeOptions.applySet !== undefined
        ? await pruneResources(
            context,
            { applySet: writeOptions.applySet, keep: keepOf(all), dryRun: false },
            principal,
          )
        : [],
  };
}

/** `create tag`: one document written as field manager `cli`, without validating an input. */
async function applyImperatively(
  context: ManifestApplyContext,
  documents: readonly RequestDocument[],
  options: ManagedWriteOptions,
  principal: CoordinationOperatorPrincipal,
): Promise<{
  readonly results: readonly DocumentResult[];
  readonly complete: boolean;
  readonly pruned: readonly PruneItem[];
}> {
  const objective = documents.find((document) => document.path === "objectives");
  if (objective !== undefined)
    throw invalid(
      "Change an Objective imperatively with supertag update objective; apply takes manifests",
      [{ path: `documents[${objective.request}]`, description: "an Objective" }],
    );
  const results: DocumentResult[] = [];
  for (const document of documents) {
    let planned: PlannedResource;
    try {
      planned = await planResource(context, document.path, document.resource, options);
      await writeResource(context, document.path, document.resource, options, principal);
    } catch (error) {
      if (error instanceof TagMessagingError || isInternalFailure(error)) throw error;
      throw new TagMessagingError(400, messageOf(error));
    }
    results.push({
      document: document.request,
      kind: document.resource.kind,
      name: document.name,
      outcome: "applied",
      action: planned.plan.action,
      warnings: [],
    });
  }
  return { results, complete: true, pruned: [] };
}

function managedOptions(options: ManifestApplyOptions): ManagedWriteOptions {
  if (options.prune && (options.applySet === undefined || options.applySet === ""))
    throw invalid("prune requires apply_set; pruning removes only members of that set", [
      { path: "prune", description: "requires apply_set" },
    ]);
  let applySet: string | undefined;
  try {
    applySet =
      options.applySet === undefined || options.applySet === ""
        ? undefined
        : parseApplySetName(options.applySet);
  } catch (error) {
    throw invalid(messageOf(error), [{ path: "apply_set", description: messageOf(error) }]);
  }
  const imperative = options.imperative === true;
  if (imperative && (applySet !== undefined || options.prune))
    throw invalid("imperative cannot be combined with apply_set or prune", [
      { path: "imperative", description: "without apply_set or prune" },
    ]);
  return {
    dryRun: false,
    force: options.force,
    imperative,
    manager: applySet ?? (imperative ? CLI_MANAGER : APPLY_MANAGER),
    ...(applySet === undefined ? {} : { applySet }),
  };
}

/** The request's documents, checked for shape, kind and duplicates. */
function requestDocuments(
  inputs: readonly ManifestInput[],
  command: "apply" | "diff",
): readonly RequestDocument[] {
  if (inputs.length === 0)
    throw invalid("documents is required", [
      { path: "documents", description: "at least one manifest" },
    ]);
  const entries = inputs.map((input, index) => ({
    source: input.source === "" ? `documents[${index}]` : input.source,
    value: input.manifest,
  }));
  const { documents, errors, errorEntries } = manifestDocuments(entries);
  if (errors.length > 0)
    throw invalid(
      `${command === "apply" ? "Nothing was applied. " : ""}Invalid manifests:\n  ${errors.join("\n  ")}`,
      errors.map((error, index) => ({
        path: `documents[${errorEntries[index] ?? 0}]`,
        description: error,
      })),
    );
  return documents.map((document) => {
    const input = inputs[document.entry];
    return {
      ...document,
      request: document.entry,
      ...(input?.secrets === undefined ? {} : { secrets: input.secrets }),
    };
  });
}

function keepOf(documents: readonly RequestDocument[]) {
  return documents.map((document) => ({ kind: document.resource.kind, name: document.name }));
}

function invalid(
  message: string,
  fields: readonly { readonly path: string; readonly description: string }[],
): ManifestInputError {
  return new ManifestInputError(message, "invalid", fields);
}

function documentPlan(document: RequestDocument, planned: PlannedResource): DocumentPlan {
  return {
    document: document.request,
    kind: document.resource.kind,
    name: document.name,
    plan: planned.plan,
  };
}

/**
 * Checks every document before anything changes: each one is validated and planned without
 * writing, and each reference must be defined in the input or already exist. Apply also verifies
 * changed Surface Account secrets here, so a rejected credential leaves everything unchanged.
 */
async function validate(
  context: ManifestApplyContext,
  documents: readonly RequestDocument[],
  command: "apply" | "diff",
  options: ManagedWriteOptions,
): Promise<{
  readonly plans: ReadonlyMap<RequestDocument, PlannedResource>;
  readonly surfaces: ReadonlyMap<RequestDocument, SurfacePreparation>;
}> {
  const errors: { readonly line: string; readonly document: RequestDocument }[] = [];
  const fail = (document: RequestDocument, error: unknown) => {
    if (isInternalFailure(error)) throw error;
    errors.push({ line: `${document.source}: ${label(document)}: ${messageOf(error)}`, document });
  };
  const planned = new Map<RequestDocument, PlannedResource>();
  const surfaces = new Map<RequestDocument, SurfacePreparation>();
  // Surface Accounts first: Tag locations in the same input may name them.
  await Promise.all(
    documents
      .filter((document) => document.path === "surface-accounts")
      .map(async (document) => {
        try {
          const prepared = await prepareSurfaceAccount(context, document, command, options);
          planned.set(document, prepared.plan);
          surfaces.set(document, prepared.surface);
        } catch (error) {
          fail(document, error);
        }
      }),
  );
  const identities = new Map<string, RequestDocument>();
  for (const [document, surface] of surfaces) {
    if (surface.externalAccountId === undefined) continue;
    const identity = `${surface.manifest.provider}:${surface.externalAccountId}`;
    const prior = identities.get(identity);
    if (prior === undefined) identities.set(identity, document);
    else
      errors.push({
        line: `${document.source}: ${label(document)} names the same ${surface.manifest.provider} account as ${label(prior)} (${surface.externalAccountId}); declare each account once`,
        document,
      });
  }
  const pending = await pendingTagLocations(context, documents, surfaces);
  await Promise.all(
    documents
      .filter((document) => document.path !== "surface-accounts")
      .map(async (document) => {
        try {
          const indices = pending.get(document);
          planned.set(
            document,
            indices === undefined
              ? await planResource(context, document.path, document.resource, options)
              : withPendingLocations(
                  await planResource(
                    context,
                    document.path,
                    withoutLocations(document.resource, indices),
                    options,
                  ),
                  document.resource,
                  indices,
                ),
          );
        } catch (error) {
          fail(document, error);
        }
      }),
  );
  const defined = new Set(documents.map((document) => `${document.path}/${document.name}`));
  const existing = new Map<string, Promise<boolean>>();
  const exists = (path: ReferencePath, name: string) => {
    const key = `${path}/${name}`;
    if (!existing.has(key))
      existing.set(
        key,
        getOptional(context, path, name).then(
          (resource) =>
            resource !== undefined &&
            (resource.kind !== "Role" || resource.status.phase === "active"),
        ),
      );
    return existing.get(key) as Promise<boolean>;
  };
  for (const document of documents) {
    if (!planned.has(document)) continue;
    for (const [path, name] of manifestReferences(document.path, document.resource.spec)) {
      if (defined.has(`${path}/${name}`) || (await exists(path, name))) continue;
      errors.push({
        line: `${document.source}: ${label(document)} references ${REFERENCE_KINDS[path]} ${name}, which is neither in this input nor on the Control Plane`,
        document,
      });
    }
  }
  if (errors.length > 0) {
    const sorted = errors.toSorted((left, right) =>
      left.line < right.line ? -1 : left.line > right.line ? 1 : 0,
    );
    throw invalid(
      `${command === "apply" ? "Nothing was applied. " : ""}Invalid manifests:\n  ${sorted.map((error) => error.line).join("\n  ")}`,
      sorted.map((error) => ({
        path: `documents[${error.document.request}]`,
        description: error.line,
      })),
    );
  }
  return { plans: planned, surfaces };
}

/** Refuses the whole input when a document changes what cannot change or another manager owns. */
function refuseConflicts(
  documents: readonly RequestDocument[],
  plans: ReadonlyMap<RequestDocument, PlannedResource>,
): void {
  const ordered = orderForApply(documents);
  const refusals = ordered.flatMap((document) =>
    (plans.get(document)?.plan.refusals ?? []).map((refusal) => ({ document, ...refusal })),
  );
  if (refusals.length > 0)
    throw new ManifestInputError(
      `Nothing was applied. The input changes what cannot change:\n  ${refusals
        .map((refusal) => `${label(refusal.document)}: ${refusal.path}: ${refusal.reason}`)
        .join("\n  ")}`,
      "conflict",
      refusals.map((refusal) => ({
        path: `documents[${refusal.document.request}].${refusal.path}`,
        description: refusal.reason,
      })),
    );
  const conflicts = ordered.flatMap((document) =>
    (plans.get(document)?.plan.conflicts ?? []).map((conflict) => ({ document, ...conflict })),
  );
  if (conflicts.length > 0)
    throw new ManifestInputError(
      `Nothing was applied. The input changes fields another manager owns:\n  ${conflicts
        .map(
          (conflict) =>
            `${label(conflict.document)}: ${conflict.path} is owned by ${conflict.manager}`,
        )
        .join("\n  ")}`,
      "conflict",
      conflicts.map((conflict) => ({
        path: `documents[${conflict.document.request}].${conflict.path}`,
        description: `owned by ${conflict.manager}`,
        manager: conflict.manager,
      })),
    );
}

/**
 * Plans one Surface Account. `diff` never reads secrets, so it compares only the declared fields
 * and references. `apply` asks whether the resolved secrets match the stored credential; when the
 * account is new or anything changed, it verifies them with the provider, as setup does, before
 * any resource in the input is written.
 */
async function prepareSurfaceAccount(
  context: ManifestApplyContext,
  document: RequestDocument,
  command: "apply" | "diff",
  options: ManagedWriteOptions,
): Promise<{ readonly plan: PlannedResource; readonly surface: SurfacePreparation }> {
  const manifest = parseSurfaceAccountManifest(document.resource);
  const credentials = command === "apply" ? resolvedSecrets(manifest, document) : undefined;
  const planned = await planResource(
    context,
    document.path,
    document.resource,
    options,
    credentials === undefined ? {} : { credentials },
  );
  const current = planned.current;
  const surface: SurfacePreparation = {
    manifest,
    pending: planned.plan.action === "create",
    ...(current === undefined ? {} : { externalAccountId: current.externalAccountId }),
  };
  const blocked = (planned.plan.refusals ?? []).length > 0 || planned.plan.conflicts.length > 0;
  const unchanged = planned.plan.action === "unchanged" && planned.plan.secrets === "unchanged";
  if (credentials === undefined || blocked || unchanged) return { plan: planned, surface };
  let verified: VerifiedSurfaceAccount;
  try {
    verified = await context.verifySurface(manifest, credentials);
  } catch (error) {
    throw new Error(`provider verification failed: ${messageOf(error)}`);
  }
  if (current !== undefined && current.externalAccountId !== verified.externalAccountId)
    throw new Error(
      `${document.name} is ${current.provider} account ${current.externalAccountId}, but its credentials belong to ${verified.externalAccountId}. Delete it, then apply the other account under a new name`,
    );
  if (current === undefined) {
    const holder = await getOptional(
      context,
      "surface-accounts",
      `${verified.provider}:${verified.externalAccountId}`,
    );
    if (holder !== undefined && declaredByManifest(holder))
      throw new Error(
        `${verified.provider} account ${verified.externalAccountId} is already declared as SurfaceAccount ${String(holder.metadata.name)}`,
      );
  }
  return {
    plan: planned,
    surface: { ...surface, verified, externalAccountId: verified.externalAccountId },
  };
}

/** The resolved values of every secret a Surface Account manifest references. */
function resolvedSecrets(
  manifest: SurfaceAccountManifest,
  document: RequestDocument,
): Readonly<Record<string, string>> {
  const secrets = document.secrets ?? {};
  const missing = Object.keys(manifest.secrets).filter((name) => secrets[name] === undefined);
  if (missing.length > 0)
    throw new Error(`secrets requires the resolved value of ${missing.toSorted().join(", ")}`);
  const extra = Object.keys(secrets).filter((name) => !(name in manifest.secrets));
  if (extra.length > 0)
    throw new Error(`secrets names ${extra.toSorted().join(", ")}, which the manifest does not`);
  return secrets;
}

/** A Surface Account a manifest applied records where its secrets came from. */
function declaredByManifest(resource: ResourceView): boolean {
  return resource.kind === "SurfaceAccount" && resource.spec.secrets !== undefined;
}

/**
 * Tag locations that name a Surface Account this input creates. They cannot be resolved until
 * that account exists, so they are planned as additions and applied after it. A location is
 * pending when its account matches the new account's name or verified provider ID, or, with no
 * account given, when the new account is the provider's only one.
 */
async function pendingTagLocations(
  context: ManifestApplyContext,
  documents: readonly RequestDocument[],
  surfaces: ReadonlyMap<RequestDocument, SurfacePreparation>,
): Promise<ReadonlyMap<RequestDocument, readonly number[]>> {
  const created = [...surfaces.values()].filter((surface) => surface.pending);
  const tags = documents.filter((document) => document.path === "tags");
  if (created.length === 0 || tags.length === 0) return new Map();
  const accounts = await listResourceViews(context, "surface-accounts");
  const pending = new Map<RequestDocument, number[]>();
  for (const document of tags) {
    const spec = isRecord(document.resource.spec) ? document.resource.spec : {};
    const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
    locations.forEach((location: unknown, index: number) => {
      if (!isRecord(location)) return;
      const provider = location["provider"];
      const account = location["account"];
      const candidates = created.filter((surface) => surface.manifest.provider === provider);
      if (candidates.length === 0) return;
      const existing = accounts.filter(
        (item) => item.kind === "SurfaceAccount" && item.spec.provider === provider,
      );
      const matches =
        typeof account === "string"
          ? !existing.some(
              (item) =>
                item.metadata.name === account ||
                item.metadata.id === account ||
                (item.kind === "SurfaceAccount" && item.spec.externalAccountId === account),
            ) &&
            candidates.some(
              (surface) =>
                surface.manifest.name === account || surface.externalAccountId === account,
            )
          : account === undefined && existing.length === 0 && candidates.length === 1;
      if (matches) pending.set(document, [...(pending.get(document) ?? []), index]);
    });
  }
  return pending;
}

function withoutLocations(
  resource: ManifestDocument["resource"],
  indices: readonly number[],
): ManifestDocument["resource"] {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
  return {
    ...resource,
    spec: { ...spec, locations: locations.filter((_, index) => !indices.includes(index)) },
  };
}

/** Adds the locations that could not be planned yet, as additions. */
function withPendingLocations(
  planned: PlannedResource,
  resource: ManifestDocument["resource"],
  indices: readonly number[],
): PlannedResource {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const locations = Array.isArray(spec["locations"]) ? spec["locations"] : [];
  const additions = indices
    .map((index) => locations[index])
    .filter(isRecord)
    .map((location) => ({
      path: `spec.locations[${locationKey(location)}]`,
      action: "add" as const,
      after: location,
    }));
  return {
    ...planned,
    plan: {
      ...planned.plan,
      action: planned.plan.action === "unchanged" ? "update" : planned.plan.action,
      changes: [...planned.plan.changes, ...additions],
    },
  };
}

function manifestReferences(path: string, spec: unknown): readonly [ReferencePath, string][] {
  if (!isRecord(spec)) return [];
  const names = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (path === "roles")
    return [
      ...names(spec["contextSets"]).map(
        (name) => ["context-sets", name] as [ReferencePath, string],
      ),
      ...names(spec["permissionSets"]).map(
        (name) => ["permission-sets", name] as [ReferencePath, string],
      ),
    ];
  if (path === "objectives") {
    const references: [ReferencePath, string][] = [];
    if (typeof spec["owner"] === "string") references.push(["tags", spec["owner"]]);
    for (const name of names(spec["workspaces"])) references.push(["workspaces", name]);
    if (isRecord(spec["team"]))
      for (const name of names(spec["team"]["members"])) references.push(["tags", name]);
    return references;
  }
  if (path !== "tags") return [];
  const references: [ReferencePath, string][] = names(spec["roles"]).map((name) => ["roles", name]);
  for (const location of Array.isArray(spec["locations"]) ? spec["locations"] : [])
    if (isRecord(location)) {
      for (const name of names(location["permissionSets"]))
        references.push(["permission-sets", name]);
      for (const name of names(location["contextSets"])) references.push(["context-sets", name]);
      for (const name of names(location["workspaces"])) references.push(["workspaces", name]);
    }
  for (const name of names(spec["acceptsMessagesFrom"])) references.push(["tags", name]);
  return references;
}

/**
 * Applies in dependency order. A Tag that accepts messages from a Tag later in the input needs
 * that sender to exist, so the sender is first created empty. Not transactional: when one
 * document fails, those before it stay applied and the rest are not applied.
 */
async function applyDocuments(
  context: ManifestApplyContext,
  documents: readonly RequestDocument[],
  options: ManagedWriteOptions,
  principal: CoordinationOperatorPrincipal,
  plans: ReadonlyMap<RequestDocument, PlannedResource>,
  surfaces: ReadonlyMap<RequestDocument, SurfacePreparation>,
): Promise<readonly DocumentResult[]> {
  const ordered = orderForApply(documents);
  const tagsInInput = new Map(
    ordered
      .filter((document) => document.path === "tags")
      .map((document) => [document.name, document]),
  );
  const created = new Set<string>();
  const applied = new Set<RequestDocument>();
  const results: DocumentResult[] = [];
  for (const document of ordered) {
    const base = {
      document: document.request,
      kind: document.resource.kind,
      name: document.name,
    };
    if (results.some((result) => result.outcome === "failed")) {
      results.push({ ...base, outcome: "not_applied", warnings: [] });
      continue;
    }
    try {
      if (document.path === "tags" && isRecord(document.resource.spec)) {
        const grants = document.resource.spec["acceptsMessagesFrom"];
        for (const grant of Array.isArray(grants) ? grants : []) {
          const sender = tagsInInput.get(String(grant));
          if (!sender || sender === document || applied.has(sender) || created.has(sender.name))
            continue;
          if ((await getOptional(context, "tags", sender.name)) !== undefined) continue;
          await writeResource(
            context,
            "tags",
            { ...sender.resource, spec: {} },
            options,
            principal,
          );
          created.add(sender.name);
        }
      }
      // A Surface Account carries the provider-verified account only when it must be stored.
      const verified = surfaces.get(document)?.verified;
      const written = await writeResource(
        context,
        document.path,
        document.resource,
        options,
        principal,
        verified === undefined ? {} : { verified },
      );
      applied.add(document);
      results.push({
        ...base,
        outcome: "applied",
        action: plans.get(document)?.plan.action ?? "unchanged",
        warnings: written.warnings ?? [],
        ...(written.started === undefined ? {} : { startedTaskId: written.started.taskId }),
        ...(written.notStarted === undefined ? {} : { notStarted: written.notStarted }),
        ...(verified === undefined
          ? {}
          : {
              verification: {
                provider: verified.provider,
                displayName: verified.displayName,
                externalAccountId: verified.externalAccountId,
              },
            }),
      });
    } catch (error) {
      results.push({
        ...base,
        outcome: "failed",
        warnings: [],
        failure: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return results;
}

async function getOptional(
  context: ResourceApplyContext,
  path: ResourcePath,
  name: string,
): Promise<ResourceView | undefined> {
  try {
    return await readResourceView(context, path, name);
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not exist")) return undefined;
    throw error;
  }
}

/** Errors JavaScript itself throws, which a refusal of the input never is. */
const PROGRAMMING_ERRORS: readonly (new () => Error)[] = [
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
];

/** The errors the database drivers and Drizzle throw for a failed query or connection. */
const DATABASE_ERRORS = new Set([
  "DrizzleQueryError",
  "DrizzleError",
  "DatabaseError",
  "SqliteError",
]);

/**
 * A failure of the Control Plane rather than of the input: a database query, a system call, or a
 * programming error. A refusal of the input is an `Error` that names the problem, which may wrap a
 * database error as its `cause`, as the store does for a name already taken.
 */
export function isInternalFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const prototype: unknown = Object.getPrototypeOf(error);
  if (PROGRAMMING_ERRORS.some((type) => prototype === type.prototype)) return true;
  if (DATABASE_ERRORS.has(error.constructor.name)) return true;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return typeof code === "string" && typeof syscall === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
