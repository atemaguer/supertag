import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ManifestOutcome } from "@supertag/operator-api";
import {
  type AuthKeyResource,
  type ControlPlaneResourceList,
  type OperatorTokenResource,
  resourceList,
  type SurfaceAccountResource,
  type WorkerHostResource,
} from "./control-plane-resources.js";
import {
  authKeyView,
  operatorTokenView,
  surfaceAccountView,
  workerHostView,
} from "./host-protos.js";
import {
  accessClient,
  hostClient,
  type OperatorClientOptions,
  operatorErrorMessage,
  refusedAsError,
  resourceClient,
  surfaceClient,
} from "./operator-client.js";
import {
  type ResourcePath,
  type ResourceView,
  resourceKindOfPath,
  resourceView,
} from "./resource-protos.js";

/**
 * Worker Hosts, Auth Keys, Operator Tokens and Surface Accounts, read through their operator RPCs
 * as the resources and resource lists `get`, `list` and `describe` print.
 */

export type OperatorResource =
  | WorkerHostResource
  | AuthKeyResource
  | OperatorTokenResource
  | SurfaceAccountResource;

/** The resource paths whose reads are operator RPCs. */
export type OperatorResourcePath =
  | "worker-hosts"
  | "auth-keys"
  | "operator-tokens"
  | "surface-accounts";

export function isOperatorResourcePath(path: string): path is OperatorResourcePath {
  return (
    path === "worker-hosts" ||
    path === "auth-keys" ||
    path === "operator-tokens" ||
    path === "surface-accounts"
  );
}

/** Every page of a list RPC. */
async function allPages<Item, Page extends { readonly nextPageToken: string }>(
  read: (pageToken: string) => Promise<Page>,
  items: (page: Page) => readonly Item[],
): Promise<Item[]> {
  const all: Item[] = [];
  let pageToken = "";
  do {
    const page = await read(pageToken);
    all.push(...items(page));
    pageToken = page.nextPageToken;
  } while (pageToken !== "");
  return all;
}

export function listWorkerHostResources(
  options: OperatorClientOptions,
): Promise<ControlPlaneResourceList<WorkerHostResource>> {
  const hosts = hostClient(options);
  return refusedAsError(async () =>
    resourceList(
      (
        await allPages(
          (pageToken) => hosts.listWorkerHosts({ pageSize: 500, pageToken }),
          (page) => page.workerHosts,
        )
      ).map(workerHostView),
    ),
  );
}

export function getWorkerHostResource(
  options: OperatorClientOptions,
  id: string,
): Promise<WorkerHostResource> {
  return refusedAsError(async () =>
    workerHostView(await hostClient(options).getWorkerHost({ id })),
  );
}

export function listAuthKeyResources(
  options: OperatorClientOptions,
): Promise<ControlPlaneResourceList<AuthKeyResource>> {
  const hosts = hostClient(options);
  return refusedAsError(async () =>
    resourceList(
      (
        await allPages(
          (pageToken) => hosts.listAuthKeys({ pageSize: 500, pageToken }),
          (page) => page.authKeys,
        )
      ).map(authKeyView),
    ),
  );
}

export function getAuthKeyResource(
  options: OperatorClientOptions,
  name: string,
): Promise<AuthKeyResource> {
  return refusedAsError(async () => authKeyView(await hostClient(options).getAuthKey({ name })));
}

export function listOperatorTokenResources(
  options: OperatorClientOptions,
): Promise<ControlPlaneResourceList<OperatorTokenResource>> {
  const access = accessClient(options);
  return refusedAsError(async () =>
    resourceList(
      (
        await allPages(
          (pageToken) => access.listOperatorTokens({ pageSize: 500, pageToken }),
          (page) => page.operatorTokens,
        )
      ).map(operatorTokenView),
    ),
  );
}

export function getOperatorTokenResource(
  options: OperatorClientOptions,
  name: string,
): Promise<OperatorTokenResource> {
  return refusedAsError(async () =>
    operatorTokenView(await accessClient(options).getOperatorToken({ name })),
  );
}

export function listSurfaceAccountResources(
  options: OperatorClientOptions,
): Promise<ControlPlaneResourceList<SurfaceAccountResource>> {
  const surfaces = surfaceClient(options);
  return refusedAsError(async () =>
    resourceList(
      (
        await allPages(
          (pageToken) => surfaces.listSurfaceAccounts({ pageSize: 500, pageToken }),
          (page) => page.surfaceAccounts,
        )
      ).map(surfaceAccountView),
    ),
  );
}

export function getSurfaceAccountResource(
  options: OperatorClientOptions,
  name: string,
): Promise<SurfaceAccountResource> {
  return refusedAsError(async () =>
    surfaceAccountView(await surfaceClient(options).getSurfaceAccount({ name })),
  );
}

/** Lists the resources at an operator RPC path. */
export function listOperatorResources(
  options: OperatorClientOptions,
  path: OperatorResourcePath,
): Promise<ControlPlaneResourceList<OperatorResource>> {
  if (path === "worker-hosts") return listWorkerHostResources(options);
  if (path === "auth-keys") return listAuthKeyResources(options);
  if (path === "operator-tokens") return listOperatorTokenResources(options);
  return listSurfaceAccountResources(options);
}

/** Reads one resource at an operator RPC path by its name. */
export function getOperatorResource(
  options: OperatorClientOptions,
  path: OperatorResourcePath,
  name: string,
): Promise<OperatorResource> {
  if (path === "worker-hosts") return getWorkerHostResource(options, name);
  if (path === "auth-keys") return getAuthKeyResource(options, name);
  if (path === "operator-tokens") return getOperatorTokenResource(options, name);
  return getSurfaceAccountResource(options, name);
}

/** Every resource of a `ResourceService` kind, as the resource list `get KIND` prints. */
export function listResourceViews(
  options: OperatorClientOptions,
  path: ResourcePath,
): Promise<ControlPlaneResourceList<ResourceView>> {
  const resources = resourceClient(options);
  const kind = resourceKindOfPath(path);
  return refusedAsError(async () =>
    resourceList(
      (
        await allPages(
          (pageToken) => resources.listResources({ kind, pageSize: 500, pageToken }),
          (page) => page.resources,
        )
      ).map((resource) => resourceView(resource)),
    ),
  );
}

/** One resource of a `ResourceService` kind by name, as `get KIND NAME` prints it. */
export function getResourceView(
  options: OperatorClientOptions,
  path: ResourcePath,
  name: string,
): Promise<ResourceView> {
  return refusedAsError(async () =>
    resourceView(
      await resourceClient(options).getResource({ kind: resourceKindOfPath(path), name }),
      true,
    ),
  );
}

/** One resource by name, or undefined when it does not exist. */
export async function findResourceView(
  options: OperatorClientOptions,
  path: ResourcePath,
  name: string,
): Promise<ResourceView | undefined> {
  try {
    return resourceView(
      await resourceClient(options).getResource({ kind: resourceKindOfPath(path), name }),
      true,
    );
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    if (error instanceof ConnectError) throw new Error(operatorErrorMessage(error));
    throw error;
  }
}

/** Applies one manifest, as `init`, provisioning and `create tag` do, and fails unless it applied. */
export async function applyManifest(
  options: OperatorClientOptions,
  request: {
    readonly manifest: JsonObject;
    readonly source: string;
    readonly applySet?: string;
    readonly imperative?: boolean;
  },
): Promise<void> {
  const applied = await refusedAsError(() =>
    resourceClient(options).applyManifests({
      ...(request.applySet === undefined ? {} : { applySet: request.applySet }),
      imperative: request.imperative === true,
      documents: [{ manifest: request.manifest, source: request.source }],
    }),
  );
  if (applied.complete) return;
  const failed = applied.results.find((result) => result.outcome === ManifestOutcome.FAILED);
  throw new Error(failed?.failureMessage || `${request.source} was not applied`);
}

/**
 * Manifests a manifest can reproduce: one resource's by name, or every resource's of the kind.
 * Surface Accounts set up interactively have no manifest; a listing leaves them out.
 */
export function resourceManifests(
  options: OperatorClientOptions,
  path: ResourcePath,
  name?: string,
): Promise<readonly unknown[]> {
  const resources = resourceClient(options);
  const kind = resourceKindOfPath(path);
  return refusedAsError(async () =>
    name === undefined
      ? (
          await allPages(
            (pageToken) =>
              resources.listResources({ kind, pageSize: 500, pageToken, manifest: true }),
            (page) => page.resources,
          )
        ).map((resource) => resource.manifest ?? {})
      : [(await resources.getResource({ kind, name, manifest: true })).manifest ?? {}],
  );
}

/**
 * Enrolls a Worker Host under an ID and returns its first credential, or undefined when the ID is
 * already enrolled.
 */
export async function enrollWorkerHostCredential(
  options: OperatorClientOptions,
  id: string,
): Promise<{ readonly workerHostId: string; readonly token: string } | undefined> {
  try {
    const credential = await hostClient(options).enrollWorkerHost({ id });
    if (credential.workerHostId !== id || !credential.token)
      throw new Error("Control Plane returned an invalid Worker Host credential");
    return { workerHostId: credential.workerHostId, token: credential.token };
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.AlreadyExists) return undefined;
    if (error instanceof ConnectError) throw new Error(operatorErrorMessage(error));
    throw error;
  }
}
