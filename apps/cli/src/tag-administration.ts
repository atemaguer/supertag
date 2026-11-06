import {
  ARTIFACT_CONTEXT_TYPE,
  type GatewayCredentialVault,
  SKILL_CONTEXT_TYPE,
  type Store,
  type SurfaceProvider,
} from "@supertag/core";
import { type SurfaceTarget, SurfaceTargetResolver } from "./tag-surface-target.js";

type TagAdministrationStore = Pick<
  Store,
  | "addTagRoute"
  | "removeTagRoute"
  | "resolveTagRoute"
  | "addTagContextItem"
  | "removeTagContextItem"
  | "activateTagContextSet"
  | "deactivateTagContextSet"
  | "activateTagPermissionSet"
  | "deactivateTagPermissionSet"
  | "addTagPermission"
  | "removeTagPermission"
  | "createTag"
  | "findTagByName"
  | "listTags"
  | "listSurfaceAccounts"
  | "listTagRoutes"
  | "listTagPermissionSets"
  | "listTagPermissions"
  | "listTagContextItems"
  | "listTagContextSets"
  | "listTagPermissionActivations"
  | "listTagContextActivations"
  | "findTagContextSetByName"
  | "findTagPermissionSetByName"
  | "createTagContextSet"
  | "createTagPermissionSet"
  | "removeTagContextSet"
  | "removeTagPermissionSet"
>;

/** Typed administration operations on an already connected persistence boundary. */
export class TagAdministration {
  private readonly targets: SurfaceTargetResolver;

  constructor(
    private readonly store: TagAdministrationStore,
    credentialVault: GatewayCredentialVault,
  ) {
    this.targets = new SurfaceTargetResolver(store, credentialVault);
  }

  create(name: string) {
    return this.store.createTag({ name });
  }

  async requireTag(name: string) {
    const tag = await this.store.findTagByName(name);
    if (!tag) throw new TagNotFoundError(name);
    return tag;
  }

  async show(name: string) {
    const [tag, accounts] = await Promise.all([
      this.store.findTagByName(name),
      this.store.listSurfaceAccounts(),
    ]);
    if (tag === undefined) {
      throw new Error(`Tag ${JSON.stringify(name)} does not exist`);
    }
    const [
      locations,
      allPermissionSets,
      allPermissions,
      allContextSets,
      permissionActivations,
      contextActivations,
    ] = await Promise.all([
      this.store.listTagRoutes({ tagId: tag.id }),
      this.store.listTagPermissionSets(),
      this.store.listTagPermissions(),
      this.store.listTagContextSets(),
      this.store.listTagPermissionActivations(),
      this.store.listTagContextActivations(),
    ]);
    const routeIds = new Set(locations.map((route) => route.id));
    const permissionSetIds = new Set(
      permissionActivations
        .filter((activation) => routeIds.has(activation.tagRouteId))
        .map((activation) => activation.permissionSetId),
    );
    const contextSetIds = new Set(
      contextActivations
        .filter((activation) => routeIds.has(activation.tagRouteId))
        .map((activation) => activation.contextSetId),
    );
    const permissionSets = allPermissionSets.filter((set) => permissionSetIds.has(set.id));
    const permissions = allPermissions.filter((permission) =>
      permissionSetIds.has(permission.permissionSetId),
    );
    const contextSets = allContextSets.filter((set) => contextSetIds.has(set.id));
    return { tag, accounts, locations, permissionSets, permissions, contextSets };
  }

  async list() {
    const [tags, locations, permissionActivations, contextActivations] = await Promise.all([
      this.store.listTags(),
      this.store.listTagRoutes(),
      this.store.listTagPermissionActivations(),
      this.store.listTagContextActivations(),
    ]);
    return tags.map((tag) => {
      const routeIds = new Set(
        locations.filter((route) => route.tagId === tag.id).map((route) => route.id),
      );
      return {
        tag,
        locationCount: locations.filter((route) => route.tagId === tag.id).length,
        permissionSetCount: new Set(
          permissionActivations
            .filter((activation) => routeIds.has(activation.tagRouteId))
            .map((activation) => activation.permissionSetId),
        ).size,
        contextSetCount: new Set(
          contextActivations
            .filter((activation) => routeIds.has(activation.tagRouteId))
            .map((activation) => activation.contextSetId),
        ).size,
      };
    });
  }

  async requireContextSet(tagName: string, setName: string) {
    const tag = await this.requireTag(tagName);
    const contextSet = await this.store.findTagContextSetByName(setName);
    if (!contextSet)
      throw new Error(`Context Set ${JSON.stringify(setName)} does not exist for ${tag.name}`);
    return { tag, contextSet };
  }

  async requirePermissionSet(tagName: string, setName: string) {
    const tag = await this.requireTag(tagName);
    const permissionSet = await this.store.findTagPermissionSetByName(setName);
    if (!permissionSet)
      throw new Error(`Permission Set ${JSON.stringify(setName)} does not exist for ${tag.name}`);
    return { tag, permissionSet };
  }

  async createContextSet(tagName: string, setName: string) {
    const tag = await this.requireTag(tagName);
    const contextSet = await this.store.createTagContextSet({ name: setName });
    return { tag, contextSet };
  }

  async createPermissionSet(tagName: string, setName: string) {
    const tag = await this.requireTag(tagName);
    const permissionSet = await this.store.createTagPermissionSet({ name: setName });
    return { tag, permissionSet };
  }

  async deleteContextSet(tagName: string, setName: string) {
    const { contextSet } = await this.requireContextSet(tagName, setName);
    await this.store.removeTagContextSet(contextSet.id);
    return contextSet;
  }

  async deletePermissionSet(tagName: string, setName: string) {
    const { permissionSet } = await this.requirePermissionSet(tagName, setName);
    await this.store.removeTagPermissionSet(permissionSet.id);
    return permissionSet;
  }

  async listContextSets(tagName: string) {
    const tag = await this.requireTag(tagName);
    const [allSets, sources, activations, routes] = await Promise.all([
      this.store.listTagContextSets(),
      this.store.listTagContextItems(),
      this.store.listTagContextActivations(),
      this.store.listTagRoutes({ tagId: tag.id }),
    ]);
    const routeIds = new Set(routes.map((route) => route.id));
    const activeSetIds = new Set(
      activations
        .filter((activation) => routeIds.has(activation.tagRouteId))
        .map((activation) => activation.contextSetId),
    );
    const sets = allSets.filter((set) => activeSetIds.has(set.id));
    return { tag, sets, sources, activations };
  }

  async listPermissionSets(tagName: string) {
    const tag = await this.requireTag(tagName);
    const [allSets, permissions, activations, routes] = await Promise.all([
      this.store.listTagPermissionSets(),
      this.store.listTagPermissions(),
      this.store.listTagPermissionActivations(),
      this.store.listTagRoutes({ tagId: tag.id }),
    ]);
    const routeIds = new Set(routes.map((route) => route.id));
    const activeSetIds = new Set(
      activations
        .filter((activation) => routeIds.has(activation.tagRouteId))
        .map((activation) => activation.permissionSetId),
    );
    const sets = allSets.filter((set) => activeSetIds.has(set.id));
    return { tag, sets, permissions, activations };
  }

  async showContextSet(tagName: string, setName: string) {
    const { tag, contextSet } = await this.requireContextSet(tagName, setName);
    const [sources, activations, accounts, locations] = await Promise.all([
      this.store.listTagContextItems({ contextSetId: contextSet.id }),
      this.store.listTagContextActivations({ contextSetId: contextSet.id }),
      this.store.listSurfaceAccounts(),
      this.store.listTagRoutes({ tagId: tag.id }),
    ]);
    return { tag, contextSet, sources, activations, accounts, locations };
  }

  async showPermissionSet(tagName: string, setName: string) {
    const { tag, permissionSet } = await this.requirePermissionSet(tagName, setName);
    const [permissions, activations, accounts, locations] = await Promise.all([
      this.store.listTagPermissions({ permissionSetId: permissionSet.id }),
      this.store.listTagPermissionActivations({ permissionSetId: permissionSet.id }),
      this.store.listSurfaceAccounts(),
      this.store.listTagRoutes({ tagId: tag.id }),
    ]);
    return { tag, permissionSet, permissions, activations, accounts, locations };
  }

  async addRoute(tagName: string, target: SurfaceTarget) {
    const [tag, accounts] = await Promise.all([
      this.store.findTagByName(tagName),
      this.store.listSurfaceAccounts(),
    ]);
    if (!tag) throw new TagNotFoundError(tagName);
    const resolved = await this.targets.resolve(target, accounts);
    const route = await this.store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: resolved.account.id,
      scope: resolved.scope,
    });
    return { tag, resolved, route };
  }

  async removeRoute(tagName: string, target: SurfaceTarget) {
    const [tag, accounts] = await Promise.all([
      this.store.findTagByName(tagName),
      this.store.listSurfaceAccounts(),
    ]);
    if (!tag) throw new TagNotFoundError(tagName);
    const resolved = await this.targets.resolve(target, accounts);
    const route = (
      await this.store.listTagRoutes({ tagId: tag.id, surfaceAccountId: resolved.account.id })
    ).find((item) => item.scope === resolved.scope);
    if (!route)
      throw new Error(
        `${tag.name} is not configured on ${target.provider} ${resolved.displayName} for ${resolved.account.displayName}`,
      );
    if (!(await this.store.removeTagRoute(route.id)))
      throw new Error(`Tag location ${resolved.displayName} no longer exists`);
    return { tag, resolved };
  }

  async addContextItem(
    tagName: string,
    setName: string,
    definition: Omit<Parameters<Store["addTagContextItem"]>[0], "contextSetId">,
  ) {
    const { contextSet } = await this.requireContextSet(tagName, setName);
    const item = await this.store.addTagContextItem({ ...definition, contextSetId: contextSet.id });
    return { contextSet, item };
  }

  addSkill(
    tagName: string,
    setName: string,
    reference: string,
    configuration: { readonly version?: string; readonly digest?: string },
  ) {
    return this.addContextItem(tagName, setName, {
      itemKey: `skill:${reference}`,
      type: SKILL_CONTEXT_TYPE,
      version: 1,
      required: true,
      config: { reference, ...configuration },
    });
  }

  async addArtifacts(
    tagName: string,
    setName: string,
    target: SurfaceTarget,
    selection: { readonly maxAgeDays: number; readonly limit: number },
  ) {
    const { tag, contextSet } = await this.requireContextSet(tagName, setName);
    const resolved = await this.targets.resolve(target);
    const sourceRoute = await this.store.resolveTagRoute(resolved.account.id, resolved.scope);
    if (!sourceRoute || sourceRoute.tagId !== tag.id)
      throw new Error(
        `${tag.name} is not available in source ${target.provider} ${resolved.displayName}`,
      );
    const source = await this.store.addTagContextItem({
      contextSetId: contextSet.id,
      itemKey: `artifacts:${sourceRoute.id}:shared-resource`,
      type: ARTIFACT_CONTEXT_TYPE,
      version: 1,
      required: true,
      config: {
        sourceRouteId: sourceRoute.id,
        selection: {
          match: "shared-resource",
          maxAgeDays: selection.maxAgeDays,
          limit: selection.limit,
        },
      },
    });
    return { contextSet, source, resolved };
  }

  async removeContextItem(tagName: string, setName: string, sourceId: string) {
    const { contextSet } = await this.requireContextSet(tagName, setName);
    const source = (await this.store.listTagContextItems({ contextSetId: contextSet.id })).find(
      (item) => item.id === sourceId,
    );
    if (!source || !(await this.store.removeTagContextItem(source.id)))
      throw new Error(
        `Context entry ${JSON.stringify(sourceId)} does not exist in ${contextSet.name}`,
      );
    return { contextSet, source };
  }

  async setContextActivation(
    tagName: string,
    setName: string,
    target: SurfaceTarget,
    active: boolean,
  ) {
    const { tag, contextSet } = await this.requireContextSet(tagName, setName);
    const resolved = await this.targets.resolve(target);
    const route = await this.requireRoute(tag, target, resolved);
    if (active)
      await this.store.activateTagContextSet({
        contextSetId: contextSet.id,
        tagRouteId: route.id,
      });
    else await this.store.deactivateTagContextSet(contextSet.id, route.id);
    return { contextSet, resolved };
  }

  async setPermissionActivation(
    tagName: string,
    setName: string,
    target: SurfaceTarget,
    active: boolean,
  ) {
    const { tag, permissionSet } = await this.requirePermissionSet(tagName, setName);
    const resolved = await this.targets.resolve(target);
    const route = await this.requireRoute(tag, target, resolved);
    if (active)
      await this.store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: route.id,
      });
    else await this.store.deactivateTagPermissionSet(permissionSet.id, route.id);
    return { permissionSet, resolved };
  }

  private async requireRoute(
    tag: { id: string; name: string },
    target: SurfaceTarget,
    resolved: Awaited<ReturnType<SurfaceTargetResolver["resolve"]>>,
  ) {
    const route = (
      await this.store.listTagRoutes({ tagId: tag.id, surfaceAccountId: resolved.account.id })
    ).find((item) => item.scope === resolved.scope);
    if (!route)
      throw new Error(`${tag.name} is not available in ${target.provider} ${resolved.displayName}`);
    return route;
  }

  async changeRuntimePermissions(
    tagName: string,
    setName: string,
    actions: readonly string[],
    allow: boolean,
  ) {
    const { permissionSet } = await this.requirePermissionSet(tagName, setName);
    validateRuntimeActions(actions);
    if (allow) {
      for (const action of actions)
        await this.store.addTagPermission({
          permissionSetId: permissionSet.id,
          target: "runtime",
          action,
        });
    } else {
      const permissions = await this.store.listTagPermissions({
        permissionSetId: permissionSet.id,
        target: "runtime",
      });
      await Promise.all(
        permissions
          .filter((permission) => actions.includes(permission.action))
          .map((permission) => this.store.removeTagPermission(permission.id)),
      );
    }
    return permissionSet;
  }

  async changeSurfacePermissions(
    tagName: string,
    setName: string,
    target: SurfaceTarget,
    actions: readonly string[],
    allow: boolean,
  ) {
    const { permissionSet } = await this.requirePermissionSet(tagName, setName);
    const resolved = await this.targets.resolve(target);
    validateSurfaceActions(target.provider, actions);
    if (allow) {
      for (const action of actions)
        await this.store.addTagPermission({
          permissionSetId: permissionSet.id,
          target: "surface",
          surfaceAccountId: resolved.account.id,
          scope: resolved.scope,
          ...(resolved.reference === undefined ? {} : { reference: resolved.reference }),
          action,
        });
    } else {
      const permissions = await this.store.listTagPermissions({
        permissionSetId: permissionSet.id,
        surfaceAccountId: resolved.account.id,
        scope: resolved.scope,
      });
      await Promise.all(
        permissions
          .filter((permission) => actions.includes(permission.action))
          .map((permission) => this.store.removeTagPermission(permission.id)),
      );
    }
    return permissionSet;
  }
}

export class TagNotFoundError extends Error {
  constructor(readonly tagName: string) {
    super(`Tag ${JSON.stringify(tagName)} does not exist`);
    this.name = "TagNotFoundError";
  }
}

const SUPPORTED_ACTIONS: Readonly<Record<SurfaceProvider, readonly string[]>> = {
  cli: [],
  slack: [],
  lark: ["messages:read", "messages:send", "messages:reply"],
  github: ["contents:read", "pull-requests:create"],
  linear: ["issues:read", "issues:create", "comments:create"],
  teams: ["messages:read", "messages:send", "messages:reply"],
};

export function validateSurfaceActions(
  provider: SurfaceProvider,
  actions: readonly string[],
): void {
  if (actions.length === 0) throw new Error("At least one permission action is required");
  const supported = SUPPORTED_ACTIONS[provider];
  const unsupported = actions.filter((action) => !supported.includes(action));
  if (unsupported.length > 0)
    throw new Error(
      `Unsupported ${provider} action${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}. ${provider === "github" || provider === "slack" ? "Grant tools with target: mcp instead." : `Supported actions: ${supported.join(", ")}`}`,
    );
}

export function validateRuntimeActions(actions: readonly string[]): void {
  if (actions.length === 0) throw new Error("At least one permission action is required");
  const invalid = actions.filter((action) => !/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(action));
  if (invalid.length > 0)
    throw new Error(
      `Runtime actions must use a portable namespace:action name: ${invalid.join(", ")}`,
    );
}
