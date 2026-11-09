import { Code, ConnectError } from "@connectrpc/connect";
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
  surfaceClient,
} from "./operator-client.js";
import { refusedAsError } from "./tag-conversation.js";

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
