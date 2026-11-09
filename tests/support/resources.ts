import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ControlPlaneClient } from "../../apps/cli/src/control-plane-client.ts";
import { resourceList } from "../../apps/cli/src/control-plane-resources.ts";
import { resourceClient } from "../../apps/cli/src/operator-client.ts";
import {
  type ResourcePath,
  resourceKindOfPath,
  resourceView,
} from "../../apps/cli/src/resource-protos.ts";
import type {
  ApplyManifestsResponse,
  DeleteResourceResponse,
  DiffManifestsResponse,
} from "../../packages/operator-api/src/index.ts";

/**
 * `ResourceService` calls for tests, through the generated client: resources as the views the
 * CLI prints, and manifests applied or planned one input at a time.
 */

type Client = Pick<ControlPlaneClient, "operator">;

// biome-ignore lint/suspicious/noExplicitAny: tests read whichever fields they assert on.
type Loose = any;

/** One resource as `supertag get KIND NAME` prints it. */
export async function getResource<T = Loose>(
  client: Client,
  path: ResourcePath,
  name: string,
): Promise<T> {
  return resourceView(
    await resourceClient(client.operator).getResource({ kind: resourceKindOfPath(path), name }),
    true,
  ) as T;
}

/** Every resource of a kind, as `supertag get KIND` lists them. */
export async function listResources<T = Loose>(
  client: Client,
  path: ResourcePath,
): Promise<{ readonly kind: string; readonly items: T[] }> {
  const { resources } = await resourceClient(client.operator).listResources({
    kind: resourceKindOfPath(path),
    pageSize: 500,
  });
  const list = resourceList(resources.map((resource) => resourceView(resource)));
  return { ...list, items: list.items as T[] };
}

/** Whether a resource exists; any refusal but `NotFound` fails the test. */
export async function resourceExists(
  client: Client,
  path: ResourcePath,
  name: string,
): Promise<boolean> {
  try {
    await getResource(client, path, name);
    return true;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return false;
    throw error;
  }
}

export interface ManifestOptions {
  readonly applySet?: string;
  readonly prune?: boolean;
  readonly force?: boolean;
  readonly imperative?: boolean;
  readonly createOnly?: boolean;
  /** Resolved secret values for each SurfaceAccount document, by its index. */
  readonly secrets?: Readonly<Record<number, Readonly<Record<string, string>>>>;
}

function documents(manifests: readonly unknown[], secrets: ManifestOptions["secrets"] = {}) {
  return manifests.map((manifest, index) => ({
    manifest: JSON.parse(JSON.stringify(manifest)) as JsonObject,
    source: `manifest ${index + 1}`,
    secrets: { ...(secrets[index] ?? {}) },
  }));
}

/** Applies manifests as one input, as `supertag apply -f` does. */
export function applyManifests(
  client: Client,
  manifests: readonly unknown[],
  options: ManifestOptions = {},
): Promise<ApplyManifestsResponse> {
  return resourceClient(client.operator).applyManifests({
    documents: documents(manifests, options.secrets),
    applySet: options.applySet ?? "",
    prune: options.prune === true,
    forceConflicts: options.force === true,
    imperative: options.imperative === true,
    createOnly: options.createOnly === true,
  });
}

/** Plans manifests as one input, as `supertag diff -f` does. */
export function diffManifests(
  client: Client,
  manifests: readonly unknown[],
  options: Omit<ManifestOptions, "imperative" | "createOnly" | "secrets"> = {},
): Promise<DiffManifestsResponse> {
  return resourceClient(client.operator).diffManifests({
    documents: documents(manifests),
    applySet: options.applySet ?? "",
    prune: options.prune === true,
    forceConflicts: options.force === true,
  });
}

/** Deletes or retires one resource, as `supertag delete KIND NAME` does. */
export function deleteResource(
  client: Client,
  path: ResourcePath,
  name: string,
  dryRun = false,
): Promise<DeleteResourceResponse> {
  return resourceClient(client.operator).deleteResource({
    kind: resourceKindOfPath(path),
    name,
    dryRun,
  });
}
