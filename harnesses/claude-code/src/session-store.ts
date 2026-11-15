import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeTranscript {
  readonly sessionId: string;
  readonly subpath?: string;
  readonly entries: readonly SessionStoreEntry[];
}

/** One admitted SuperTag Session, with native main and subagent transcripts. */
export class ClaudeSessionStore implements SessionStore {
  readonly #transcripts = new Map<string, ClaudeTranscript>();
  readonly #save: (sessionId: string, transcripts: readonly ClaudeTranscript[]) => Promise<void>;
  readonly #retryDelaysMs: readonly number[];
  #pending: Promise<void> = Promise.resolve();
  // Batches whose save failed, by transcript. The SDK may retry a failed append with the same
  // entries; keeping the batch aside (instead of committing it) avoids duplicating entries without
  // a uuid, and committing it before the next different batch (or at flush) avoids losing it.
  readonly #unsaved = new Map<string, { key: SessionKey; entries: SessionStoreEntry[] }>();
  #snapshotUnsaved: string | undefined;
  #failure: unknown;

  constructor(
    save: (sessionId: string, transcripts: readonly ClaudeTranscript[]) => Promise<void>,
    initial: readonly ClaudeTranscript[] = [],
    retryDelaysMs: readonly number[] = [250, 1_000, 4_000],
  ) {
    this.#save = save;
    this.#retryDelaysMs = retryDelaysMs;
    for (const transcript of initial)
      this.#transcripts.set(this.#key(transcript), structuredClone(transcript));
  }

  #key(key: Pick<SessionKey, "sessionId" | "subpath">): string {
    return JSON.stringify([key.sessionId, key.subpath ?? null]);
  }

  #merged(id: string, key: SessionKey, entries: readonly SessionStoreEntry[]): ClaudeTranscript {
    const previous = this.#transcripts.get(id)?.entries ?? [];
    const uuids = new Set(previous.flatMap((entry) => (entry.uuid ? [entry.uuid] : [])));
    const appended = entries.filter((entry) => {
      if (!entry.uuid) return true;
      if (uuids.has(entry.uuid)) return false;
      uuids.add(entry.uuid);
      return true;
    });
    return {
      sessionId: key.sessionId,
      ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
      entries: [...previous, ...appended],
    };
  }

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const copied = structuredClone(entries);
    const operation = this.#pending.then(async () => {
      const id = this.#key(key);
      const held = this.#unsaved.get(id)?.entries ?? [];
      const retry =
        held.length > 0 && JSON.stringify(copied.slice(0, held.length)) === JSON.stringify(held);
      const batch = retry || held.length === 0 ? copied : [...held, ...copied];
      const next = this.#merged(id, key, batch);
      const staged = new Map(this.#transcripts);
      staged.set(id, next);
      try {
        await this.#save(key.sessionId, structuredClone([...staged.values()]));
      } catch (error) {
        this.#unsaved.set(id, { key, entries: batch });
        this.#failure = error;
        throw error;
      }
      this.#transcripts.set(id, next);
      this.#unsaved.delete(id);
      this.#snapshotUnsaved = undefined;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  observeSession(sessionId: string): Promise<void> {
    const operation = this.#pending.then(async () => {
      try {
        await this.#save(sessionId, this.snapshot());
        this.#snapshotUnsaved = undefined;
      } catch (error) {
        this.#snapshotUnsaved = sessionId;
        this.#failure = error;
        throw error;
      }
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await this.#pending;
    const entries = this.#transcripts.get(this.#key(key))?.entries;
    return entries === undefined ? null : structuredClone([...entries]);
  }

  async listSubkeys(key: Pick<SessionKey, "projectKey" | "sessionId">): Promise<string[]> {
    await this.#pending;
    return this.snapshot().flatMap((entry) =>
      entry.sessionId === key.sessionId && entry.subpath !== undefined ? [entry.subpath] : [],
    );
  }

  snapshot(): ClaudeTranscript[] {
    return structuredClone([...this.#transcripts.values()]);
  }

  /**
   * Persists the complete history. Every save writes the whole snapshot, so a transient failure
   * (for example a slow Control Plane) is repaired by committing held batches and saving again,
   * with retries, before the Attempt is failed.
   */
  async flush(): Promise<void> {
    await this.#pending;
    const unsaved = () => this.#unsaved.size > 0 || this.#snapshotUnsaved !== undefined;
    for (const delay of this.#retryDelaysMs) {
      if (!unsaved()) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const staged = new Map(this.#transcripts);
      for (const [id, { key, entries }] of this.#unsaved) {
        const merged = this.#merged(id, key, entries);
        staged.set(id, merged);
      }
      const sessionId =
        [...this.#unsaved.values()][0]?.key.sessionId ?? (this.#snapshotUnsaved as string);
      try {
        await this.#save(sessionId, structuredClone([...staged.values()]));
      } catch (error) {
        this.#failure = error;
        continue;
      }
      for (const [id, value] of staged) this.#transcripts.set(id, value);
      this.#unsaved.clear();
      this.#snapshotUnsaved = undefined;
    }
    if (unsaved()) {
      const cause = this.#failure;
      const detail = cause instanceof Error ? `: ${cause.message}` : "";
      throw new Error(`Claude Session persistence failed${detail}`, { cause });
    }
  }
}

export function readClaudeTranscripts(value: unknown): ClaudeTranscript[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("Invalid Claude Session transcripts");
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.sessionId !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(item.sessionId) ||
      (item.subpath !== undefined &&
        (typeof item.subpath !== "string" ||
          !item.subpath ||
          /^(?:[\\/]|[a-zA-Z]:)/.test(item.subpath) ||
          item.subpath.includes("\0") ||
          item.subpath.split(/[\\/]/).some((part: string) => part === ".."))) ||
      !Array.isArray(item.entries) ||
      item.entries.some(
        (entry: unknown) =>
          !entry ||
          typeof entry !== "object" ||
          typeof (entry as { type?: unknown }).type !== "string",
      )
    ) {
      throw new Error("Invalid Claude Session transcript");
    }
    const key = JSON.stringify([item.sessionId, item.subpath ?? null]);
    if (seen.has(key)) throw new Error("Duplicate Claude Session transcript");
    seen.add(key);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
    throw new Error("Claude Session transcripts exceed storage bounds");
  return structuredClone(value) as ClaudeTranscript[];
}
