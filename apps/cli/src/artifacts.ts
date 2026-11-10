import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import type { ArtifactHolders, ResolvedArtifactTransfer } from "@supertag/core";
import { ArtifactSchema, ListArtifactsResponseSchema } from "@supertag/operator-api";
import {
  FileArtifactStore,
  type ResourceRef,
  WorkletArtifactTransferClient,
} from "@supertag/worker-sdk";
import { artifactVolumeReader } from "./artifact-volume.js";
import { type OperatorClientOptions, refusedAsError, workClient } from "./operator-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { loadServicesFile, readVolumeCredential } from "./supertag-yaml.js";
import { terminalText } from "./terminal-text.js";
import { artifactTransferOf } from "./work-protos.js";

export function artifactHelp(): string {
  return `Usage:
  supertag list artifact [--task ID] [--limit N] [--cursor CURSOR]
  supertag get artifact ID
  supertag download artifact ID --path PATH --out FILE [--output json]

The Control Plane keeps the artifact catalog, never artifact bytes: each copy stays on the
Worker Host or Volume that holds it, and list and get show where. download reads a Volume copy
with this machine's own volume-credentials mapping in supertag.yaml, or fetches the file from
the Worker Host that serves it, and checks its digest. When this machine can reach neither, it
says where the copies are.
`;
}

/** How `download artifact` reads copies on this machine. Tests replace these. */
export interface ArtifactDownloadOptions {
  /**
   * This machine's own mapping from a Volume's credential name to a secret: the
   * `volume-credentials` of its supertag.yaml host services. Rejects when nothing maps the name.
   */
  readonly readVolumeCredential?: (
    credential: string,
  ) => Promise<string | { readonly path: string }>;
  readonly fetch?: typeof fetch;
}

export async function runArtifactCommand(
  client: { readonly operator: OperatorClientOptions },
  command: string,
  given: readonly string[],
  options: ArtifactDownloadOptions = {},
): Promise<string> {
  const output = command === "download" ? takeOutputFlag(given) : { json: true, args: given };
  const { values, positionals } = parseArgs({
    args: output.args,
    allowPositionals: true,
    strict: true,
    options:
      command === "list"
        ? { task: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" } }
        : command === "download"
          ? { path: { type: "string" }, out: { type: "string" } }
          : {},
  });
  const work = workClient(client.operator);
  if (command === "list") {
    if (positionals.length) throw new Error(artifactHelp());
    if (
      values.limit !== undefined &&
      (!/^\d+$/u.test(String(values.limit)) ||
        Number(values.limit) < 1 ||
        Number(values.limit) > 100)
    )
      throw new Error("--limit must be an integer between 1 and 100");
    const page = await refusedAsError(() =>
      work.listArtifacts({
        taskId: typeof values.task === "string" ? values.task : "",
        pageSize: values.limit === undefined ? 0 : Number(values.limit),
        pageToken: typeof values.cursor === "string" ? values.cursor : "",
      }),
    );
    return `${toJsonString(ListArtifactsResponseSchema, page, { prettySpaces: 2 })}\n`;
  }
  if (!["get", "download"].includes(command) || positionals.length !== 1 || !positionals[0]?.trim())
    throw new Error(artifactHelp());
  if (
    command === "download" &&
    (typeof values.path !== "string" ||
      !values.path ||
      typeof values.out !== "string" ||
      !values.out)
  )
    throw new Error(artifactHelp());
  const artifactId = positionals[0];
  const artifact = await refusedAsError(() => work.getArtifact({ id: artifactId }));
  if (command === "get") return `${toJsonString(ArtifactSchema, artifact, { prettySpaces: 2 })}\n`;
  const found = artifact.entries.find((item) => item.path === values.path);
  if (!found) throw new Error("Select an exact --path from supertag get artifact ID");
  const entry = { path: found.path, digest: found.digest, sizeBytes: Number(found.sizeBytes) };
  const resolved = artifactTransferOf(
    await refusedAsError(() => work.resolveArtifactDownload({ artifactId, path: entry.path })),
  );
  if (
    resolved.artifactId !== artifactId ||
    resolved.path !== entry.path ||
    resolved.digest !== entry.digest ||
    resolved.sizeBytes !== entry.sizeBytes
  )
    throw new Error("The Control Plane's download locations do not match the artifact catalog");
  const content = await readCopy(resolved, options);
  // Checked here whichever copy answered: nothing is written unless it is the cataloged file.
  if (
    content.byteLength !== entry.sizeBytes ||
    `sha256:${createHash("sha256").update(content).digest("hex")}` !== entry.digest
  )
    throw new Error(
      "Downloaded artifact does not match its immutable manifest; nothing was written",
    );
  await writeFile(values.out as string, content, { flag: "wx", mode: 0o600 });
  if (output.json)
    return `${JSON.stringify({ artifactId, path: entry.path, output: values.out, digest: entry.digest, sizeBytes: entry.sizeBytes }, null, 2)}\n`;
  return `Saved ${terminalText(entry.path)} (${entry.sizeBytes} bytes, digest verified) to ${terminalText(values.out as string)}.\n`;
}

/**
 * Reads one copy: first from a Volume whose credential this machine maps, then from the serving
 * Worker Host's transfer endpoint with the catalog's short-lived grant for this file and
 * operator. Throws a report of where the copies are when neither works.
 */
async function readCopy(
  resolved: ResolvedArtifactTransfer,
  options: ArtifactDownloadOptions,
): Promise<Uint8Array> {
  const ref: ResourceRef = {
    uri: `supertag-artifact:${resolved.digest}`,
    digest: resolved.digest,
    artifactId: resolved.artifactId,
    path: resolved.path,
  };
  const failures: string[] = [];
  if (resolved.volumes.length > 0) {
    const read = artifactVolumeReader({
      readVolumeCredential: options.readVolumeCredential ?? operatorVolumeCredentials(),
    });
    for (const location of resolved.volumes) {
      try {
        const bytes = await read(location, ref, resolved.sizeBytes);
        if (bytes !== undefined) return bytes;
        failures.push(
          location.credential === undefined
            ? `Volume ${location.volume} names no credential this machine could map`
            : `Volume ${location.volume}: this machine's supertag.yaml maps no volume-credentials entry ${location.credential}`,
        );
      } catch (error) {
        failures.push(`Volume ${location.volume}: ${errorText(error)}`);
      }
    }
  }
  if (resolved.locations.length > 0) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-artifact-download-"));
    try {
      const store = new FileArtifactStore(directory);
      const transfer = new WorkletArtifactTransferClient({
        store,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      // The store verifies the digest and size before keeping the bytes.
      await transfer.fetch(ref, resolved.locations, resolved.sizeBytes);
      return await store.get(ref);
    } catch (error) {
      const reasons =
        error instanceof AggregateError ? error.errors.map(errorText) : [errorText(error)];
      for (const [index, location] of resolved.locations.entries())
        failures.push(
          `Worker Host ${location.workerHostId}: its transfer endpoint could not be read (${reasons[index] ?? reasons[0]})`,
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw new Error(
    unreachableReport(resolved.artifactId, resolved.path, resolved.holders, failures),
  );
}

/** Where an artifact file is, for an operator whose machine can reach none of its copies. */
export function unreachableReport(
  artifactId: string,
  path: string,
  holders: ArtifactHolders,
  failures: readonly string[],
): string {
  const where = [
    ...holders.workerHostIds.map((id) => `Worker Host ${id}`),
    ...holders.volumes.map((volume) => `Volume ${volume}`),
  ];
  return [
    `This machine can reach no copy of artifact ${artifactId} file ${path}, and the Control Plane keeps none.`,
    where.length > 0
      ? `Copies are held by ${where.join(", ")}.`
      : "The catalog records no Worker Host or Volume copy.",
    ...failures.map((failure) => `- ${failure}`),
    "Use supertag describe task TASK_ID to inspect the producing Task and its copy locations.",
    ...(where.length > 0
      ? [
          "Map a holding Volume's credential in this machine's supertag.yaml volume-credentials, or download from a machine that can reach the serving Worker Host.",
        ]
      : []),
  ].join("\n");
}

/**
 * This machine's own Volume mappings: the `volume-credentials` of each host service in its
 * supertag.yaml. A secret is read here, for this download only, and is never sent anywhere.
 */
function operatorVolumeCredentials(): (
  credential: string,
) => Promise<string | { readonly path: string }> {
  let loaded: ReturnType<typeof loadServicesFile> | undefined;
  return async (credential) => {
    loaded ??= loadServicesFile();
    const file = await loaded.catch(() => undefined);
    for (const service of file?.services ?? [])
      if (service.type === "host" && service.volumeCredentials[credential] !== undefined)
        return readVolumeCredential(file as NonNullable<typeof file>, service, credential);
    throw new Error(`No volume-credentials entry on this machine maps ${credential}`);
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
