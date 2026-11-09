import { dirname } from "node:path";
import { ControlPlaneClient, ensureLocalAdminToken } from "./control-plane-client.js";
import { CONTROL_PLANE_API_VERSION } from "./control-plane-resources.js";
import { environmentOperatorToken } from "./local-state.js";
import { applyManifest, findResourceView } from "./operator-resources.js";
import { git, remoteSource } from "./repository-name.js";
import { type ProvisionInput, provisionManifests } from "./resources.js";
import {
  type ControlPlaneService,
  defaultSupertagYamlPath,
  readSecret,
  type ServicesFile,
  serviceVariable,
} from "./supertag-yaml.js";

/**
 * What a control-plane service starts with, on every `supertag up`: the resources its `provision:`
 * list declares, and the Workspaces its host services name. Missing ones are created; existing
 * ones are never changed or deleted. Returns one line per created resource.
 */
export async function provisionControlPlane(
  file: ServicesFile,
  service: ControlPlaneService,
  url: string,
): Promise<readonly string[]> {
  const client = await provisioningClient(file, url);
  const lines: string[] = [];
  if (service.provision.length > 0) {
    const inputs: ProvisionInput[] = service.provision.map((entry) =>
      "path" in entry ? { path: entry.path } : { manifest: entry.manifest, source: entry.source },
    );
    const created = await provisionManifests(client, inputs, {
      resolveSecret: (name) => readSecret(file, name),
      baseDirectory: dirname(file.files[0] ?? defaultSupertagYamlPath()),
    });
    lines.push(...created.split("\n").filter(Boolean));
  }
  for (const host of file.services)
    if (
      host.type === "host" &&
      "service" in host.controlPlane &&
      host.controlPlane.service === service.name
    )
      for (const [name, checkout] of Object.entries(host.workspaces))
        if (await createWorkspace(client, name, checkout))
          lines.push(`Workspace/${name} created for host service ${host.name}`);
  return lines;
}

/**
 * An operator credential in the environment wins. Otherwise the admin token the Control Plane
 * itself reads, from the environment or env_file, before the local operator credential.
 */
async function provisioningClient(file: ServicesFile, url: string): Promise<ControlPlaneClient> {
  return new ControlPlaneClient({
    url,
    token:
      environmentOperatorToken() ||
      serviceVariable(file, "SUPERTAG_ADMIN_TOKEN") ||
      (await ensureLocalAdminToken()),
  });
}

/** Creates a Workspace with defaults from its checkout, unless it exists. */
async function createWorkspace(
  client: ControlPlaneClient,
  name: string,
  checkout: string,
): Promise<boolean> {
  if ((await findResourceView(client.operator, "workspaces", name)) !== undefined) return false;
  const origin = await git(checkout, ["remote", "get-url", "origin"]);
  const source = origin === undefined ? undefined : remoteSource(origin);
  const originHead = await git(checkout, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const ref =
    (originHead?.includes("/") ? originHead.slice(originHead.indexOf("/") + 1) : undefined) ??
    (await git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  await applyManifest(client.operator, {
    manifest: {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "Workspace",
      metadata: { name },
      spec: {
        ...(source === undefined ? {} : { source }),
        ...(ref ? { ref } : {}),
        delivery: "branch",
      },
    },
    source: `supertag.yaml host Workspace ${name}`,
  });
  return true;
}
