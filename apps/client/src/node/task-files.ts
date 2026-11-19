/**
 * A Task's files, read where they live. The Control Plane's `TaskFiles.Locate` says where a
 * running Task's checkout is; when it is on this machine (the caller presents its own machine
 * identifier), the app lists and reads the directory itself. No file content ever crosses the
 * Control Plane. Everything is read-only: text files open in a viewer, binary files are listed
 * only, and nothing outside the located root, nothing under `.git`, and no symbolic link is
 * followed.
 */
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { TaskFileLocation } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { TaskFileEntry, TaskFilesPlace } from "../model/gateway";
import { compact } from "./convert";

/** The largest file the viewer shows. */
const MAX_VIEW_BYTES = 1024 * 1024;
/** How much of a file is checked for a NUL byte. */
const SNIFF_BYTES = 8 * 1024;
/** The most entries one directory listing returns. */
const MAX_ENTRIES = 1000;
/** Extensions that are binary whatever their bytes look like. */
const BINARY_EXTENSIONS = new Set(
  "png jpg jpeg gif webp ico icns bmp tiff pdf zip gz tgz bz2 xz zst 7z rar tar jar class so dylib dll exe o a wasm bin dat db sqlite sqlite3 woff woff2 ttf otf mp3 mp4 mov avi wav flac ogg psd sketch".split(
    " ",
  ),
);
const NOT_HERE = "This Task's files aren't on this machine.";
const OUTSIDE = "That path is outside the Task's files.";

/**
 * The roots `Locate` gave this app, by connection and Task. Listing and reading resolve only
 * beneath one of these, so the window can't name another directory.
 */
const roots = new Map<string, string>();
const rootKey = (connection: string, task: string) => `${connection}\u0000${task}`;

function remember(connection: string, task: string, root: string | undefined) {
  if (root === undefined) roots.delete(rootKey(connection, task));
  else roots.set(rootKey(connection, task), root);
}

function rootOf(connection: string, task: string): string {
  const root = roots.get(rootKey(connection, task));
  if (root === undefined) throw NOT_HERE;
  return root;
}

/** Where a Task's files are, from its first location, remembering a local root. */
export async function place(
  connection: string,
  task: string,
  location: TaskFileLocation | undefined,
): Promise<TaskFilesPlace> {
  if (location === undefined) {
    remember(connection, task, undefined);
    return {
      local: false,
      live: false,
      reason: "SuperTag doesn't know where this Task's files are.",
    };
  }
  // A local path counts only when it is a directory this user can open here.
  let root: string | undefined;
  if (location.kind.case === "localPath") {
    try {
      const resolved = await fs.realpath(location.kind.value.path);
      if ((await fs.stat(resolved)).isDirectory()) root = resolved;
    } catch {
      root = undefined;
    }
  }
  let reason = "";
  if (root === undefined) {
    reason =
      location.kind.case === "localPath"
        ? `Files on Worker Host ${location.hostId} are unreachable from here.`
        : location.unavailableReason;
  }
  remember(connection, task, root);
  return compact({
    local: root !== undefined,
    live: location.live,
    hostId: location.hostId === "" ? undefined : location.hostId,
    reason: reason === "" ? undefined : reason,
  } as TaskFilesPlace);
}

/** `relative` resolved beneath `root`, refusing absolute paths, `..`, `.git`, and any link. */
async function resolve(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw OUTSIDE;
  let resolved = root;
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." || part === ".git") throw OUTSIDE;
    resolved = path.join(resolved, part);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(resolved);
    } catch {
      throw "That file is no longer there.";
    }
    if (metadata.isSymbolicLink()) throw "Links aren't followed.";
  }
  return resolved;
}

function binaryName(name: string): boolean {
  const extension = path.extname(name).slice(1).toLowerCase();
  return extension !== "" && BINARY_EXTENSIONS.has(extension);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
function utf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Whether the first bytes look like text: no NUL, and valid UTF-8 up to a cut character. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  if (utf8(bytes)) return true;
  // A sample may end inside a character: a lead byte with fewer continuation bytes than it needs.
  for (let cut = 1; cut <= 3 && cut <= bytes.length; cut++) {
    const lead = bytes[bytes.length - cut] as number;
    if ((lead & 0xc0) === 0x80) continue;
    const needs = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
    return needs > cut && lead < 0xf5 && utf8(bytes.subarray(0, bytes.length - cut));
  }
  return false;
}

/** Opens a file without following a link, or blocking on a special file. */
function openRegular(file: string) {
  return fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => {
      throw "That file can't be opened.";
    });
}

async function sniff(file: string): Promise<boolean> {
  try {
    const handle = await openRegular(file);
    try {
      const sample = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(sample, 0, SNIFF_BYTES, 0);
      return looksLikeText(sample.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Lists one directory of the Task's files: directories first, then by name. */
export async function list(
  connection: string,
  task: string,
  relative: string,
): Promise<TaskFileEntry[]> {
  const directory = await resolve(rootOf(connection, task), relative);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    throw "That folder can't be read.";
  }
  const prefix = relative
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  const entries: TaskFileEntry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES + 1)) {
    if (name === ".git") continue;
    const file = path.join(directory, name);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(file);
    } catch {
      continue;
    }
    const kind = metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : "file";
    entries.push({
      name,
      path: prefix === "" ? name : `${prefix}/${name}`,
      kind,
      size: metadata.size,
      modifiedMs: Math.max(0, Math.floor(metadata.mtimeMs)),
      text: kind === "file" && !binaryName(name) && (await sniff(file)),
    });
  }
  entries.length = Math.min(entries.length, MAX_ENTRIES);
  const lower = (value: string) => value.toLowerCase();
  entries.sort(
    (a, b) =>
      Number(a.kind !== "directory") - Number(b.kind !== "directory") ||
      (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0),
  );
  return entries;
}

/** Reads one text file of the Task's files for the viewer. Binary files are refused. */
export async function read(
  connection: string,
  task: string,
  relative: string,
): Promise<{ path: string; text: string; size: number }> {
  const file = await resolve(rootOf(connection, task), relative);
  if (binaryName(path.basename(file))) throw "Binary files are listed only.";
  const handle = await openRegular(file);
  try {
    let metadata: Awaited<ReturnType<typeof handle.stat>>;
    try {
      metadata = await handle.stat();
    } catch {
      throw "That file can't be opened.";
    }
    if (!metadata.isFile()) throw "Only files open in the viewer.";
    if (metadata.size > MAX_VIEW_BYTES) {
      throw "This file is larger than 1 MiB, too large for the viewer.";
    }
    const buffer = Buffer.alloc(MAX_VIEW_BYTES);
    let length = 0;
    try {
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
    } catch {
      throw "That file can't be read.";
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0) || !utf8(bytes)) throw "Binary files are listed only.";
    return { path: relative, text: bytes.toString("utf8"), size: metadata.size };
  } finally {
    await handle.close();
  }
}

/** The absolute path of one of the Task's files, to reveal it in Finder. */
export function absolute(connection: string, task: string, relative: string): Promise<string> {
  return resolve(rootOf(connection, task), relative);
}
