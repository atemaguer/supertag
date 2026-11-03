import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ArtifactHarnessSession,
  type ArtifactSelection,
  type TaskResult,
  validateArtifactHarnessSession,
  validateArtifactPath,
} from "@supertag/core";
import {
  type ArtifactCatalogTransport,
  ArtifactClient,
  ArtifactHttpError,
  ArtifactRequestError,
} from "./artifact-client.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { SessionStateRef, TaskAttemptEvent, TaskAttemptSpec } from "./index.js";

export interface OutputFinalizationGroup {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly submit: boolean;
}

export interface OutputFinalizationRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly blocked?: string;
  readonly spec: TaskAttemptSpec;
  readonly specDigest: string;
  readonly result: TaskResult;
  readonly sessionState?: SessionStateRef;
  readonly harnessSession?: ArtifactHarnessSession;
  readonly files: readonly {
    path: string;
    digest: string;
    sizeBytes: number;
    mediaType?: string;
  }[];
  readonly summary?: string;
  readonly groups?: readonly OutputFinalizationGroup[];
  readonly cleanupConfirmed: boolean;
}
export function outputArtifactEvents(
  record: OutputFinalizationRecord,
  selections: readonly ArtifactSelection[],
): TaskAttemptEvent[] {
  const files = new Map(record.files.map((file) => [file.path, file]));
  return selections.flatMap((selection) =>
    selection.paths.map((path): TaskAttemptEvent => {
      const file = files.get(path);
      if (!file) throw new OutputFinalizationIntegrityError("Missing published output file");
      return {
        type: "artifact.created",
        taskId: record.spec.taskId,
        attemptId: record.spec.attemptId,
        at: new Date().toISOString(),
        artifact: {
          id: selection.artifactId,
          artifactId: selection.artifactId,
          path,
          name: path,
          uri: `supertag-artifact:sha256:${file.digest}`,
          digest: `sha256:${file.digest}`,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        },
      };
    }),
  );
}

export class OutputFinalizationPendingError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Output transfer is pending; frozen outputs are retained for recovery without rerunning the Harness",
      options,
    );
    this.name = "OutputFinalizationPendingError";
  }
}
/** Permanent local journal corruption or identity conflict. Never rerun the Harness to repair it. */
export class OutputFinalizationIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutputFinalizationIntegrityError";
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function outputSpecDigest(spec: TaskAttemptSpec): string {
  return digest(Buffer.from(canonical(spec)));
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
async function checkDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new OutputFinalizationIntegrityError("Unsafe output journal directory");
}
async function privateDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  await checkDirectory(path);
  if (firstCreated) {
    const boundary = dirname(firstCreated);
    let current = path;
    while (true) {
      await syncDirectory(current);
      if (current === boundary || dirname(current) === current) break;
      current = dirname(current);
    }
  }
}
async function readPrivate(path: string, limit: number): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    let stat = await file.stat();
    // A concurrent publish briefly has its temporary link plus its final link.
    // Wait for that publication to finish; persistent hardlinks remain forbidden.
    for (let retry = 0; stat.nlink > 1 && retry < 10; retry++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stat = await file.stat();
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new OutputFinalizationIntegrityError("Unsafe output journal file");
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new OutputFinalizationIntegrityError("Output journal exceeds bound");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** Publish only once. Concurrent stages choose the first fully persisted manifest. */
async function publishOnce(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
  } finally {
    await rm(temp, { force: true });
  }
  await syncDirectory(dirname(path));
}
function validate(record: OutputFinalizationRecord, attemptId: string): void {
  try {
    if (record.harnessSession !== undefined) validateArtifactHarnessSession(record.harnessSession);
    if (
      (record.groups === undefined || record.summary !== undefined) &&
      (typeof record.summary !== "string" || record.summary.length > 16_000)
    )
      throw new Error("summary");
    if (
      record.version !== 1 ||
      !/^automatic-task-outputs:[a-f0-9-]{36}$/.test(record.operationId) ||
      record.spec.attemptId !== attemptId ||
      record.specDigest !== outputSpecDigest(record.spec) ||
      typeof record.cleanupConfirmed !== "boolean" ||
      !Array.isArray(record.result.artifacts) ||
      !Array.isArray(record.files) ||
      record.files.length > 100
    )
      throw new Error("shape");
    const paths = new Set<string>();
    let total = 0;
    for (const file of record.files) {
      validateArtifactPath(file.path);
      if (
        paths.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.digest) ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        file.sizeBytes > 32 * 1024 * 1024
      )
        throw new Error("file");
      paths.add(file.path);
      total += file.sizeBytes;
    }
    if (total > 64 * 1024 * 1024) throw new Error("total");
    if (record.groups !== undefined) {
      if (!Array.isArray(record.groups) || record.groups.length > 100) throw new Error("groups");
      const ids = new Set<string>();
      const assigned = new Set<string>();
      for (const group of record.groups) {
        if (
          group.summary !== undefined &&
          (typeof group.summary !== "string" || group.summary.length > 16_000)
        )
          throw new Error("summary");
        if (
          typeof group.id !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(group.id) ||
          ids.has(group.id) ||
          typeof group.title !== "string" ||
          !group.title.trim() ||
          group.title.length > 200 ||
          typeof group.kind !== "string" ||
          !group.kind.trim() ||
          group.kind.length > 100 ||
          typeof group.submit !== "boolean" ||
          !Array.isArray(group.paths) ||
          !group.paths.length ||
          group.paths.length > 100
        )
          throw new Error("group");
        ids.add(group.id);
        for (const path of group.paths) {
          if (!paths.has(path) || assigned.has(path)) throw new Error("group path");
          assigned.add(path);
        }
      }
      if (assigned.size !== paths.size) throw new Error("ungrouped file");
    }
  } catch (error) {
    throw new OutputFinalizationIntegrityError("Invalid output journal manifest", { cause: error });
  }
}
/** Private Worker-host outbox. A committed manifest always points at frozen, verified local bytes. */
export class OutputFinalizationJournal {
  readonly root: string;
  constructor(
    workerId: string,
    root?: string,
    readonly transports: {
      catalog?: (spec: TaskAttemptSpec) => ArtifactCatalogTransport;
      store?: ArtifactStore | ((spec: TaskAttemptSpec) => ArtifactStore);
    } = {},
  ) {
    this.root = join(
      root ??
        join(process.env["SUPERTAG_STATE_DIR"] ?? join(homedir(), ".supertag"), "output-transfers"),
      digest(Buffer.from(workerId)),
    );
  }
  private directory(attemptId: string): string {
    return join(this.root, digest(Buffer.from(attemptId)));
  }
  async read(attemptId: string): Promise<OutputFinalizationRecord | undefined> {
    try {
      await checkDirectory(this.root);
      await checkDirectory(this.directory(attemptId));
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw new OutputFinalizationIntegrityError("Unsafe output journal directory", {
        cause: error,
      });
    }
    let bytes: Buffer;
    try {
      bytes = await readPrivate(join(this.directory(attemptId), "manifest.json"), 8 * 1024 * 1024);
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw new OutputFinalizationIntegrityError("Cannot read output journal manifest", {
        cause: error,
      });
    }
    let record: OutputFinalizationRecord;
    try {
      record = JSON.parse(bytes.toString("utf8")) as OutputFinalizationRecord;
    } catch (error) {
      throw new OutputFinalizationIntegrityError("Invalid output journal manifest", {
        cause: error,
      });
    }
    validate(record, attemptId);
    try {
      const ready = await readPrivate(join(this.directory(attemptId), "cleanup-confirmed"), 64);
      if (ready.toString("utf8") !== record.specDigest)
        throw new OutputFinalizationIntegrityError("Invalid cleanup confirmation");
      record = { ...record, cleanupConfirmed: true };
    } catch (error) {
      if (code(error) !== "ENOENT")
        throw new OutputFinalizationIntegrityError("Invalid cleanup confirmation", {
          cause: error,
        });
    }
    try {
      const blocked = JSON.parse(
        (await readPrivate(join(this.directory(attemptId), "blocked.json"), 1024)).toString("utf8"),
      );
      if (blocked.specDigest !== record.specDigest || typeof blocked.reason !== "string")
        throw new OutputFinalizationIntegrityError("Invalid output transfer block");
      record = { ...record, blocked: blocked.reason };
    } catch (error) {
      if (code(error) !== "ENOENT")
        throw new OutputFinalizationIntegrityError("Invalid output transfer block", {
          cause: error,
        });
    }
    return record;
  }
  async stage(input: {
    spec: TaskAttemptSpec;
    result: TaskResult;
    sessionState?: SessionStateRef;
    harnessSession?: ArtifactHarnessSession;
    groups?: readonly OutputFinalizationGroup[];
    files: readonly { path: string; bytes: Uint8Array; mediaType?: string }[];
  }): Promise<OutputFinalizationRecord> {
    if (
      input.files.length > 100 ||
      input.files.some((file) => file.bytes.byteLength > 32 * 1024 * 1024) ||
      input.files.reduce((total, file) => total + file.bytes.byteLength, 0) > 64 * 1024 * 1024
    )
      throw new OutputFinalizationIntegrityError("Output snapshot exceeds limits");
    // Snapshot caller-owned values before the first asynchronous filesystem operation.
    const spec = structuredClone(input.spec);
    const result = structuredClone(input.result);
    const sessionState = input.sessionState ? structuredClone(input.sessionState) : undefined;
    const harnessSession = input.harnessSession ? structuredClone(input.harnessSession) : undefined;
    const groups = input.groups === undefined ? undefined : structuredClone(input.groups);
    const frozen = input.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
    const files = frozen.map((file) => ({
      path: file.path,
      digest: digest(file.bytes),
      sizeBytes: file.bytes.length,
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
    }));
    // Freeze searchable filenames now; replay must not add metadata to older registrations.
    const summarize = (paths: readonly string[]) =>
      `Files (${paths.length}):\n${[...paths].sort().join("\n")}`.slice(0, 16_000);
    const snapshot: OutputFinalizationRecord = {
      version: 1,
      operationId: `automatic-task-outputs:${randomUUID()}`,
      spec,
      specDigest: outputSpecDigest(spec),
      result,
      ...(sessionState ? { sessionState } : {}),
      ...(harnessSession ? { harnessSession } : {}),
      files,
      ...(groups === undefined
        ? { summary: summarize(files.map((file) => file.path)) }
        : { groups }),
      cleanupConfirmed: false,
    };
    validate(snapshot, spec.attemptId);
    const record: OutputFinalizationRecord = {
      ...snapshot,
      ...(groups === undefined
        ? {}
        : { groups: groups.map((group) => ({ ...group, summary: summarize(group.paths) })) }),
    };
    const manifest = Buffer.from(JSON.stringify(record));
    if (manifest.byteLength > 8 * 1024 * 1024)
      throw new OutputFinalizationIntegrityError("Output journal exceeds bound");
    const previous = await this.read(spec.attemptId);
    if (previous) {
      if (previous.specDigest !== record.specDigest)
        throw new OutputFinalizationIntegrityError("Output Attempt specification conflict");
      return previous;
    }
    await privateDirectory(this.root);
    const directory = this.directory(spec.attemptId);
    await privateDirectory(directory);
    for (let i = 0; i < frozen.length; i++) {
      const file = frozen[i];
      const entry = files[i];
      if (!file || !entry) throw new OutputFinalizationIntegrityError("Missing output snapshot");
      const path = join(directory, entry.digest);
      await publishOnce(path, file.bytes);
      const bytes = await readPrivate(path, 32 * 1024 * 1024);
      if (digest(bytes) !== entry.digest)
        throw new OutputFinalizationIntegrityError("Frozen output digest mismatch");
    }
    await publishOnce(join(directory, "manifest.json"), manifest);
    await syncDirectory(this.root);
    await syncDirectory(dirname(this.root));
    const committed = await this.read(spec.attemptId);
    if (!committed || committed.specDigest !== record.specDigest)
      throw new OutputFinalizationIntegrityError("Output Attempt specification conflict");
    return committed;
  }
  async confirmCleanup(record: OutputFinalizationRecord): Promise<OutputFinalizationRecord> {
    const saved = await this.saved(record);
    await publishOnce(
      join(this.directory(saved.spec.attemptId), "cleanup-confirmed"),
      Buffer.from(saved.specDigest),
    );
    return { ...saved, cleanupConfirmed: true };
  }
  private async saved(record: OutputFinalizationRecord): Promise<OutputFinalizationRecord> {
    const saved = await this.read(record.spec.attemptId);
    if (!saved || saved.specDigest !== record.specDigest)
      throw new OutputFinalizationIntegrityError("Output Attempt specification conflict");
    return saved;
  }
  /** Called only after terminal completion has been durably acknowledged by the Worklet. */
  async acknowledge(attemptId: string, specDigest: string): Promise<void> {
    const saved = await this.read(attemptId);
    if (!saved) return;
    if (saved.blocked || !saved.cleanupConfirmed || saved.specDigest !== specDigest)
      throw new OutputFinalizationIntegrityError("Output Attempt specification conflict");
    await rm(this.directory(attemptId), { recursive: true, force: true });
    await syncDirectory(this.root);
  }
  async publish(
    record: OutputFinalizationRecord,
    signal?: AbortSignal,
  ): Promise<readonly ArtifactSelection[]> {
    try {
      return await this.publishSaved(record, signal);
    } catch (error) {
      if (
        error instanceof OutputFinalizationIntegrityError ||
        (error instanceof ArtifactRequestError && [400, 409].includes(error.status))
      ) {
        const reason =
          error instanceof ArtifactRequestError
            ? error instanceof ArtifactHttpError
              ? `catalog_http_${error.status}`
              : `catalog_${error.status}`
            : "local_integrity_failure";
        try {
          const saved = await this.saved(record);
          await publishOnce(
            join(this.directory(saved.spec.attemptId), "blocked.json"),
            Buffer.from(JSON.stringify({ specDigest: saved.specDigest, reason })),
          );
        } catch {
          /* Unreadable journals already fail closed without network replay. */
        }
        throw new OutputFinalizationIntegrityError("Output transfer requires operator recovery", {
          cause: error,
        });
      }
      throw error;
    }
  }
  private async publishSaved(
    record: OutputFinalizationRecord,
    signal?: AbortSignal,
  ): Promise<readonly ArtifactSelection[]> {
    record = await this.saved(record);
    if (record.blocked)
      throw new OutputFinalizationIntegrityError("Output transfer requires operator recovery");
    const coordination = record.spec.coordination;
    if (!coordination) throw new Error("Automatic outputs require authenticated catalog access");
    const store =
      typeof this.transports.store === "function"
        ? this.transports.store(record.spec)
        : this.transports.store;
    // The Control Plane stores no bytes; frozen outputs wait in the journal for host storage.
    if (!store) throw new Error("Automatic outputs require Worker Host artifact storage");
    const client = new ArtifactClient({
      ...(this.transports.catalog
        ? { catalogTransport: this.transports.catalog(record.spec) }
        : {}),
      controlPlaneUrl: coordination.controlPlaneUrl,
      token: coordination.token,
      store,
      environment: () => undefined,
      exclusiveWorkspace: true,
      harnessSession: () => record.harnessSession,
      ...(signal ? { signal } : {}),
    });
    const entries = [];
    for (const file of record.files) {
      signal?.throwIfAborted();
      let bytes: Buffer;
      try {
        bytes = await readPrivate(
          join(this.directory(record.spec.attemptId), file.digest),
          32 * 1024 * 1024,
        );
      } catch (error) {
        throw new OutputFinalizationIntegrityError("Cannot read frozen output", { cause: error });
      }
      if (bytes.length !== file.sizeBytes || digest(bytes) !== file.digest)
        throw new OutputFinalizationIntegrityError("Frozen output digest mismatch");
      const ref = await store.put({ bytes });
      if (!ref.digest) throw new Error("Missing output digest");
      entries.push({
        path: file.path,
        uri: ref.uri,
        digest: ref.digest,
        sizeBytes: file.sizeBytes,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      });
    }
    if (!entries.length) return [];
    const groups = record.groups ?? [
      {
        id: "",
        title: "Task outputs",
        ...(record.summary === undefined ? {} : { summary: record.summary }),
        kind: "task-output",
        paths: entries.map((entry) => entry.path),
        submit: true,
      },
    ];
    const selections: ArtifactSelection[] = [];
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const group of groups) {
      signal?.throwIfAborted();
      const artifact = await client.register({
        operationId: record.groups ? `${record.operationId}:${group.id}` : record.operationId,
        title: group.title,
        ...(group.summary === undefined ? {} : { summary: group.summary }),
        kind: group.kind,
        entries: group.paths.map((path) => {
          const entry = entriesByPath.get(path);
          if (!entry) throw new OutputFinalizationIntegrityError("Missing grouped output");
          return entry;
        }),
      });
      if (group.submit)
        selections.push({
          artifactId: artifact.id,
          paths: artifact.entries.map((entry) => entry.path),
        });
    }
    return selections;
  }
  async *finish(
    record: OutputFinalizationRecord,
    signal?: AbortSignal,
  ): AsyncIterable<TaskAttemptEvent> {
    record = await this.saved(record);
    if (!record.cleanupConfirmed)
      throw new OutputFinalizationIntegrityError("Output cleanup has not been confirmed");
    const artifacts = await this.publish(record, signal);
    const identity = { taskId: record.spec.taskId, attemptId: record.spec.attemptId };
    yield* outputArtifactEvents(record, artifacts);
    yield {
      type: "result",
      ...identity,
      at: new Date().toISOString(),
      result: { ...record.result, artifacts: [...record.result.artifacts, ...artifacts] },
    };
    if (record.sessionState)
      yield {
        type: "session.updated",
        ...identity,
        at: new Date().toISOString(),
        sessionState: record.sessionState,
      };
    yield { type: "execution.completed", ...identity, at: new Date().toISOString() };
  }
}
