import { createHash } from "node:crypto";

/** Bytes one Workspace copy transfer step writes into or reads from the sandbox. */
const COPY_PART = 8 * 1024 * 1024;
/** Record bytes one transfer step carries, so many small files and directories still fit. */
const COPY_BATCH = 1024 * 1024;
/**
 * One copy's limits, as the Worker Host's: 20 GiB, 10,000 files and 40,000 entries staged,
 * 20,000 files listed.
 */
const MAX_COPY_BYTES = 20 * 1024 ** 3;
const MAX_COPY_FILES = 10_000;
const MAX_COPY_ENTRIES = 40_000;
const MAX_COPY_LISTED = 2 * MAX_COPY_FILES;
const MAX_COPY_SCAN = 32 * 1024 * 1024;
/** A read-only copy's longest key: 32 directories and a file name, 255 bytes each. */
const MAX_READ_ONLY_KEY = 33 * 256;
const TRANSFER_TIMEOUT_MS = 120_000;
/** The slowest copy step a sandbox may take, as the Worker Host waits: one second per MiB. */
const MIN_COPY_RATE = 1024 * 1024;

/** One copy step's timeout: the transfer timeout plus one second per MiB it reads or hashes. */
function copyTimeout(bytes: number): number {
  return TRANSFER_TIMEOUT_MS + Math.floor(bytes / MIN_COPY_RATE) * 1000;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file of a Workspace copy: its Volume-relative key, exact length and SHA-256. */
export interface CopyFile {
  readonly key: string;
  readonly size: bigint;
  readonly sha256: string;
}

export type CopyUploadPart =
  | { readonly case: "file"; readonly value: CopyFile }
  | { readonly case: "payload"; readonly value: Uint8Array }
  | { readonly case: "directory"; readonly value: string };

export type CopyDownloadPart =
  | { readonly case: "file"; readonly value: CopyFile }
  | {
      readonly case: "listed";
      readonly value: { skipped: bigint; errorKey: string; errorReason: string };
    }
  | { readonly case: "payload"; readonly value: Uint8Array };

/** The Worker Host's Volume key rules: what a Volume can hold and a checkout can name. */
export function volumeKey(key: string): boolean {
  return (
    key.length > 0 &&
    Buffer.byteLength(key) <= 1024 &&
    !/[\\\p{Cc}]/u.test(key) &&
    key
      .split("/")
      .every((part) => !["", ".", "..", ".git"].includes(part) && !part.startsWith(".supertag-"))
  );
}

/**
 * What a read-only copy may name: any path the Worker Host copies from a `file://` Volume, which
 * only Volume keys may be written back to.
 */
function readOnlyKey(key: string): boolean {
  return (
    key.length > 0 &&
    Buffer.byteLength(key) <= MAX_READ_ONLY_KEY &&
    !key.includes("\0") &&
    key
      .split("/")
      .every(
        (part) =>
          !["", ".", "..", ".git"].includes(part) &&
          !part.startsWith(".supertag-") &&
          Buffer.byteLength(part) <= 255,
      )
  );
}

export function copyRoot(attemptId: string): string {
  return `volumes/${createHash("sha256").update(attemptId).digest("hex")}`;
}

/** What copies need of a sandbox: one command, and files beside its checkout. */
export interface CopySandbox {
  run(
    argv: string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
  writeTransfer(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readTransfer(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export function cleanCommand(...args: string[]): string[] {
  return ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", ...args];
}

/** Exactly `byteLength` bytes of a sandbox transfer file. */
export async function readTransfer(
  sandbox: Pick<CopySandbox, "readTransfer">,
  path: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stream = await sandbox.readTransfer(path, signal);
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const bytes = new Uint8Array(byteLength);
  try {
    let offset = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - offset)
        throw new Error("Workspace tree exceeds its receipt");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== byteLength) throw new Error("Workspace tree is shorter than its receipt");
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * One Attempt's Workspace copies in a sandbox whose checkout is `<root>/checkout`. Each copy is
 * staged beside the checkout in bounded parts, checked file by file against its SHA-256, and
 * only then sealed and moved to `volumes/<SHA-256 of the Attempt ID>/<name>` in the checkout.
 * After capture, a read-write copy's changed and created files stream back.
 */
export function createWorkspaceCopies(options: {
  readonly sandbox: CopySandbox;
  readonly root: string;
  readonly attemptId: string;
  /** The provider's name, which starts each error it reports. */
  readonly label: string;
  /** Ends with the session. */
  readonly lifetime: AbortSignal;
}) {
  const { sandbox, root } = options;
  const fail = (message: string) => new Error(`${options.label} Workspace ${message}`);
  const signalFor = (caller: AbortSignal | undefined, timeoutMs: number) =>
    AbortSignal.any([
      options.lifetime,
      AbortSignal.timeout(timeoutMs),
      ...(caller ? [caller] : []),
    ]);
  const copies = new Map<
    string,
    { readonly readWrite: boolean; readonly files: ReadonlyMap<string, CopyFile> }
  >();
  let inFlight = false;
  let index = 0;

  async function run(args: string[], timeoutMs: number, signal: AbortSignal) {
    const result = await sandbox.run(
      cleanCommand(
        "python3",
        "-I",
        "-S",
        "-c",
        COPY_PROGRAM,
        args[0] as string,
        root,
        ...args.slice(1),
      ),
      timeoutMs,
      signal,
    );
    const stdout = result.stdout.trim();
    if (result.exitCode !== 0 || stdout.length > 256)
      throw fail("copy transfer failed in the sandbox");
    return stdout;
  }

  function copyPath(path: string): string {
    const prefix = `${copyRoot(options.attemptId)}/`;
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    if (
      !name ||
      name.includes("/") ||
      name.startsWith(".") ||
      Buffer.byteLength(name) > 255 ||
      /[\\\p{Cc}]/u.test(name)
    )
      throw fail("copy path is invalid");
    return path;
  }

  function claim() {
    if (inFlight) throw fail("copy transfer is already running");
    inFlight = true;
  }

  return {
    /** The checkout-relative root of every copy, once one is staged. */
    root: () => (copies.size ? copyRoot(options.attemptId) : undefined),
    /** Each staged read-only copy's checkout-relative path. */
    readOnly: () => [...copies].filter(([, copy]) => !copy.readWrite).map(([path]) => path),

    async stage(
      header: { path: string; readWrite: boolean },
      parts: AsyncIterable<CopyUploadPart>,
      caller?: AbortSignal,
    ): Promise<{ files: bigint }> {
      const path = copyPath(header.path);
      if (copies.has(path)) throw fail("copy is already staged");
      claim();
      // A failed copy may leave a staging directory; each attempt stages into its own.
      const staging = String(index++);
      const writable = header.readWrite ? "1" : "0";
      const validKey = header.readWrite ? volumeKey : readOnlyKey;
      const files = new Map<string, CopyFile>();
      try {
        let buffer: Uint8Array[] = [];
        let buffered = 0;
        type Entry =
          | { key: string; size: number; sha256: string; offset: number; length: number }
          | { key: string; directory: true };
        let batch: Entry[] = [];
        let batchBytes = 0;
        // Bytes the sandbox hashes again when this batch completes its files.
        let completing = 0;
        let current: { file: CopyFile; offset: number; size: number } | undefined;
        let total = 0;
        let entries = 0;
        let sequence = 0;
        const flush = async () => {
          if (!batch.length) return;
          const signal = signalFor(caller, copyTimeout(buffered + completing));
          // Each part has its own names, so a failed part leaves nothing a later one reuses.
          const part = String(sequence++);
          await sandbox.writeTransfer(
            `${root}/copy-${staging}-${part}.part`,
            Buffer.concat(buffer),
            signal,
          );
          await sandbox.writeTransfer(
            `${root}/copy-${staging}-${part}.json`,
            Buffer.from(JSON.stringify(batch)),
            signal,
          );
          if (
            (await run(
              ["copy-append", staging, part, writable],
              copyTimeout(buffered + completing),
              signal,
            )) !== "appended"
          )
            throw fail("copy part could not be written");
          buffer = [];
          buffered = 0;
          batch = [];
          batchBytes = 0;
          completing = 0;
        };
        const record = (length: number) => {
          if (!current) throw fail("copy bytes precede their file");
          const last = batch.at(-1);
          if (last && "offset" in last && last.key === current.file.key) last.length += length;
          else {
            batch.push({
              key: current.file.key,
              size: current.size,
              sha256: current.file.sha256,
              offset: current.offset,
              length,
            });
            batchBytes += JSON.stringify(current.file.key).length * 3 + 160;
          }
          current.offset += length;
          if (current.offset === current.size) completing += current.size;
        };
        const complete = () => {
          if (current && current.offset !== current.size)
            throw fail("copy file is shorter than its record");
        };
        for await (const part of parts) {
          caller?.throwIfAborted();
          options.lifetime.throwIfAborted();
          if (part.case === "file") {
            complete();
            const { key, size, sha256 } = part.value;
            total += Number(size);
            entries++;
            if (
              !validKey(key) ||
              files.has(key) ||
              size < 0n ||
              size > BigInt(MAX_COPY_BYTES) ||
              total > MAX_COPY_BYTES ||
              files.size >= MAX_COPY_FILES ||
              entries > MAX_COPY_ENTRIES ||
              !/^[0-9a-f]{64}$/u.test(sha256)
            )
              throw fail("copy file record is invalid");
            files.set(key, part.value);
            current = { file: part.value, offset: 0, size: Number(size) };
            // An empty file is complete as soon as it is recorded.
            if (current.size === 0) record(0);
          } else if (part.case === "directory") {
            complete();
            current = undefined;
            entries++;
            if (!validKey(part.value) || entries > MAX_COPY_ENTRIES)
              throw fail("copy directory record is invalid");
            batch.push({ key: part.value, directory: true });
            batchBytes += JSON.stringify(part.value).length * 3 + 32;
          } else {
            const bytes = part.value;
            if (!current || !bytes.byteLength || bytes.byteLength > current.size - current.offset)
              throw fail("copy bytes differ from their record");
            buffer.push(bytes);
            buffered += bytes.byteLength;
            record(bytes.byteLength);
          }
          if (buffered >= COPY_PART || batchBytes >= COPY_BATCH) await flush();
        }
        complete();
        await flush();
        if (
          (await run(
            ["copy-seal", staging, path, writable],
            TRANSFER_TIMEOUT_MS,
            signalFor(caller, TRANSFER_TIMEOUT_MS),
          )) !== "sealed"
        )
          throw fail("copy could not be sealed");
        copies.set(path, { readWrite: header.readWrite, files });
        return { files: BigInt(files.size) };
      } catch (error) {
        throw error instanceof Error && error.message.startsWith(options.label)
          ? error
          : fail("copy could not be staged");
      } finally {
        inFlight = false;
      }
    },

    /**
     * Lists a read-write copy in the sandbox and streams its changed and created regular files:
     * their records, the summary, then their bytes in record order. A refusal the listing found
     * ends the stream after the summary. The listing reads at most the staged bytes and
     * `maxBytes`, so its timeout scales with both.
     */
    async *capture(
      request: { path: string; maxBytes: bigint },
      caller?: AbortSignal,
    ): AsyncGenerator<CopyDownloadPart> {
      const copy = copies.get(copyPath(request.path));
      if (!copy?.readWrite) throw fail("copy is not a staged read-write copy");
      if (request.maxBytes <= 0n || request.maxBytes > BigInt(MAX_COPY_BYTES))
        throw fail("copy byte limit is invalid");
      claim();
      try {
        const maxBytes = Number(request.maxBytes);
        const timeout = copyTimeout(2 * maxBytes);
        const signal = signalFor(caller, timeout);
        const receipt = /^([0-9]{1,9}) ([0-9a-f]{64})$/u.exec(
          await run(["copy-scan", request.path, String(maxBytes)], timeout, signal),
        );
        const length = Number(receipt?.[1]);
        if (!receipt || length < 2 || length > MAX_COPY_SCAN)
          throw fail("copy listing has no receipt");
        const bytes = await readTransfer(sandbox, `${root}/copy-scan.json`, length, signal);
        if (digest(bytes) !== receipt[2]) throw fail("copy listing differs");
        const scan = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
          files: { key: string; size: number; sha256: string }[];
          others: number;
          refusal: [string, string] | null;
        };
        if (
          !Array.isArray(scan.files) ||
          scan.files.length > MAX_COPY_LISTED ||
          !Number.isSafeInteger(scan.others) ||
          scan.others < 0
        )
          throw fail("copy listing is invalid");
        let skipped = BigInt(scan.others);
        const changed: CopyFile[] = [];
        for (const file of scan.files) {
          if (
            !volumeKey(file.key) ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            !/^[0-9a-f]{64}$/u.test(file.sha256)
          )
            throw fail("copy listing is invalid");
          const staged = copy.files.get(file.key);
          if (staged && staged.size === BigInt(file.size) && staged.sha256 === file.sha256)
            skipped++;
          else changed.push({ key: file.key, size: BigInt(file.size), sha256: file.sha256 });
        }
        changed.sort((left, right) =>
          Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)),
        );
        for (const file of changed) yield { case: "file", value: file };
        const [errorKey, errorReason] = scan.refusal ?? ["", ""];
        yield { case: "listed", value: { skipped, errorKey, errorReason } };
        if (scan.refusal) return;
        for (const file of changed) {
          for (let offset = 0n; offset < file.size; ) {
            const step =
              file.size - offset < BigInt(COPY_PART) ? file.size - offset : BigInt(COPY_PART);
            const partSignal = signalFor(caller, TRANSFER_TIMEOUT_MS);
            const read = await run(
              ["copy-read", request.path, file.key, String(offset), String(step)],
              TRANSFER_TIMEOUT_MS,
              partSignal,
            );
            if (read !== String(step)) throw fail("copy file changed");
            const part = await readTransfer(sandbox, `${root}/copy-out`, Number(step), partSignal);
            for (let start = 0; start < part.byteLength; start += 256 * 1024)
              yield { case: "payload", value: part.subarray(start, start + 256 * 1024) };
            offset += step;
          }
        }
      } finally {
        inFlight = false;
      }
    },
  };
}

export type WorkspaceCopies = ReturnType<typeof createWorkspaceCopies>;

// Run only trusted copy code in the sandbox. Copies live beside the checkout until sealed, are
// written without following links, and every completed file is checked against its SHA-256.
const COPY_PROGRAM = String.raw`import hashlib, json, os, stat, sys, unicodedata

CHUNK = 65536
PART = ${COPY_PART}
MAX_DEPTH = 32
MAX_WALK = 80000
MAX_FILES = 20000
MAX_STAGED = ${MAX_COPY_FILES}
MAX_WRITE_FILE = 5 * 1024 ** 3
MAX_READ_ONLY_KEY = ${MAX_READ_ONLY_KEY}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
UNNAMEABLE = "a file name cannot be written to the Volume"
TOO_LARGE = "a file exceeds the copy byte limit or 5 GiB"
OVER_LIMIT = "change set exceeds the copy byte limit"
os.umask(0o077)
mode, root = sys.argv[1:3]
checkout = os.path.join(root, "checkout")

def check(condition):
    if not condition:
        raise ValueError("invalid Workspace copy transfer")

def reserved(part):
    return part in ("", ".", "..", ".git") or part.startswith(".supertag-")

def volume_key(key):
    return (0 < len(key.encode("utf-8")) <= 1024 and "\\" not in key and
            not any(unicodedata.category(c) == "Cc" for c in key) and
            not any(reserved(part) for part in key.split("/")))

def read_only_key(key):
    return (0 < len(key.encode("utf-8")) <= MAX_READ_ONLY_KEY and "\0" not in key and
            not any(reserved(part) or len(part.encode("utf-8")) > 255 for part in key.split("/")))

def copy_path(path):
    parts = path.split("/")
    check(len(parts) == 3 and parts[0] == "volumes" and len(parts[1]) == 64 and
          all(c in "0123456789abcdef" for c in parts[1]) and parts[2] and
          not parts[2].startswith(".") and volume_key(parts[2]))
    return parts

def open_dirs(fd, parts, create):
    fd = os.dup(fd)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def file_hash(fd):
    digest = hashlib.sha256()
    length = 0
    while data := os.read(fd, CHUNK):
        length += len(data)
        digest.update(data)
    return length, digest.hexdigest()

def staging(index):
    check(index.isdigit() and len(index) <= 4)
    return os.path.join(root, "copies", index)

def staged_list(index):
    return os.path.join(root, "copies", index + ".staged")

def sealed_list(name):
    # Outside "copies", so no copy name can meet a staging index.
    return os.path.join(root, "copies-staged", name)

def append(index, sequence, writable):
    os.makedirs(staging(index), mode=0o700, exist_ok=True)
    check(sequence.isdigit() and len(sequence) <= 6 and writable in ("0", "1"))
    valid = volume_key if writable == "1" else read_only_key
    batch_path = os.path.join(root, "copy-%s-%s.json" % (index, sequence))
    part_path = os.path.join(root, "copy-%s-%s.part" % (index, sequence))
    with open(batch_path, "rb") as source:
        raw = source.read(4 * 1024 * 1024 + 1)
    check(len(raw) <= 4 * 1024 * 1024)
    batch = json.loads(raw)
    base = os.open(staging(index), DIR_FLAGS)
    completed = []
    try:
        with open(part_path, "rb") as part:
            for record in batch:
                key = record["key"]
                check(type(key) is str and valid(key))
                if record.get("directory") is True:
                    check(len(key.split("/")) <= MAX_DEPTH)
                    os.close(open_dirs(base, key.split("/"), True))
                    continue
                size, offset, length = record["size"], record["offset"], record["length"]
                check(all(type(value) is int and value >= 0 for value in (size, offset, length)))
                check(offset + length <= size)
                *parents, name = key.split("/")
                check(len(parents) <= MAX_DEPTH)
                directory = open_dirs(base, parents, True)
                try:
                    # Read and write: a completed file is hashed through the same descriptor.
                    flags = os.O_RDWR | os.O_NOFOLLOW
                    flags |= os.O_CREAT | os.O_EXCL if offset == 0 else os.O_APPEND
                    fd = os.open(name, flags, 0o600, dir_fd=directory)
                finally:
                    os.close(directory)
                try:
                    info = os.fstat(fd)
                    check(stat.S_ISREG(info.st_mode) and info.st_size == offset)
                    remaining = length
                    while remaining:
                        data = part.read(min(CHUNK, remaining))
                        check(bool(data))
                        os.write(fd, data)
                        remaining -= len(data)
                    if offset + length == size:
                        os.lseek(fd, 0, os.SEEK_SET)
                        check(file_hash(fd) == (size, record["sha256"]))
                        completed.append([key, size, record["sha256"]])
                finally:
                    os.close(fd)
            check(not part.read(1))
    finally:
        os.close(base)
    if writable == "1" and completed:
        # What a read-write copy staged, so its listing reads no more than its limit allows.
        with open(staged_list(index), "a", encoding="utf-8") as output:
            for entry in completed:
                output.write(json.dumps(entry, ensure_ascii=False) + "\n")
    os.unlink(part_path)
    os.unlink(batch_path)
    print("appended")

def seal(index, path, writable):
    _, digest, name = copy_path(path)
    check(writable in ("0", "1"))
    source = staging(index)
    os.makedirs(source, mode=0o700, exist_ok=True)
    file_mode, directory_mode = (0o600, 0o700) if writable == "1" else (0o400, 0o500)
    # The staging tree holds only what append wrote: directories and regular files.
    for directory, names, files in os.walk(source, topdown=False):
        for file in files:
            os.chmod(os.path.join(directory, file), file_mode)
        if directory != source:
            os.chmod(directory, directory_mode)
    if writable == "1":
        os.makedirs(os.path.dirname(sealed_list(name)), mode=0o700, exist_ok=True)
        if os.path.lexists(staged_list(index)):
            os.replace(staged_list(index), sealed_list(name))
        else:
            open(sealed_list(name), "w").close()
    checkout_fd = os.open(checkout, DIR_FLAGS)
    try:
        parent = open_dirs(checkout_fd, ("volumes", digest), True)
        try:
            check(name not in os.listdir(parent))
            # Moving a directory to another parent needs write access to it, so the copy root
            # is sealed last.
            os.rename(source, name, dst_dir_fd=parent)
            os.chmod(name, directory_mode, dir_fd=parent)
        finally:
            os.close(parent)
    finally:
        os.close(checkout_fd)
    print("sealed")

def scan(path, max_bytes):
    _, _, copy_name = copy_path(path)
    check(max_bytes.isdigit())
    max_bytes = int(max_bytes)
    file_limit = min(max_bytes, MAX_WRITE_FILE)
    staged = {}
    with open(sealed_list(copy_name), "r", encoding="utf-8") as source:
        for line in source:
            key, size, sha256 = json.loads(line)
            check(len(staged) < MAX_STAGED and type(size) is int)
            staged[key] = (size, sha256)
    files = []
    others = 0
    visited = 0
    changed = 0
    refusal = None

    def refuse(key, reason):
        nonlocal refusal
        if refusal is None:
            refusal = [key, reason]

    def walk(fd, prefix, depth):
        nonlocal others, visited, changed
        for raw in sorted(os.fsencode(name) for name in os.listdir(fd)):
            if refusal is not None:
                return
            try:
                name = raw.decode("utf-8")
            except UnicodeDecodeError:
                refuse(prefix, UNNAMEABLE)
                return
            key = name if not prefix else prefix + "/" + name
            if not volume_key(key):
                refuse(prefix, UNNAMEABLE)
                return
            visited += 1
            if visited > MAX_WALK:
                refuse(key, "the copy holds too many entries to write back")
                return
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                if depth >= MAX_DEPTH:
                    refuse(key, "the copy nests directories too deeply")
                    return
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try:
                    walk(child, key, depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1:
                    refuse(key, "a file has another link or changed")
                    return
                if len(files) >= MAX_FILES:
                    refuse(key, "the copy holds too many files to write back")
                    return
                before = staged.get(key)
                same_size = before is not None and before[0] == info.st_size
                # A change that cannot be written is refused without reading it. Only files
                # staged at their current size are read beyond the copy's limit, and the
                # staged bytes are within it.
                if not same_size:
                    if info.st_size > file_limit:
                        refuse(key, TOO_LARGE)
                        return
                    if changed + info.st_size > max_bytes:
                        refuse(key, OVER_LIMIT)
                        return
                fd_file = os.open(name, FILE_FLAGS, dir_fd=fd)
                try:
                    size, sha256 = file_hash(fd_file)
                finally:
                    os.close(fd_file)
                if before != (size, sha256):
                    changed += size
                    if size > file_limit:
                        refuse(key, TOO_LARGE)
                        return
                    if changed > max_bytes:
                        refuse(key, OVER_LIMIT)
                        return
                files.append({"key": key, "size": size, "sha256": sha256})
            else:
                others += 1

    base = os.open(checkout, DIR_FLAGS)
    try:
        fd = open_dirs(base, path.split("/"), False)
    finally:
        os.close(base)
    try:
        walk(fd, "", 0)
    finally:
        os.close(fd)
    body = json.dumps({"files": files, "others": others, "refusal": refusal},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    destination = os.path.join(root, "copy-scan.json")
    with open(destination, "wb") as output:
        output.write(body)
    print(len(body), hashlib.sha256(body).hexdigest())

def read(path, key, offset, length):
    copy_path(path)
    check(volume_key(key))
    offset, length = int(offset), int(length)
    check(0 <= offset and 0 < length <= PART)
    *parents, name = key.split("/")
    base = os.open(checkout, DIR_FLAGS)
    try:
        directory = open_dirs(base, path.split("/") + parents, False)
    finally:
        os.close(base)
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and offset + length <= info.st_size)
        os.lseek(fd, offset, os.SEEK_SET)
        with open(os.path.join(root, "copy-out"), "wb") as output:
            remaining = length
            while remaining:
                data = os.read(fd, min(CHUNK, remaining))
                check(bool(data))
                output.write(data)
                remaining -= len(data)
    finally:
        os.close(fd)
    print(length)

try:
    if mode == "copy-append":
        append(*sys.argv[3:])
    elif mode == "copy-seal":
        seal(*sys.argv[3:])
    elif mode == "copy-scan":
        scan(*sys.argv[3:])
    elif mode == "copy-read":
        read(*sys.argv[3:])
    else:
        raise ValueError("unknown copy transfer")
except Exception:
    sys.exit(1)`;
