/**
 * Workspace `copy` mounts: the Worker Host copies a Volume's files into a Task Attempt's
 * environment at the mount path when the Attempt starts and after `setup`, so no
 * prepared environment ever holds them.
 *
 * The Worker Host lists the source first, with a bounded listing that stops as soon as the
 * mount's `maxBytes` or {@link MAX_MOUNT_OBJECTS} is exceeded, and refuses before downloading
 * anything. It then downloads each object with the Volume's credential, which it resolves itself
 * and never passes to the Task, the harness, or a provider, and delivers the bytes through a
 * {@link VolumeCopyTarget}. Keys that would escape the mount path are refused; symbolic links in a
 * `file://` source are neither followed nor recreated. The result is a {@link MountManifest}.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  computeMountUploadChangeSet,
  DEFAULT_MOUNT_MAX_BYTES,
  isSensitiveWorkspaceMountPath,
  MAX_MOUNT_MANIFEST_BYTES,
  MAX_MOUNT_MAX_BYTES,
  MAX_MOUNT_OBJECTS,
  type MountManifest,
  type MountManifestObject,
  type MountOutputManifest,
  type MountUploadFile,
  mountManifestDigest,
  parseVolumeSource,
  protectedVolumePaths,
  type TaskWorkspaceVolume,
  type VolumeLocation,
  type WorkspaceMount,
} from "@supertag/core";
import { assertLocalMountDestination, type LocalMountRoot } from "./local-mount-root.js";
import type { SandboxInstance } from "./sandbox-environment.js";
import { taskWritableRoots } from "./task-writable-roots.js";

/**
 * Object-store credentials a Worker Host resolved for a Volume. They stay in the Worker process:
 * SuperTag uses them to list and download, and never writes them to the Task's environment, the
 * harness input, `.mcp.json`, or a provider call.
 */
export interface VolumeCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** A Volume as one Worker Host reaches it: its source, and its credential for object stores. */
export interface ResolvedVolume {
  /** Provider-held reference for native attachment; never a credential value. */
  readonly nativeCredential?: import("@supertag/core").ModalVolumeCredential;
  readonly volume: string;
  /** The Volume's `source`: `s3://`, `r2://`, or `file://` on this Worker Host. */
  readonly source: string;
  /** Canonical host directory that explicitly consents to a file:// source. */
  readonly consentDirectory?: string;
  /** Resolves the Volume's credential on the Worker Host. Required for `s3://` and `r2://`. */
  credentials?(signal?: AbortSignal): Promise<VolumeCredentials>;
}

/** The Task Attempt a Volume is resolved for. */
export interface VolumeTask {
  readonly taskId: string;
  readonly attemptId: string;
  /**
   * The Volumes its Workspace plan carries, as the Control Plane's catalog held them when it
   * dispatched the Attempt: sources and credential names only.
   */
  readonly volumes?: readonly TaskWorkspaceVolume[];
}

/**
 * Resolves the Volumes that a Task's Workspace mounts name, on the Worker Host. The Worker
 * composition supplies it from the Volume catalog entries the Attempt was dispatched with and the
 * host service's credential mapping; Workspace environments only consume it.
 */
export interface VolumeResolver {
  /**
   * Host directories and files a `file://` Volume may not be in or contain, such as the Worker
   * Host's state directory, so a Volume never copies SuperTag's own state into a Task.
   */
  readonly protectedDirectories?: readonly string[];
  resolve(volume: string, task: VolumeTask, signal?: AbortSignal): Promise<ResolvedVolume>;
  /**
   * Resolves a native mount without opening host copy credentials. Must apply host artifact
   * protection, including normalized source aliases and protected dispatched file Volumes.
   * Native mounts are refused when this guard is unavailable.
   */
  resolveMount?(volume: string, task: VolumeTask, signal?: AbortSignal): Promise<ResolvedVolume>;
}

/**
 * Where a copy lands: the Worker Host's own filesystem, or a Task's sandbox. Every write is
 * exclusive and never follows a symbolic link.
 */
export interface VolumeCopyTarget {
  /** Creates the empty mount directory. Refuses a path that exists or crosses a symbolic link. */
  create(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  write(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  /** Makes a read-only copy unwritable after all files are placed. */
  seal(path: string): Promise<void>;
}

/**
 * A copy mount refused or failed. Its message names the Volume and the reason, and never a
 * credential. The Attempt fails as a Workspace setup failure.
 */
export class VolumeCopyError extends Error {
  override name = "WorkspaceSetupError";
}

/**
 * A host copy's directory is no longer the one SuperTag verified: moved, replaced, or turned
 * into a symbolic link. SuperTag stops and leaves everything in place.
 */
export class HostCopyChangedError extends VolumeCopyError {}

/** Objects one listing request asks for. */
const LIST_PAGE = 1000;
/**
 * Listing requests one mount may make: enough for {@link MAX_MOUNT_OBJECTS} keys in full pages,
 * plus one, since a store may end a listing with an empty page.
 */
const MAX_LIST_PAGES = Math.ceil(MAX_MOUNT_OBJECTS / LIST_PAGE) + 1;
/** Directory entries a `file://` listing visits before it refuses, files and directories alike. */
const MAX_FILE_ENTRIES = MAX_MOUNT_OBJECTS * 4;
/** Longest key segment most filesystems accept, in bytes. */
const MAX_SEGMENT_BYTES = 255;
const MAX_KEY_LENGTH = 1024;
/** Aggregate copy limit for one Task Attempt, regardless of mount count or source type. */
const MAX_ATTEMPT_MOUNT_BYTES = 20 * 1024 ** 3;

interface ListedObject extends MountManifestObject {
  read(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

interface CopyMountInput {
  readonly mount: WorkspaceMount;
  readonly volume: ResolvedVolume;
  readonly target: VolumeCopyTarget;
  /** One budget shared by every mount copied for this Task Attempt. */
  readonly budget: CopyBudget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Host directories a `file://` source may not be in or contain. */
  readonly protectedDirectories?: readonly string[];
}

/** A regular file whose contents can be read again after the complete upload set is checked. */
export interface VolumeUploadFile extends MountUploadFile {
  read(): Promise<Uint8Array>;
}

export interface UploadMountInput {
  readonly mount: WorkspaceMount;
  readonly input: MountManifest;
  readonly volume: ResolvedVolume;
  readonly files: () => Promise<readonly VolumeUploadFile[]>;
  readonly signal?: AbortSignal;
  /** Host-side test seam; production uses the Volume source. */
  readonly put?: (key: string, bytes: Uint8Array) => Promise<void>;
}

/** Uploads in key order, stopping at the first failed write and preserving exact partial evidence. */
export async function uploadWorkspaceMount(input: UploadMountInput): Promise<MountOutputManifest> {
  const { mount, volume } = input;
  const base = {
    volume: mount.volume,
    source: volume.source,
    path: mount.path,
    uploadedAt: new Date().toISOString(),
  };
  const mountRefusal = (reason: string): MountOutputManifest => ({
    ...base,
    status: "refused",
    objects: [],
    skipped: 0,
    error: { key: "__mount__", reason: reason.slice(0, 1024) },
    notAttempted: ["__mount__"],
  });
  if (
    input.input.volume !== mount.volume ||
    input.input.path !== mount.path ||
    input.input.source !== volume.source ||
    volume.volume !== mount.volume
  )
    return mountRefusal("Volume source or mount changed since copy-in");
  let files: readonly VolumeUploadFile[];
  try {
    files = (await input.files()).toSorted((left, right) => compare(left.key, right.key));
  } catch (error) {
    return mountRefusal(message(error));
  }
  let changes: ReturnType<typeof computeMountUploadChangeSet>;
  try {
    changes = computeMountUploadChangeSet(
      input.input,
      files,
      mount.maxBytes ?? DEFAULT_MOUNT_MAX_BYTES,
    );
  } catch (error) {
    return mountRefusal(message(error));
  }
  if (changes.status === "refused") return { ...base, ...changes };
  const selected = new Map(files.map((file) => [file.key, file]));
  const uploaded: MountUploadFile[] = [];
  let client: S3Client | undefined;
  let put = input.put;
  try {
    if (!put && changes.objects.length) {
      const location = parseVolumeSource(volume.source);
      if (location.scheme === "file") {
        const root = await realpath(location.path);
        if (volume.consentDirectory && !inside(root, volume.consentDirectory))
          throw new Error("Volume source moved outside its host consent directory");
        put = (key, bytes) => putFileObject(root, key, bytes);
      } else if (location.scheme === "s3" || location.scheme === "r2") {
        const credentials = await volumeCredentials(mount, volume, location, input.signal);
        client = objectStoreClient(mount.volume, location, credentials, 1);
        const bucket = location.bucket;
        const prefix = location.prefix === "" ? "" : `${location.prefix.replace(/\/$/u, "")}/`;
        put = async (key, bytes) => {
          try {
            await client?.send(
              new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${key}`, Body: bytes }),
              input.signal === undefined ? {} : { abortSignal: input.signal },
            );
          } catch (error) {
            throw new Error(redact(message(error), credentials));
          }
        };
      } else throw new Error(`Volume ${mount.volume} source is not writable by copy`);
    }
    for (const [index, file] of changes.objects.entries()) {
      try {
        input.signal?.throwIfAborted();
        const bytes = await (selected.get(file.key) as VolumeUploadFile).read();
        if (
          bytes.byteLength !== file.size ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.sha256
        )
          throw new Error("File changed after upload bounds were checked");
        await (put as NonNullable<typeof put>)(file.key, bytes);
        uploaded.push(file);
      } catch (error) {
        return {
          ...base,
          status: "partial",
          objects: uploaded,
          skipped: changes.skipped,
          error: { key: file.key, reason: message(error).slice(0, 1024) },
          notAttempted: changes.objects.slice(index).map((entry) => entry.key),
        };
      }
    }
    return {
      ...base,
      status: "complete",
      objects: uploaded,
      skipped: changes.skipped,
      notAttempted: [],
    };
  } catch (error) {
    return {
      ...base,
      status: "refused",
      objects: [],
      skipped: changes.skipped,
      error: { key: changes.objects[0]?.key ?? "__mount__", reason: message(error).slice(0, 1024) },
      notAttempted: changes.objects.map((file) => file.key),
    };
  } finally {
    client?.destroy();
  }
}

/** Enumerate and hash regular host files without following symlinks. */
export async function listHostMountUploadFiles(root: string): Promise<readonly VolumeUploadFile[]> {
  const result: VolumeUploadFile[] = [];
  const canonicalRoot = await realpath(root);
  const walk = async (directory: string, prefix: string): Promise<void> => {
    if (!inside(await realpath(directory), canonicalRoot))
      throw new Error("Mount upload directory escaped its root");
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      compare(a.name, b.name),
    )) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      mountRelativeKey("upload", key);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!(await lstat(path)).isDirectory()) throw new Error(`Mount directory ${key} changed`);
        await walk(path, key);
      } else if (entry.isFile()) {
        const status = await lstat(path);
        if (!status.isFile() || status.nlink !== 1)
          throw new Error(`Mount file ${key} changed or has another link`);
        const read = async () => {
          if (!inside(await realpath(path), canonicalRoot))
            throw new Error(`Mount file ${key} escaped its root`);
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const current = await handle.stat();
            if (
              !current.isFile() ||
              current.ino !== status.ino ||
              current.dev !== status.dev ||
              current.size !== status.size
            )
              throw new Error(`Mount file ${key} changed`);
            return await handle.readFile();
          } finally {
            await handle.close();
          }
        };
        const bytes = await read();
        result.push({
          key,
          size: bytes.byteLength,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          read,
        });
        if (result.length > MAX_MOUNT_OBJECTS * 2)
          throw new Error("Mount upload lists too many files");
      }
    }
  };
  if (!(await lstat(root)).isDirectory()) throw new Error("Mount upload root is not a directory");
  await walk(root, "");
  return result;
}

/** Scan inside Modal or e2b, then read each selected file back through bounded safe reads. */
export async function listSandboxMountUploadFiles(
  sandbox: SandboxInstance,
  root: string,
): Promise<readonly VolumeUploadFile[]> {
  let output = "";
  const process = await sandbox.start(
    { command: "python3", args: ["-c", SANDBOX_UPLOAD_SCAN, root], timeoutMs: 60_000 },
    {
      onOutput(chunk) {
        if (chunk.stream !== "stdout") return;
        output += chunk.text;
        if (output.length > MAX_MOUNT_MANIFEST_BYTES)
          throw new Error("Mount upload listing is too large");
      },
    },
  );
  if ((await process.wait()).exitCode !== 0) throw new Error("Mount upload scan failed in sandbox");
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length > MAX_MOUNT_OBJECTS * 2)
    throw new Error("Mount upload lists too many files");
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid sandbox mount listing");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry["key"] !== "string" ||
      typeof entry["size"] !== "number" ||
      typeof entry["sha256"] !== "string"
    )
      throw new Error("Invalid sandbox mount file");
    const key = mountRelativeKey("upload", entry["key"]);
    const size = entry["size"];
    const sha256 = entry["sha256"];
    return {
      key,
      size,
      sha256,
      read: () => sandbox.read(posix.join(root, key), { maximumBytes: size, rejectSymlinks: true }),
    };
  });
}

const SANDBOX_UPLOAD_SCAN = [
  "import hashlib,json,os,stat,sys",
  "root=sys.argv[1]",
  "if not stat.S_ISDIR(os.lstat(root).st_mode): sys.exit(2)",
  "out=[]",
  "for directory,dirs,files in os.walk(root,followlinks=False):",
  "  dirs[:]=sorted(d for d in dirs if not os.path.islink(os.path.join(directory,d)))",
  "  for name in sorted(files):",
  "    path=os.path.join(directory,name)",
  "    info=os.lstat(path)",
  "    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: continue",
  "    key=os.path.relpath(path,root).replace(os.sep,'/')",
  "    h=hashlib.sha256()",
  "    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
  "    if not stat.S_ISREG(os.fstat(fd).st_mode): os.close(fd); continue",
  "    with os.fdopen(fd,'rb') as stream:",
  "      for chunk in iter(lambda:stream.read(65536),b''): h.update(chunk)",
  "    out.append({'key':key,'size':info.st_size,'sha256':'sha256:'+h.hexdigest()})",
  "    if len(out)>20000: sys.exit(3)",
  "print(json.dumps(out,separators=(',',':')))",
].join("\n");

async function putFileObject(root: string, key: string, bytes: Uint8Array): Promise<void> {
  mountRelativeKey("upload", key);
  const target = join(root, ...key.split("/"));
  const parent = dirname(target);
  let directory = root;
  for (const segment of key.split("/").slice(0, -1)) {
    if (!inside(await realpath(directory), root))
      throw new Error(`Volume destination for ${key} escaped its source`);
    directory = join(directory, segment);
    const status = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (status === undefined) await mkdir(directory);
    else if (!status.isDirectory())
      throw new Error(`Volume destination for ${key} is not a directory`);
  }
  const actual = await realpath(parent);
  if (!inside(actual, root)) throw new Error(`Volume destination for ${key} escaped its source`);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile())
    throw new Error(`Volume destination ${key} is not a regular file`);
  const temporary = join(parent, `.supertag-upload-${randomUUID()}`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * The remaining content and manifest bytes for one Task Attempt's copies. Every listed object
 * is counted before anything downloads, including repeated copies of the same Volume.
 */
export class CopyBudget {
  #remaining = MAX_MOUNT_MANIFEST_BYTES - 2;
  #contentRemaining = MAX_ATTEMPT_MOUNT_BYTES;

  charge(mount: WorkspaceMount, bytes: number): void {
    this.#remaining -= bytes + 1;
    if (this.#remaining < 0)
      throw new VolumeCopyError(
        `Volume ${mount.volume} for ${mount.path} lists more object keys than one Task Attempt's mount manifests can record (${MAX_MOUNT_MANIFEST_BYTES} bytes as JSON); SuperTag downloaded nothing`,
      );
  }

  /** Counts a manifest's own fields, at their longest. */
  chargeManifest(mount: WorkspaceMount, source: string): void {
    this.charge(
      mount,
      Buffer.byteLength(
        JSON.stringify({
          volume: mount.volume,
          source,
          path: mount.path,
          strategy: "copy",
          access: mount.access,
          objectCount: MAX_MOUNT_OBJECTS,
          totalBytes: Number.MAX_SAFE_INTEGER,
          digest: `sha256:${"0".repeat(64)}`,
          copiedAt: new Date(0).toISOString(),
          objects: [],
        }),
      ),
    );
  }

  /** Counts one object's manifest entry; `file://` entries also carry a SHA-256. */
  chargeObject(mount: WorkspaceMount, object: MountManifestObject, _file: boolean): void {
    this.#contentRemaining -= object.size;
    if (this.#contentRemaining < 0)
      throw new VolumeCopyError(
        `Volume ${mount.volume} for ${mount.path} exceeds the Task Attempt's ${MAX_ATTEMPT_MOUNT_BYTES}-byte limit across all mounts; SuperTag stopped before copying this mount`,
      );
    this.charge(
      mount,
      Buffer.byteLength(
        JSON.stringify({
          ...object,
          sha256: `sha256:${"0".repeat(64)}`,
        }),
      ),
    );
  }
}

/**
 * Copies one mount's Volume into `target` at `mount.path` and returns its manifest. Nothing is
 * downloaded until the bounded listing is within `maxBytes`, {@link MAX_MOUNT_OBJECTS}, and
 * {@link MAX_MOUNT_MANIFEST_BYTES}. The caller creates one {@link CopyBudget} per Task Attempt
 * and passes it to every call, including concurrent copies. A failed call retains its charges.
 */
export async function copyWorkspaceMount(input: CopyMountInput): Promise<MountManifest> {
  const listing = await listMount(input, input.budget);
  try {
    return await copyListed(listing, input.target, input.signal, input.now);
  } finally {
    listing.close();
  }
}

/** One mount's bounded listing, ready to copy. `close` releases its object-store client. */
interface ListedMount {
  readonly mount: WorkspaceMount;
  readonly source: string;
  readonly location: VolumeLocation;
  readonly objects: readonly ListedObject[];
  close(): void;
}

/** Checks a resolved Volume against its mount and parses its source, naming the Volume. */
function volumeLocation(
  mount: WorkspaceMount,
  volume: ResolvedVolume,
): Extract<VolumeLocation, { scheme: "file" | "s3" | "r2" }> {
  if (volume.volume !== mount.volume)
    throw new VolumeCopyError(
      `Workspace mount ${mount.volume} resolved to Volume ${volume.volume}; SuperTag copied nothing`,
    );
  if (mount.strategy !== "copy" || !["read-only", "read-write"].includes(mount.access))
    throw new VolumeCopyError(`Workspace mount ${mount.volume} at ${mount.path} must be a copy`);
  try {
    const location = parseVolumeSource(volume.source);
    if (location.scheme === "gs" || location.scheme === "modal-volume")
      throw new VolumeCopyError(
        `Volume ${mount.volume}: ${location.scheme}:// sources are mount-only; copy is unsupported`,
      );
    return location;
  } catch (error) {
    throw new VolumeCopyError(`Volume ${mount.volume} has an invalid source: ${message(error)}`);
  }
}

async function listMount(
  input: Omit<CopyMountInput, "target" | "now" | "budget">,
  budget: CopyBudget,
): Promise<ListedMount> {
  const { mount, volume, signal } = input;
  const location = volumeLocation(mount, volume);
  const maxBytes = mount.maxBytes ?? DEFAULT_MOUNT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MOUNT_MAX_BYTES)
    throw new VolumeCopyError(
      `Volume ${mount.volume} maxBytes must be at most ${MAX_MOUNT_MAX_BYTES} bytes`,
    );
  budget.chargeManifest(mount, volume.source);
  const listing =
    location.scheme === "file"
      ? {
          objects: await listFiles(
            mount,
            location.path,
            maxBytes,
            budget,
            input.protectedDirectories ?? [],
            volume.consentDirectory,
            signal,
          ),
          close() {},
        }
      : await listObjects(mount, volume, location, maxBytes, budget, signal);
  return { mount, source: volume.source, location, ...listing };
}

async function copyListed(
  listing: ListedMount,
  target: VolumeCopyTarget,
  signal: AbortSignal | undefined,
  now: (() => Date) | undefined,
): Promise<MountManifest> {
  const { mount, source, objects: listed } = listing;
  signal?.throwIfAborted();
  await target.create(mount.path);
  const directories = new Set<string>();
  for (const object of listed) {
    const parts = object.key.split("/");
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join("/"));
  }
  for (const directory of [...directories].toSorted())
    await target.mkdir(posix.join(mount.path, directory));
  const objects: MountManifestObject[] = [];
  for (const object of listed) {
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    let length = 0;
    const chunks = async function* () {
      for await (const chunk of object.read(signal)) {
        length += chunk.byteLength;
        if (length > object.size)
          throw new VolumeCopyError(
            `Volume ${mount.volume} object ${JSON.stringify(object.key)} changed while it was copied`,
          );
        hash.update(chunk);
        yield chunk;
      }
      if (length !== object.size)
        throw new VolumeCopyError(
          `Volume ${mount.volume} object ${JSON.stringify(object.key)} changed while it was copied`,
        );
    };
    await target.write(posix.join(mount.path, object.key), chunks());
    objects.push({
      key: object.key,
      size: object.size,
      ...(object.etag === undefined ? {} : { etag: object.etag }),
      ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
      sha256: `sha256:${hash.digest("hex")}`,
    });
  }
  if (mount.access === "read-only") await target.seal(mount.path);
  return {
    volume: mount.volume,
    source,
    path: mount.path,
    strategy: "copy",
    access: mount.access,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
    digest: mountManifestDigest(source, objects),
    copiedAt: (now?.() ?? new Date()).toISOString(),
    objects,
  };
}

interface WorkspaceMountsInput {
  readonly mounts: readonly WorkspaceMount[];
  readonly volumes: VolumeResolver | undefined;
  readonly task: VolumeTask;
  readonly signal?: AbortSignal;
  /** Host directories a `file://` source may not be in or contain, besides the resolver's. */
  readonly protectedDirectories?: readonly string[];
}

/**
 * Copies every mount and returns their manifests. Every Volume is resolved and every listing is
 * within its limits before the first byte is downloaded.
 */
export async function copyWorkspaceMounts(
  input: WorkspaceMountsInput & { readonly target: VolumeCopyTarget },
): Promise<readonly MountManifest[]> {
  const planned = await planWorkspaceMounts(input);
  try {
    return await planned.copy(input.target, input.signal);
  } finally {
    planned.close();
  }
}

/** Mounts whose Volumes are resolved and listed within their limits, ready to copy. */
export interface PlannedWorkspaceMounts {
  /** Downloads each listed object and delivers it to `target`; returns the manifests. */
  copy(target: VolumeCopyTarget, signal?: AbortSignal): Promise<readonly MountManifest[]>;
  /** Releases object-store clients. Safe to call more than once. */
  close(): void;
}

/**
 * Resolves every mount's Volume and lists it with a bounded listing, refusing with the Volume's
 * name when it cannot be resolved or is over `maxBytes`, {@link MAX_MOUNT_OBJECTS}, or
 * {@link MAX_MOUNT_MANIFEST_BYTES}. Nothing is downloaded and no target is touched, so a remote
 * environment plans before it creates a sandbox.
 */
export async function planWorkspaceMounts(
  input: WorkspaceMountsInput,
): Promise<PlannedWorkspaceMounts> {
  if (input.mounts.length === 0) return { copy: async () => [], close() {} };
  const resolver = input.volumes;
  if (resolver === undefined)
    throw new VolumeCopyError(
      `This Worker Host resolves no Volumes, so it cannot copy Volume ${input.mounts[0]?.volume}`,
    );
  const resolved: ResolvedVolume[] = [];
  for (const mount of input.mounts)
    resolved.push(await resolveVolume(resolver, mount.volume, input.task, input.signal));
  const budget = new CopyBudget();
  const protectedDirectories = [
    ...(resolver.protectedDirectories ?? []),
    ...(input.protectedDirectories ?? []),
    ...protectedVolumePaths(input.task.volumes),
  ];
  const listings: ListedMount[] = [];
  const close = () => {
    for (const listing of listings.splice(0)) listing.close();
  };
  try {
    for (const [index, mount] of input.mounts.entries())
      listings.push(
        await listMount(
          {
            mount,
            volume: resolved[index] as ResolvedVolume,
            protectedDirectories,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
          budget,
        ),
      );
  } catch (error) {
    close();
    throw error;
  }
  return {
    async copy(target, signal) {
      const manifests: MountManifest[] = [];
      for (const listing of listings)
        manifests.push(await copyListed(listing, target, signal ?? input.signal, undefined));
      return manifests;
    },
    close,
  };
}

async function resolveVolume(
  resolver: VolumeResolver,
  volume: string,
  task: VolumeTask,
  signal: AbortSignal | undefined,
): Promise<ResolvedVolume> {
  try {
    return await resolver.resolve(volume, task, signal);
  } catch (error) {
    if (error instanceof VolumeCopyError) throw error;
    throw new VolumeCopyError(
      `This Worker Host cannot resolve Volume ${volume}: ${message(error)}`,
    );
  }
}

/**
 * Resolves every mount's Volume on this Worker Host before any provider call, and returns a
 * resolver that serves exactly those Volumes to the Attempt's `start`. Each object-store
 * credential is read once and checked here; each `file://` source is resolved to its real path
 * and refused when it is in or contains a protected directory. Every refusal names the Volume.
 * Returns undefined when there are no mounts.
 */
export async function pinWorkspaceVolumes(
  input: WorkspaceMountsInput,
): Promise<VolumeResolver | undefined> {
  if (input.mounts.length === 0) return undefined;
  const resolver = input.volumes;
  if (resolver === undefined)
    throw new VolumeCopyError(
      `This Worker Host resolves no Volumes, so it cannot copy Volume ${input.mounts[0]?.volume}`,
    );
  const protectedDirectories = [
    ...(resolver.protectedDirectories ?? []),
    ...(input.protectedDirectories ?? []),
    ...protectedVolumePaths(input.task.volumes),
  ];
  const pinned = new Map<string, ResolvedVolume>();
  for (const mount of input.mounts) {
    if (pinned.has(mount.volume)) continue;
    const volume = await resolveVolume(resolver, mount.volume, input.task, input.signal);
    const location = volumeLocation(mount, volume);
    if (location.scheme === "file") {
      await fileSourceRoot(mount, location.path, protectedDirectories, volume.consentDirectory);
      pinned.set(mount.volume, {
        volume: volume.volume,
        source: volume.source,
        ...(volume.consentDirectory === undefined
          ? {}
          : { consentDirectory: volume.consentDirectory }),
      });
      continue;
    }
    const credentials = await volumeCredentials(mount, volume, location, input.signal);
    checkCredentials(mount.volume, credentials);
    pinned.set(mount.volume, {
      volume: volume.volume,
      source: volume.source,
      credentials: async () => credentials,
    });
  }
  return {
    protectedDirectories,
    async resolve(volume, task) {
      const found = pinned.get(volume);
      if (found === undefined || task.attemptId !== input.task.attemptId)
        throw new VolumeCopyError(
          `Volume ${volume} was not resolved for Task Attempt ${task.attemptId} before it started`,
        );
      return found;
    },
  };
}

/**
 * The key's path below the mount, or a refusal: no absolute keys, no empty, `.`, or `..`
 * segments, no backslashes or control characters, and nothing a filesystem would refuse.
 */
export function mountRelativeKey(volume: string, key: string): string {
  const refuse = (why: string) =>
    new VolumeCopyError(
      `Volume ${volume} object key ${JSON.stringify(key.slice(0, 200))} ${why}; SuperTag copied nothing`,
    );
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw refuse("has an unsupported length");
  if (key.startsWith("/")) throw refuse("is absolute");
  if (key.includes("\\")) throw refuse("contains a backslash");
  if (/[\p{Cc}]/u.test(key)) throw refuse("contains a control character");
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      throw refuse("would escape or ambiguously name a path under the mount");
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES)
      throw refuse(`has a path segment over ${MAX_SEGMENT_BYTES} bytes`);
  }
  return key;
}

/** Refuses a listing where one key is both a file and a directory of another. */
function assertNoPrefixConflicts(volume: string, keys: readonly string[]): void {
  const files = new Set(keys);
  for (const key of keys) {
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (files.has(parent))
        throw new VolumeCopyError(
          `Volume ${volume} holds both a file and a directory at ${JSON.stringify(parent)}; SuperTag copied nothing`,
        );
    }
  }
}

function tooLarge(mount: WorkspaceMount, maxBytes: number, listed: number): VolumeCopyError {
  return new VolumeCopyError(
    `Volume ${mount.volume} for ${mount.path} holds more than its mount's ${maxBytes}-byte limit (${listed} bytes listed before SuperTag stopped); SuperTag downloaded nothing`,
  );
}

function tooMany(mount: WorkspaceMount): VolumeCopyError {
  return new VolumeCopyError(
    `Volume ${mount.volume} for ${mount.path} holds more than ${MAX_MOUNT_OBJECTS} objects, the most a copy mount takes; SuperTag downloaded nothing`,
  );
}

/** A bounded ListObjectsV2 listing of an S3-compatible prefix. */
async function listObjects(
  mount: WorkspaceMount,
  volume: ResolvedVolume,
  location: Extract<VolumeLocation, { scheme: "s3" | "r2" }>,
  maxBytes: number,
  budget: CopyBudget,
  signal: AbortSignal | undefined,
): Promise<{ readonly objects: ListedObject[]; close(): void }> {
  const credentials = await volumeCredentials(mount, volume, location, signal);
  const client = objectStoreClient(mount.volume, location, credentials);
  const hide = (error: unknown) => redact(message(error), credentials);
  try {
    const prefix =
      location.prefix === "" || location.prefix.endsWith("/")
        ? location.prefix
        : `${location.prefix}/`;
    const listed: ListedObject[] = [];
    let bytes = 0;
    // Every key the store lists counts, folder markers included, and so does every page, so a
    // store that lists markers or empty truncated pages cannot keep the listing going.
    let keys = 0;
    let pages = 0;
    let token: string | undefined;
    do {
      pages += 1;
      if (pages > MAX_LIST_PAGES) throw tooMany(mount);
      const page = await client
        .send(
          new ListObjectsV2Command({
            Bucket: location.bucket,
            ...(prefix === "" ? {} : { Prefix: prefix }),
            MaxKeys: LIST_PAGE,
            ...(token === undefined ? {} : { ContinuationToken: token }),
          }),
          signal === undefined ? {} : { abortSignal: signal },
        )
        .catch((error: unknown) => {
          throw new VolumeCopyError(`Volume ${mount.volume} could not be listed: ${hide(error)}`);
        });
      const contents = page.Contents ?? [];
      if (contents.length > LIST_PAGE)
        throw new VolumeCopyError(
          `Volume ${mount.volume} listing returned more than ${LIST_PAGE} keys in one page`,
        );
      for (const entry of contents) {
        keys += 1;
        if (keys > MAX_MOUNT_OBJECTS) throw tooMany(mount);
        const key = entry.Key ?? "";
        const size = Number(entry.Size ?? 0);
        if (!key.startsWith(prefix))
          throw new VolumeCopyError(
            `Volume ${mount.volume} listing returned key ${JSON.stringify(key.slice(0, 200))} outside its prefix`,
          );
        const rest = key.slice(prefix.length);
        // A zero-byte key ending in "/" is a folder marker, not a file.
        if (rest === "" || (rest.endsWith("/") && size === 0)) continue;
        const relativeKey = mountRelativeKey(mount.volume, rest);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new VolumeCopyError(`Volume ${mount.volume} listing returned an invalid size`);
        bytes += size;
        if (bytes > maxBytes) throw tooLarge(mount, maxBytes, bytes);
        const etag = entry.ETag;
        budget.chargeObject(
          mount,
          { key: relativeKey, size, ...(etag === undefined ? {} : { etag }) },
          false,
        );
        listed.push({
          key: relativeKey,
          size,
          ...(etag === undefined ? {} : { etag }),
          read: (readSignal) =>
            readObject(client, mount.volume, location.bucket, key, size, etag, readSignal, hide),
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && token === undefined)
        throw new VolumeCopyError(
          `Volume ${mount.volume} listing was truncated without a continuation token`,
        );
    } while (token !== undefined);
    listed.sort((left, right) => compare(left.key, right.key));
    assertNoPrefixConflicts(
      mount.volume,
      listed.map((object) => object.key),
    );
    return { objects: listed, close: () => client.destroy() };
  } catch (error) {
    client.destroy();
    throw error;
  }
}

/** Reads a Volume's object-store credential through its resolver, naming the Volume on failure. */
async function volumeCredentials(
  mount: WorkspaceMount,
  volume: ResolvedVolume,
  location: Extract<VolumeLocation, { scheme: "s3" | "r2" }>,
  signal: AbortSignal | undefined,
): Promise<VolumeCredentials> {
  if (volume.credentials === undefined)
    throw new VolumeCopyError(
      `This Worker Host has no credential for Volume ${mount.volume}, so it cannot copy ${location.scheme}://${location.bucket}`,
    );
  try {
    return await volume.credentials(signal);
  } catch (error) {
    // A resolver's own refusal names the Volume and never a value; anything else is hidden.
    if (error instanceof VolumeCopyError) throw error;
    throw new VolumeCopyError(
      `This Worker Host could not resolve the credential for Volume ${mount.volume}`,
    );
  }
}

function objectStoreClient(
  volume: string,
  location: Extract<VolumeLocation, { scheme: "s3" | "r2" }>,
  credentials: VolumeCredentials,
  maxAttempts = 3,
): S3Client {
  checkCredentials(volume, credentials);
  return new S3Client({
    region: location.region ?? (location.scheme === "r2" ? "auto" : "us-east-1"),
    ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
    ...(location.forcePathStyle === undefined ? {} : { forcePathStyle: location.forcePathStyle }),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken === undefined ? {} : { sessionToken: credentials.sessionToken }),
    },
    maxAttempts,
  });
}

/** Refuses a credential that cannot reach an object store, without echoing any of it. */
function checkCredentials(volume: string, credentials: VolumeCredentials): void {
  if (!credentials.accessKeyId || !credentials.secretAccessKey)
    throw new VolumeCopyError(`The credential for Volume ${volume} needs an access key and secret`);
}

/** Downloads exactly the listed version of an object, refusing more bytes than listed. */
async function* readObject(
  client: S3Client,
  volume: string,
  bucket: string,
  key: string,
  size: number,
  etag: string | undefined,
  signal: AbortSignal | undefined,
  hide: (error: unknown) => string,
): AsyncIterable<Uint8Array> {
  const changed = () =>
    new VolumeCopyError(
      `Volume ${volume} object ${JSON.stringify(key.slice(0, 200))} changed while it was copied`,
    );
  const response = await client
    .send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(etag === undefined ? {} : { IfMatch: etag }),
      }),
      signal === undefined ? {} : { abortSignal: signal },
    )
    .catch((error: unknown) => {
      if ((error as { name?: string }).name === "PreconditionFailed") throw changed();
      throw new VolumeCopyError(
        `Volume ${volume} object ${JSON.stringify(key.slice(0, 200))} could not be downloaded: ${hide(error)}`,
      );
    });
  if (response.ContentLength !== undefined && response.ContentLength !== size) throw changed();
  const body = response.Body as { transformToWebStream?(): ReadableStream<Uint8Array> } | undefined;
  if (body?.transformToWebStream === undefined)
    throw new VolumeCopyError(`Volume ${volume} returned no body for an object`);
  const reader = body.transformToWebStream().getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > size) {
        await reader.cancel().catch(() => undefined);
        throw changed();
      }
      offset += value.byteLength;
      for (let start = 0; start < value.byteLength; start += 64 * 1024)
        yield value.subarray(start, start + 64 * 1024);
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) throw changed();
}

/**
 * A bounded walk of a `file://` directory on the Worker Host. Only regular files are listed;
 * symbolic links and special files are skipped, never followed. Each file is later opened without
 * following links and must still be the same file, with the same size.
 */
async function listFiles(
  mount: WorkspaceMount,
  path: string,
  maxBytes: number,
  budget: CopyBudget,
  protectedDirectories: readonly string[],
  consentDirectory: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ListedObject[]> {
  const root = await fileSourceRoot(mount, path, protectedDirectories, consentDirectory);
  const rootIdentity = await lstat(root, { bigint: true });
  const verifyRoot = async () => {
    const current = await fileSourceRoot(mount, path, protectedDirectories, consentDirectory);
    const status = await lstat(root, { bigint: true });
    if (current !== root || status.dev !== rootIdentity.dev || status.ino !== rootIdentity.ino)
      throw new VolumeCopyError(`Volume ${mount.volume} source directory changed during copying`);
  };
  const listed: ListedObject[] = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (
    directory: string,
    prefix: string,
    identity: { readonly dev: bigint; readonly ino: bigint },
  ): Promise<void> => {
    const verify = async () => {
      await verifyRoot();
      const [status, actual] = await Promise.all([
        lstat(directory, { bigint: true }),
        realpath(directory),
      ]);
      if (
        !status.isDirectory() ||
        status.dev !== identity.dev ||
        status.ino !== identity.ino ||
        !inside(actual, root)
      )
        throw new VolumeCopyError(`Volume ${mount.volume} source directory changed during listing`);
    };
    await verify();
    const handle = await opendir(directory);
    try {
      // Recheck after opening: a parent or this directory may have become a symlink.
      await verify();
    } catch (error) {
      await handle.close();
      throw error;
    }
    const children: { name: string; kind: "file" | "directory" }[] = [];
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_FILE_ENTRIES) throw tooMany(mount);
      if (entry.isDirectory()) children.push({ name: entry.name, kind: "directory" });
      else if (entry.isFile()) children.push({ name: entry.name, kind: "file" });
      // Symbolic links, sockets, devices, and FIFOs are skipped, never followed.
    }
    await verify();
    for (const child of children.toSorted((left, right) => compare(left.name, right.name))) {
      signal?.throwIfAborted();
      await verify();
      const key = mountRelativeKey(mount.volume, prefix ? `${prefix}/${child.name}` : child.name);
      const absolute = join(directory, child.name);
      const status = await lstat(absolute, { bigint: true });
      if (child.kind === "directory") {
        if (status.isDirectory()) await visit(absolute, key, status);
        continue;
      }
      if (!status.isFile()) continue;
      assertSingleLink(mount.volume, key, status.nlink);
      const size = Number(status.size);
      bytes += size;
      if (bytes > maxBytes) throw tooLarge(mount, maxBytes, bytes);
      if (listed.length + 1 > MAX_MOUNT_OBJECTS) throw tooMany(mount);
      budget.chargeObject(mount, { key, size }, true);
      const identity = status;
      listed.push({
        key,
        size,
        read: () => readFile(mount.volume, root, key, identity, verifyRoot),
      });
    }
  };
  await visit(root, "", rootIdentity);
  listed.sort((left, right) => compare(left.key, right.key));
  return listed;
}

/**
 * The real path of a `file://` source directory, refused when it is in or contains a protected
 * directory or file, compared after every symbolic link on both sides is resolved.
 */
async function fileSourceRoot(
  mount: WorkspaceMount,
  path: string,
  protectedDirectories: readonly string[],
  consentDirectory?: string,
): Promise<string> {
  let root: string;
  try {
    root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new VolumeCopyError(
      `Volume ${mount.volume} source directory ${path} is not readable on this Worker Host: ${message(error)}`,
    );
  }
  for (const writable of await taskWritableRealRoots())
    if (overlaps(root, writable) || overlaps(resolve(path), writable))
      throw new VolumeCopyError(
        `Volume ${mount.volume} file:// source overlaps a temporary directory a Task can write; SuperTag refuses Task-writable sources`,
      );
  if (consentDirectory !== undefined && !inside(root, consentDirectory))
    throw new VolumeCopyError(
      `Volume ${mount.volume} file:// source moved outside its host consent directory`,
    );
  const home = await realExistingPath(homedir());
  if (inside(home, root))
    throw new VolumeCopyError(
      `Volume ${mount.volume} file:// source contains the Worker Host home directory`,
    );
  const first = relative(home, root).split(sep)[0];
  if (
    inside(root, home) &&
    (first?.startsWith(".") || first?.toLowerCase() === "library") &&
    (consentDirectory === undefined || !inside(consentDirectory, join(home, first)))
  )
    throw new VolumeCopyError(
      `Volume ${mount.volume} needs explicit host path consent for a home configuration directory`,
    );
  for (const directory of protectedDirectories) {
    const real = await realExistingPath(directory);
    if (overlaps(root, real))
      throw new VolumeCopyError(
        `Volume ${mount.volume} source directory ${path} overlaps ${directory}, which holds SuperTag's own state on this Worker Host; SuperTag copied nothing`,
      );
  }
  return root;
}

/**
 * The real path of `path`, or, when it does not exist yet, of its nearest existing ancestor with
 * the rest appended, so a protected directory behind a symbolic link is still compared by its
 * real location.
 */
async function realExistingPath(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  while (true) {
    try {
      return join(await realpath(current), ...rest.toReversed());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

async function* readFile(
  volume: string,
  root: string,
  key: string,
  identity: Pick<import("node:fs").BigIntStats, "dev" | "ino" | "size" | "ctimeNs" | "mtimeNs">,
  verifyRoot: () => Promise<void>,
): AsyncIterable<Uint8Array> {
  const changed = () =>
    new VolumeCopyError(
      `Volume ${volume} file ${JSON.stringify(key.slice(0, 200))} changed while it was copied`,
    );
  const path = join(root, ...key.split("/"));
  await verifyRoot();
  if (
    !(await realpath(path).then(
      (actual) => inside(actual, root),
      () => false,
    ))
  )
    throw changed();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw changed();
  });
  try {
    await verifyRoot();
    const verifyFile = async () => {
      const status = await handle.stat({ bigint: true });
      assertSingleLink(volume, key, status.nlink);
      if (
        !status.isFile() ||
        status.dev !== identity.dev ||
        status.ino !== identity.ino ||
        status.size !== identity.size ||
        status.ctimeNs !== identity.ctimeNs ||
        status.mtimeNs !== identity.mtimeNs
      )
        throw changed();
    };
    await verifyFile();
    if (
      !(await realpath(path).then(
        (actual) => inside(actual, root),
        () => false,
      ))
    )
      throw changed();
    // A link added and removed after listing leaves nlink=1 but changes ctime. Check the
    // opened inode and its change times before releasing any bytes, and after every read.
    const size = Number(identity.size);
    const bytes = new Uint8Array(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        0,
        Math.min(bytes.length, size - offset),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      await verifyFile();
      yield bytes.slice(0, bytesRead);
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
    if (offset !== size || extra.bytesRead !== 0) throw changed();
    await verifyFile();
    await verifyRoot();
  } finally {
    await handle.close();
  }
}

function assertSingleLink(volume: string, key: string, links: number | bigint): void {
  if (links > 1)
    throw new VolumeCopyError(
      `Volume ${volume} file ${JSON.stringify(key.slice(0, 200))} has more than one hard link; SuperTag refuses hard-linked source files`,
    );
}

/** A directory's device and inode, as decimal strings so a record survives JSON. */
export interface VerifiedDirectory {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

/**
 * A copy {@link HostVolumeCopyTarget} created, as {@link removeHostVolumeCopy} needs it: the
 * mount's literal path, its real path, and the device and inode of every directory from the
 * filesystem root down to the copy. Removal proves each one is still the directory SuperTag
 * verified before it touches anything.
 */
export interface HostVolumeCopy {
  readonly path: string;
  readonly realPath: string;
  /** From `/` down to `realPath`, inclusive. */
  readonly directories: readonly VerifiedDirectory[];
}

/** A {@link HostVolumeCopy} read back from a record, or undefined when it is not one. */
export function parseHostVolumeCopy(value: unknown): HostVolumeCopy | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { path, realPath, directories } = value as Record<string, unknown>;
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  if (typeof realPath !== "string" || !isAbsolute(realPath)) return undefined;
  if (!Array.isArray(directories) || directories.length === 0 || directories.length > 4096)
    return undefined;
  const parsed: VerifiedDirectory[] = [];
  for (const entry of directories) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { path: directory, dev, ino } = entry as Record<string, unknown>;
    if (typeof directory !== "string" || !isAbsolute(directory)) return undefined;
    if (typeof dev !== "string" || !/^\d+$/u.test(dev)) return undefined;
    if (typeof ino !== "string" || !/^\d+$/u.test(ino)) return undefined;
    parsed.push({ path: directory, dev, ino });
  }
  const expected = directoryPaths(realPath);
  if (
    expected.length !== parsed.length ||
    expected.some((directory, index) => parsed[index]?.path !== directory)
  )
    return undefined;
  return { path, realPath, directories: parsed };
}

/** Recheck destination rules at creation, after an earlier resolver check may have gone stale. */
async function assertHostCopyDestination(path: string): Promise<void> {
  const home = await realExistingPath(homedir());
  const first = relative(home, path).split(sep)[0];
  if (
    inside(home, path) ||
    (inside(path, home) && (first?.startsWith(".") || first?.toLowerCase() === "library"))
  )
    throw new VolumeCopyError(`Mount path ${path} resolves into a home configuration location`);
  if (isSensitiveWorkspaceMountPath(path))
    throw new VolumeCopyError(`Mount path ${path} resolves into a sensitive system location`);
}

interface HostCopyState {
  readonly literal: string;
  readonly real: string;
  /** The verified directories from `/` down to the mount directory, inclusive. */
  readonly chain: readonly VerifiedDirectory[];
  /** Directories SuperTag created below the mount directory, by key; "" is the mount directory. */
  readonly directories: Map<string, VerifiedDirectory>;
  /** Files SuperTag wrote, by key, with their device and inode. */
  readonly files: Map<string, { readonly dev: string; readonly ino: string }>;
}

/**
 * Copies onto the Worker Host's filesystem, for local Workspaces. The mount directory must not
 * exist; it is created here and sealed read-only.
 *
 * The literal path is resolved once, in {@link create}; every later step uses that real path, and
 * first re-checks the device and inode of every directory from `/` down to the one it writes in,
 * refusing when any of them was moved or replaced by a symbolic link. Files are opened
 * exclusively, without following links, and checked again before any byte is written. Node.js has
 * no directory-relative file operations, so a process that can write one of those directories
 * could still race a check. That is why a mount path inside a directory a sandboxed local Task can
 * write ({@link taskWritableRoots}, such as `/tmp` and `TMPDIR`) is refused outright.
 *
 * `forbidden` names paths the copy must not land in or contain, such as the Task's checkout.
 * `created` runs as soon as the mount directory exists and is verified, so a caller records only
 * directories SuperTag itself created, with what {@link removeHostVolumeCopy} needs.
 */
export class HostVolumeCopyTarget implements VolumeCopyTarget {
  readonly #copies = new Map<string, HostCopyState>();

  constructor(
    readonly forbidden: readonly string[] = [],
    readonly created?: (copy: HostVolumeCopy) => Promise<void>,
    readonly localMountRoot?: LocalMountRoot,
  ) {}

  async create(path: string): Promise<void> {
    await assertLocalMountDestination(path, this.localMountRoot);
    if (!isAbsolute(path)) throw new VolumeCopyError(`Mount path ${path} must be absolute`);
    const literal = resolve(path);
    if (literal === sep || this.#copies.has(literal))
      throw new VolumeCopyError(`Mount path ${path} cannot be created`);
    const writable = await taskWritableRealRoots();
    const refuseWritable = (candidate: string) => {
      const root = writable.find((directory) => inside(candidate, directory));
      if (root !== undefined)
        throw new VolumeCopyError(
          `Mount path ${path} is inside ${root}, a temporary directory a local Task can write; SuperTag copies local mounts only outside temporary directories`,
        );
    };
    refuseWritable(literal);
    const real = await realExistingPath(literal);
    const checkDestination = async () => {
      const canonical = (value: string) =>
        (this.localMountRoot?.foldCase ? value.toLowerCase() : value).normalize("NFC");
      if (canonical(await realExistingPath(literal)) !== canonical(real))
        throw new HostCopyChangedError(`Mount path ${path} changed while its copy was created`);
      refuseWritable(real);
      await assertLocalMountDestination(real, this.localMountRoot);
      await assertHostCopyDestination(real);
      for (const forbidden of this.forbidden) {
        const other = await realExistingPath(forbidden);
        if (
          overlaps(canonical(real), canonical(other)) ||
          overlaps(canonical(literal), canonical(resolve(forbidden)))
        )
          throw new VolumeCopyError(`Mount path ${path} resolves into ${forbidden}`);
      }
    };
    // Validate the entire destination before creating even its first missing ancestor.
    await checkDestination();
    const ancestors: VerifiedDirectory[] = [];
    for (const directory of directoryPaths(dirname(real))) {
      await verifyDirectories(ancestors, path);
      const exists = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (exists === undefined) {
        await checkDestination();
        const parent = ancestors.at(-1);
        if (parent === undefined) throw new VolumeCopyError(`Mount path ${path} has no parent`);
        await mkdirInVerifiedParent(parent, basename(directory), path);
      }
      ancestors.push(await verifiedDirectory(directory, path));
      await verifyDirectories(ancestors, path);
    }
    await checkDestination();
    await verifyDirectories(ancestors, path);
    const parent = ancestors.at(-1);
    if (parent === undefined) throw new VolumeCopyError(`Mount path ${path} has no parent`);
    await mkdirInVerifiedParent(parent, basename(real), path);
    await checkDestination();
    const root = await verifiedDirectory(real, path);
    await verifyDirectories(ancestors, path);
    const state: HostCopyState = {
      literal,
      real,
      chain: [...ancestors, root],
      directories: new Map([["", root]]),
      files: new Map(),
    };
    this.#copies.set(literal, state);
    await this.created?.({ path: literal, realPath: real, directories: state.chain });
  }

  async mkdir(path: string): Promise<void> {
    const { state, key, parentKey } = this.#locate(path);
    await this.#verify(state, parentKey, path);
    const real = join(state.real, ...key.split("/"));
    const parent = state.directories.get(parentKey);
    if (parent === undefined) throw new VolumeCopyError(`Mount path ${path} has no parent`);
    await mkdirInVerifiedParent(parent, basename(real), path);
    const directory = await verifiedDirectory(real, path);
    await this.#verify(state, parentKey, path);
    state.directories.set(key, directory);
  }

  async write(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const { state, key, parentKey } = this.#locate(path);
    await this.#verify(state, parentKey, path);
    const handle = await open(
      join(state.real, ...key.split("/")),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      const status = await handle.stat({ bigint: true });
      // The file was created in the directory SuperTag verified, or no byte is written.
      await this.#verify(state, parentKey, path);
      if (!status.isFile()) throw new VolumeCopyError(`Mount file ${path} is not a regular file`);
      for await (const chunk of chunks) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0)
            throw new VolumeCopyError(`Mount file ${path} could not be written`);
          offset += bytesWritten;
        }
      }
      state.files.set(key, { dev: String(status.dev), ino: String(status.ino) });
    } finally {
      await handle.close();
    }
  }

  /**
   * Refuses a copy holding anything SuperTag did not write, then removes write permission from
   * each file and directory through a handle opened without following links.
   */
  async seal(path: string): Promise<void> {
    const state = this.#copies.get(resolve(path));
    if (state === undefined) throw new VolumeCopyError(`Mount path ${path} was not created here`);
    for (const key of state.directories.keys()) {
      await this.#verify(state, key, path);
      const directory = join(state.real, ...(key === "" ? [] : key.split("/")));
      for (const name of await readdir(directory)) {
        const child = key === "" ? name : `${key}/${name}`;
        if (!state.directories.has(child) && !state.files.has(child))
          throw new VolumeCopyError(
            `Mount copy ${path} holds ${JSON.stringify(child.slice(0, 200))}, which SuperTag did not copy`,
          );
      }
    }
    for (const [key, identity] of state.files) {
      await this.#verify(state, parentOf(key), path);
      await chmodVerified(
        join(state.real, ...key.split("/")),
        identity,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o444,
        path,
      );
    }
    const directories = [...state.directories].toSorted(
      ([left], [right]) => depth(right) - depth(left),
    );
    for (const [key, directory] of directories) {
      await this.#verify(state, key === "" ? key : parentOf(key), path);
      await chmodVerified(
        directory.path,
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        0o555,
        path,
      );
    }
  }

  #locate(path: string): { state: HostCopyState; key: string; parentKey: string } {
    const target = resolve(path);
    for (const state of this.#copies.values()) {
      const below = relative(state.literal, target);
      if (below === "" || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below))
        continue;
      const key = below.split(sep).join("/");
      const parentKey = parentOf(key);
      if (!state.directories.has(parentKey))
        throw new VolumeCopyError(`Mount path ${path} is not below a directory SuperTag created`);
      return { state, key, parentKey };
    }
    throw new VolumeCopyError(`Mount path ${path} is not below a copy this target created`);
  }

  /** Re-checks every directory from `/` down to the directory at `key`. */
  async #verify(state: HostCopyState, key: string, path: string): Promise<void> {
    const chain = [...state.chain];
    if (key !== "") {
      const parts = key.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        const directory = state.directories.get(parts.slice(0, index).join("/"));
        if (directory === undefined)
          throw new VolumeCopyError(`Mount path ${path} is not below a directory SuperTag created`);
        chain.push(directory);
      }
    }
    await verifyDirectories(chain, path);
  }
}

/**
 * Node has no mkdirat. A short-lived Node child pins its cwd at spawn, checks that directory's
 * identity, then uses a single relative mkdir. An ancestor swapped for a symlink cannot redirect
 * that mkdir, even between the identity check and the syscall. No shell or extra runtime is used.
 */
async function mkdirInVerifiedParent(
  parent: VerifiedDirectory,
  name: string,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=commonjs", "-e", MKDIR_IN_PARENT, parent.dev, parent.ino, name],
      { cwd: parent.path, env: {}, stdio: "ignore", timeout: 10_000 },
    );
    child.once("error", () => reject(new VolumeCopyError(`Mount path ${label} cannot be created`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else if (code === 3)
        reject(
          new HostCopyChangedError(
            `Mount path ${label}: parent is no longer the directory SuperTag verified`,
          ),
        );
      else
        reject(
          new VolumeCopyError(
            code === 2
              ? `Mount path ${label} already exists, and SuperTag did not create it for this Task Attempt; remove it or choose another path`
              : `Mount path ${label} cannot be created`,
          ),
        );
    });
  });
}

const MKDIR_IN_PARENT = `
const fs = require("node:fs");
const [dev, ino, name] = process.argv.slice(1);
try {
  const parent = fs.statSync(".", { bigint: true });
  if (!parent.isDirectory() || String(parent.dev) !== dev || String(parent.ino) !== ino) process.exit(3);
  fs.mkdirSync(name, { mode: 0o755 });
} catch (error) { process.exit(error.code === "EEXIST" ? 2 : 4); }
`;

/**
 * Removes a copy {@link HostVolumeCopyTarget} made. Nothing is touched unless every directory from
 * `/` down to the copy is still the one SuperTag verified when it created it; otherwise this
 * throws a {@link VolumeCopyError} and leaves everything in place. Each directory is made writable
 * through a handle opened without following links, entries are removed only after their directory
 * is verified again, and a symbolic link inside the copy is removed itself, never followed.
 * Returns `absent` when the copy is already gone.
 */
export async function removeHostVolumeCopy(copy: HostVolumeCopy): Promise<"removed" | "absent"> {
  const root = copy.directories.at(-1);
  if (root === undefined || root.path !== copy.realPath)
    throw new HostCopyChangedError(`SuperTag has no verified record of the copy at ${copy.path}`);
  const ancestors = copy.directories.slice(0, -1);
  await verifyDirectories(ancestors, copy.path);
  const status = await lstat(root.path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (status === undefined) return "absent";
  await removeVerifiedTree(ancestors, root, copy.path);
  return "removed";
}

async function removeVerifiedTree(
  above: readonly VerifiedDirectory[],
  directory: VerifiedDirectory,
  label: string,
): Promise<void> {
  const chain = [...above, directory];
  await verifyDirectories(chain, label);
  await chmodVerified(
    directory.path,
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0o700,
    label,
  );
  const names = await readdir(directory.path);
  for (const name of names) {
    const child = join(directory.path, name);
    await verifyDirectories(chain, label);
    const status = await lstat(child, { bigint: true }).catch(() => undefined);
    if (status === undefined) continue;
    if (status.isDirectory())
      await removeVerifiedTree(
        chain,
        { path: child, dev: String(status.dev), ino: String(status.ino) },
        label,
      );
    else {
      await verifyDirectories(chain, label);
      await unlink(child).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  await verifyDirectories(chain, label);
  await rmdir(directory.path);
}

/** `/`, then each directory down to `real`, inclusive. */
function directoryPaths(real: string): string[] {
  const paths: string[] = [sep];
  let current = "";
  for (const part of real.split(sep).filter((segment) => segment !== "")) {
    current = `${current}${sep}${part}`;
    paths.push(current);
  }
  return paths;
}

async function verifiedDirectory(path: string, label: string): Promise<VerifiedDirectory> {
  const status = await lstat(path, { bigint: true }).catch(() => undefined);
  if (status === undefined || status.isSymbolicLink() || !status.isDirectory())
    throw new VolumeCopyError(
      `Mount path ${label} crosses ${path}, which is not a plain directory`,
    );
  return { path, dev: String(status.dev), ino: String(status.ino) };
}

async function verifyDirectories(
  chain: readonly VerifiedDirectory[],
  label: string,
): Promise<void> {
  for (const directory of chain) {
    const status = await lstat(directory.path, { bigint: true }).catch(() => undefined);
    if (
      status === undefined ||
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      String(status.dev) !== directory.dev ||
      String(status.ino) !== directory.ino
    )
      throw new HostCopyChangedError(
        `Mount path ${label}: ${directory.path} is no longer the directory SuperTag verified, so SuperTag stopped and left it in place`,
      );
  }
}

/** Changes the mode through a handle, after proving the handle is the expected file. */
async function chmodVerified(
  path: string,
  identity: { readonly dev: string; readonly ino: string },
  flags: number,
  mode: number,
  label: string,
): Promise<void> {
  const handle = await open(path, flags).catch((error: unknown) => {
    throw new VolumeCopyError(`Mount path ${label}: ${path} cannot be opened: ${message(error)}`);
  });
  try {
    const status = await handle.stat({ bigint: true });
    if (String(status.dev) !== identity.dev || String(status.ino) !== identity.ino)
      throw new HostCopyChangedError(
        `Mount path ${label}: ${path} is no longer what SuperTag created, so SuperTag left it in place`,
      );
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/** The real and literal forms of {@link taskWritableRoots} that exist on this host. */
async function taskWritableRealRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const root of taskWritableRoots()) {
    if (!isAbsolute(root)) continue;
    roots.add(resolve(root));
    const real = await realpath(root).catch(() => undefined);
    if (real !== undefined) roots.add(real);
  }
  return [...roots];
}

function parentOf(key: string): string {
  const index = key.lastIndexOf("/");
  return index === -1 ? "" : key.slice(0, index);
}

function depth(key: string): number {
  return key === "" ? 0 : key.split("/").length;
}

/**
 * Copies into a Task's sandbox through its provider-neutral file operations, from the Worker
 * Host: the provider receives file bytes, never the Volume's credential. The mount path, and
 * every directory above it, must not be a symbolic link and the path must not exist in the
 * sandbox, so content from a prepared environment never mixes in and nothing lands in the
 * checkout.
 */
export class SandboxVolumeCopyTarget implements VolumeCopyTarget {
  constructor(
    readonly sandbox: SandboxInstance,
    readonly timeoutMs = 60_000,
  ) {}

  /** Checks and creates the mount directory in one sandbox command, with an exclusive `mkdir`. */
  async create(path: string): Promise<void> {
    const result = await this.#run(CREATE, [path]);
    if (result.exitCode === 3)
      throw new VolumeCopyError(`Mount path ${path} crosses a symbolic link in the sandbox`);
    if (result.exitCode === 4)
      throw new VolumeCopyError(
        `Mount path ${path} already exists in the sandbox; a prepared environment must not hold mounted content`,
      );
    if (result.exitCode !== 0)
      throw new VolumeCopyError(`Mount path ${path} could not be created in the sandbox`);
  }

  async mkdir(path: string): Promise<void> {
    await this.sandbox.mkdir(path);
  }

  async write(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const process = await this.sandbox.start(
      {
        command: "python3",
        args: ["-c", STREAM_MOUNT_FILE, path],
        streamInput: true,
        timeoutMs: this.timeoutMs,
      },
      { onOutput() {} },
    );
    try {
      if (process.write === undefined || process.endInput === undefined)
        throw new VolumeCopyError(`Mount file ${path} cannot be streamed into this sandbox`);
      for await (const chunk of chunks) await process.write(chunk);
      await process.endInput();
      if ((await process.wait()).exitCode !== 0)
        throw new VolumeCopyError(`Mount file ${path} could not be copied into the sandbox`);
    } catch (error) {
      await process.terminate().catch(() => false);
      throw error;
    }
  }

  async seal(path: string): Promise<void> {
    await this.sandbox.makeReadOnly(path);
  }

  async #run(script: string, args: readonly string[]): Promise<{ exitCode: number | null }> {
    const process = await this.sandbox.start(
      {
        command: "sh",
        args: ["-c", script, "sh", ...args],
        environment: { LC_ALL: "C" },
        timeoutMs: this.timeoutMs,
      },
      { onOutput() {} },
    );
    return process.wait();
  }
}

/** Open each ancestor without following links, then consume stdin in bounded chunks. */
const STREAM_MOUNT_FILE = [
  "import os, sys",
  "parts = sys.argv[1].split('/')",
  "assert parts[0] == '' and all(p and p not in ('.', '..') for p in parts[1:])",
  "flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW",
  "parent = os.open('/', flags)",
  "try:",
  "  for part in parts[1:-1]:",
  "    child = os.open(part, flags, dir_fd=parent)",
  "    os.close(parent)",
  "    parent = child",
  "  out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)",
  "  with os.fdopen(out, 'wb') as file:",
  "    while True:",
  "      chunk = sys.stdin.buffer.read(65536)",
  "      if not chunk: break",
  "      file.write(chunk)",
  "finally:",
  "  os.close(parent)",
].join("\n");

/**
 * Creates the directory $1. Exits 3 when a component of $1 is a symbolic link, before or after
 * the parent and the directory are created, and 4 when $1 already exists; the final `mkdir` is
 * exclusive, so nothing that appears between the check and the creation is reused.
 */
const CREATE = [
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'path="$1"',
  "links() {",
  '  current=""',
  '  rest="${path#/}"',
  '  while [ -n "$rest" ]; do',
  '    part="${rest%%/*}"',
  '    if [ "$part" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi',
  '    current="$current/$part"',
  '    if [ -L "$current" ]; then exit 3; fi',
  "  done",
  "}",
  "links",
  'if [ -e "$path" ]; then exit 4; fi',
  'parent="${path%/*}"',
  'if [ -n "$parent" ]; then mkdir -p -- "$parent" || exit 5; fi',
  "links",
  'if ! mkdir -m 755 -- "$path" 2>/dev/null; then',
  '  if [ -e "$path" ] || [ -L "$path" ]; then exit 4; fi',
  "  exit 5",
  "fi",
  "links",
  "exit 0",
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: shell parameter expansion
].join("\n");

/** Whether `child` is `parent` or below it. */
function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Removes credential values from text that came back from an object store. */
function redact(text: string, credentials: VolumeCredentials): string {
  let result = text;
  for (const value of [
    credentials.secretAccessKey,
    credentials.sessionToken,
    credentials.accessKeyId,
  ])
    if (value) result = result.split(value).join("[redacted]");
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
