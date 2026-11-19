/**
 * The main process's Gateway connection. One connection is current at a time; its `connectionId` is a generation counter the window sends
 * with every call. A call for an older generation is refused, and a result that arrives after
 * the connection changed is dropped, so nothing of one Gateway reaches a view of another.
 * Switching ends the Watch and every follow of the connection it replaces.
 */
import { hostname } from "node:os";
import type { WorkerHostStatus } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type {
  Conversation,
  FollowUpdate,
  GatewayActivation,
  GatewayList,
  Message,
  MessagePage,
  NetworkLog,
  Note,
  ReadMessages,
  Schedule,
  ScheduleAction,
  Tag,
  TagActivity,
  TaskEvent,
  TaskFilesPlace,
  WatchUpdate,
} from "../model/gateway";
import type { NewTag, TagOptions } from "../model/tag-admin";
import { CACHE_ERROR, type CacheScope, entryPath, readEntry, validKey, writeEntry } from "./cache";
import { conversation, event, message, messages, tag } from "./convert";
import { activity, networkLog, note, schedule } from "./details";
import { endpoint, gatewayOrigin, type Target } from "./endpoint";
import { CONNECT_FIRST, CONNECTION_CHANGED, checkBearer, rpc, rpcError, statusOf } from "./errors";
import { Cursor, runFollow } from "./follow";
import { type DiscoverLocal, discover, LOCAL, status } from "./local";
import { branchToFollow, optionsOf, putTagRequest } from "./new-tag";
import { loadProfiles, type Profiles, saveProfiles, storeDirectory } from "./profiles";
import { Code } from "./sdk";
import { CALL, isAuthKey, MAX_PAGES, Session, type SessionOptions } from "./session";
import type { Updates } from "./streams";
import { place } from "./task-files";
import { runWatch } from "./watch";

/** The most events one `ListEvents` call returns. */
const EVENT_PAGE = 32;

export interface GatewayStateOptions extends SessionOptions {
  /** `gateways.json`, which the CLI also reads. */
  readonly store: string;
  /** Where cached conversations live. */
  readonly cache: string;
  /** Finds the local Gateway with the app's CLI. */
  readonly discoverLocal: DiscoverLocal;
  /** The name this device enrolls under with a client Auth Key; the host name by default. */
  readonly deviceName?: () => string;
}

/** A stream the window receives until it stops. */
export interface Subscriber<U> extends Updates<U> {
  /** Runs once the window stops receiving: its stop call, or the window reset. */
  onEnd(stop: () => void): void;
  /** The stream ended on the main side; the window drops its callback. */
  end(): void;
}

interface Registration {
  id: string;
  stop: AbortController;
}

/** This machine's host name as a client name: letters, digits, hyphens, underscores and dots. */
export function deviceName(name: string = hostname()): string {
  const cleaned = [...name]
    .map((c) => (/^[A-Za-z0-9._-]$/u.test(c) ? c : "-"))
    .slice(0, 250)
    .join("");
  return cleaned === "" ? "device" : cleaned;
}

export class GatewayState {
  private generation = 0;
  private session: Session | undefined;
  private origin: string | undefined;
  private localState: string | undefined;
  private cacheScope: CacheScope | undefined;
  private watch: Registration | undefined;
  private watchEpoch = 0;
  private follows = new Map<string, AbortController>();
  private nextFollow = 0;
  /** Orders connection changes, as the Rust app's mutex did. */
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GatewayStateOptions) {}

  private serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.changes.then(change, change);
    this.changes = run.catch(() => {});
    return run;
  }

  /** Drops the current connection: the window reloaded or closed. */
  disconnect(): void {
    this.replace();
  }

  /** Ends the current connection and returns the next generation. */
  private replace(): number {
    this.generation += 1;
    this.session?.close();
    this.session = undefined;
    this.origin = undefined;
    this.localState = undefined;
    this.cacheScope = undefined;
    this.watch?.stop.abort();
    this.watch = undefined;
    this.watchEpoch = 0;
    for (const follow of this.follows.values()) follow.abort();
    this.follows.clear();
    return this.generation;
  }

  /** Makes `session` current; exported for tests that need a session without a Gateway. */
  adopt(session: Session, origin: string, scope: CacheScope, localState?: string): string {
    const connectionId = String(this.replace());
    this.session = session;
    this.origin = origin;
    this.cacheScope = scope;
    this.localState = localState;
    return connectionId;
  }

  private currentSession(connectionId: string): Session {
    const session = this.session;
    if (session === undefined) throw CONNECT_FIRST;
    if (String(this.generation) !== connectionId) throw CONNECTION_CHANGED;
    return session;
  }

  /**
   * Runs `work` on the connection the window names, and returns its result only if that
   * connection is still current when it finishes.
   */
  private async call<T>(connectionId: string, work: (session: Session) => Promise<T>): Promise<T> {
    const session = this.currentSession(connectionId);
    let value: T;
    try {
      value = await work(session);
    } catch (error) {
      if (this.session !== session) throw CONNECTION_CHANGED;
      throw error;
    }
    if (this.session !== session) throw CONNECTION_CHANGED;
    return value;
  }

  // Connection

  private async list(profiles: Profiles): Promise<GatewayList> {
    return {
      profiles: profiles.gateways.map((entry) => ({ ...entry.profile })),
      active: profiles.active,
      local: await status(this.options.discoverLocal),
    };
  }

  savedGateways(): Promise<GatewayList> {
    return this.serial(async () => this.list(await loadProfiles(this.options.store)));
  }

  saveGateway(address: string, name: string, token: string): Promise<GatewayActivation> {
    return this.serial(async () => {
      const origin = gatewayOrigin(address);
      const target = endpoint(origin);
      await storeDirectory(this.options.store);
      const trimmed = name.trim();
      if ([...trimmed].length > 80 || /\p{Cc}/u.test(trimmed)) {
        throw "Enter a Gateway name of up to 80 characters.";
      }
      // A client Auth Key joins this device once; only the enrolled credential is saved.
      let credential = token;
      if (isAuthKey(token)) {
        const joining = await Session.connect(target, token, this.options);
        try {
          credential = await joining.enroll(this.options.deviceName?.() ?? deviceName());
        } finally {
          joining.close();
        }
      }
      const profiles = await loadProfiles(this.options.store);
      const shown = trimmed === "" ? origin : trimmed;
      const stored = profiles.gateways.find((entry) => entry.profile.origin === origin);
      if (stored) {
        stored.profile.name = shown;
        if (credential !== "") stored.token = checkBearer(credential);
        return this.activate(profiles, origin, target, stored.token);
      }
      checkBearer(credential);
      profiles.gateways.push({ profile: { name: shown, origin }, token: credential });
      return this.activate(profiles, origin, target, credential);
    });
  }

  selectGateway(origin: string): Promise<GatewayActivation> {
    return this.serial(async () => {
      const profiles = await loadProfiles(this.options.store);
      const entry = profiles.gateways.find((saved) => saved.profile.origin === origin);
      if (!entry) throw "That Gateway is no longer saved.";
      let canonical: string;
      try {
        canonical = gatewayOrigin(origin);
      } catch {
        throw "The saved Gateway address is invalid.";
      }
      if (canonical !== origin) throw "The saved Gateway address is invalid.";
      return this.activate(profiles, origin, endpoint(origin), entry.token);
    });
  }

  /**
   * Connects to the local Gateway with the operator token its state directory holds now.
   * Nothing about it is saved, and no saved Gateway stays active, so the next launch opens the
   * local one again.
   */
  connectLocalGateway(): Promise<GatewayActivation> {
    return this.serial(async () => {
      const local = await discover(this.options.discoverLocal);
      const target = endpoint(local.url);
      const profiles = await loadProfiles(this.options.store);
      return this.activate(profiles, null, target, local.token, local.stateDirectory);
    });
  }

  /**
   * Connects and makes the connection current. A saved `origin` becomes the active saved
   * Gateway; `null` is the local Gateway, which leaves none active.
   */
  private async activate(
    profiles: Profiles,
    origin: string | null,
    target: Target,
    token: string,
    localState?: string,
  ): Promise<GatewayActivation> {
    const generation = this.generation;
    // Cached conversations, and messages not yet sent, belong to this Gateway and principal.
    // The local Control Plane is told apart by its state directory, not its address: each
    // `supertag up` starts its Gateway on a new port, which would drop them all.
    const gateway = origin ?? `${LOCAL} ${localState ?? target.url}`;
    const session = await Session.connect(target, token, this.options);
    try {
      const principal = await session.principal();
      const tags = await session.tags();
      if (this.generation !== generation) throw "The connection changed. Connect again.";
      profiles.active = origin;
      await saveProfiles(this.options.store, profiles);
      const shown = origin ?? LOCAL;
      const connectionId = this.adopt(session, shown, { gateway, principal }, localState);
      return {
        gateways: await this.list(profiles),
        origin: shown,
        connectionId,
        tags,
        principal,
      };
    } catch (error) {
      if (this.session !== session) session.close();
      throw error;
    }
  }

  clearGateway(forget: string | undefined): Promise<GatewayList> {
    return this.serial(async () => {
      const profiles = await loadProfiles(this.options.store);
      if (forget !== undefined) {
        profiles.gateways = profiles.gateways.filter((entry) => entry.profile.origin !== forget);
      }
      if (forget === undefined || profiles.active === forget) profiles.active = null;
      await saveProfiles(this.options.store, profiles);
      if (forget === undefined || this.origin === forget) this.replace();
      return this.list(profiles);
    });
  }

  /**
   * The state directory of the local services this connection reaches, where `supertag
   * workspace add` adds a folder. Only the local Gateway has one.
   */
  async localStateOf(connectionId: string): Promise<string> {
    this.currentSession(connectionId);
    if (this.origin === LOCAL && this.localState !== undefined) return this.localState;
    throw "Only the local Gateway can add a folder of this Mac as a Workspace.";
  }

  // Conversations

  tags(connectionId: string): Promise<Tag[]> {
    return this.call(connectionId, (session) => session.tags());
  }

  /** The caller's conversation with each Tag it has talked to, the latest active first. */
  conversations(connectionId: string): Promise<Conversation[]> {
    return this.call(connectionId, async (session) => {
      const page = await rpc(() => session.client.conversations.listConversations({}, CALL));
      return page.conversations.map(conversation);
    });
  }

  /** Records that the caller read its conversation with a Tag up to a finished turn. */
  markRead(connectionId: string, tagId: string, order: number): Promise<Conversation> {
    return this.call(connectionId, async (session) =>
      conversation(
        await rpc(() =>
          session.client.conversations.markConversationRead({ tagId, order: BigInt(order) }, CALL),
        ),
      ),
    );
  }

  /** A page of a conversation, or only what changed after the copy `read` describes. */
  messages(connectionId: string, read: ReadMessages): Promise<MessagePage> {
    return this.call(connectionId, async (session) =>
      messages(
        await rpc(() =>
          session.client.conversations.listMessages(
            {
              tagId: read.tagId,
              limit: 50,
              cursor: read.cursor ?? "",
              after: BigInt(read.after ?? 0),
              conversationId: read.conversationId ?? "",
              refreshTaskIds: read.refreshTaskIds ?? [],
            },
            CALL,
          ),
        ),
      ),
    );
  }

  send(connectionId: string, tagId: string, text: string, operationId: string): Promise<Message> {
    return this.call(connectionId, async (session) =>
      message(
        await rpc(() =>
          session.client.conversations.sendMessage({ tagId, text, operationId }, CALL),
        ),
      ),
    );
  }

  message(connectionId: string, tagId: string, taskId: string): Promise<Message> {
    return this.call(connectionId, async (session) =>
      message(await rpc(() => session.client.conversations.getMessage({ tagId, taskId }, CALL))),
    );
  }

  /** A Task's events after `afterSequence`, oldest first, read page by page. */
  events(connectionId: string, taskId: string, afterSequence: number): Promise<TaskEvent[]> {
    return this.call(connectionId, async (session) => {
      const events: TaskEvent[] = [];
      let after = afterSequence;
      for (let page = 0; page < MAX_PAGES; page++) {
        const listed = (
          await rpc(() =>
            session.client.operator.listEvents(
              { taskId, afterSequence: BigInt(after), limit: EVENT_PAGE },
              CALL,
            ),
          )
        ).events;
        const full = listed.length >= EVENT_PAGE;
        const before = events.length;
        events.push(...listed.map(event).filter((read) => read.sequence > after));
        const last = events.at(-1);
        if (events.length === before || last === undefined) break;
        after = last.sequence;
        if (!full) break;
      }
      return events;
    });
  }

  // Tags

  /** The Tag's activity, read fresh each time the panel asks. */
  tagActivity(connectionId: string, tagId: string): Promise<TagActivity> {
    return this.call(connectionId, async (session) =>
      activity(await rpc(() => session.client.operator.getTag({ tagId }, CALL))),
    );
  }

  private async hostOptions(session: Session): Promise<TagOptions> {
    const hosts: WorkerHostStatus[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await rpc(() =>
        session.client.operator.listHosts({ limit: 100, cursor }, CALL),
      );
      hosts.push(...listed.hosts);
      if (listed.nextCursor === "" || listed.nextCursor === cursor) break;
      cursor = listed.nextCursor;
    }
    return optionsOf(hosts);
  }

  /** The harnesses and Workspaces of the Gateway's current Worker Hosts. Operators only. */
  tagOptions(connectionId: string): Promise<TagOptions> {
    return this.call(connectionId, (session) => this.hostOptions(session));
  }

  /** Creates a Tag, refusing an ID or name another Tag holds. */
  createTag(connectionId: string, newTag: NewTag): Promise<Tag> {
    return this.call(connectionId, async (session) => {
      // A harness its current hosts run no commands for gets none, as init's lead does. With
      // no host serving it yet, the host that will is not known, so it may run them. When the
      // hosts can't be listed, creating the Tag says why: only an operator may.
      const commands = await this.hostOptions(session).then(
        (options) => !(options.noCommands ?? []).includes(newTag.harness),
        () => true,
      );
      const request = putTagRequest(newTag, commands);
      const workspace = request.workspace;
      if (workspace && workspace.baseRef === "" && workspace.baseCommit === "") {
        const branch = branchToFollow(await session.rawTags(false), workspace.workspaceId);
        if (branch !== undefined) workspace.baseRef = branch;
      }
      const created = await rpc(
        () => session.client.operator.putTag(request, CALL),
        (error) => {
          switch (statusOf(error).code) {
            case Code.AlreadyExists:
              return "A Tag with that ID or name already exists.";
            case Code.PermissionDenied:
              return "Only an operator can create Tags.";
            default:
              return rpcError(error);
          }
        },
      );
      return tag(created);
    });
  }

  // Notes, network log, Schedules

  /** The Tag's notes the caller sees, newest first. */
  notes(connectionId: string, tagId: string): Promise<Note[]> {
    return this.call(connectionId, async (session) =>
      (await rpc(() => session.client.memories.list({ tagId }, CALL))).memories.map(note),
    );
  }

  /** Deletes a note at once. The Tag no longer sees it from its next turn. */
  deleteNote(connectionId: string, memoryId: string): Promise<Note> {
    return this.call(connectionId, async (session) =>
      note(await rpc(() => session.client.memories.delete({ memoryId }, CALL))),
    );
  }

  /** The Tag's newest Task Attempts with a network log, newest first. */
  networkLogs(connectionId: string, tagId: string): Promise<NetworkLog[]> {
    return this.call(connectionId, async (session) =>
      (await rpc(() => session.client.networkLogs.list({ tagId, limit: 20 }, CALL))).logs.map(
        networkLog,
      ),
    );
  }

  /** The Tag's Schedules that have not finished, next due first. */
  schedules(connectionId: string, tagId: string): Promise<Schedule[]> {
    return this.call(connectionId, async (session) =>
      (
        await rpc(() => session.client.schedules.list({ tagId, includeFinished: false }, CALL))
      ).schedules.map(schedule),
    );
  }

  /** Pauses, resumes, or deletes (cancels) a Schedule. */
  changeSchedule(
    connectionId: string,
    scheduleId: string,
    action: ScheduleAction,
  ): Promise<Schedule> {
    return this.call(connectionId, async (session) => {
      const schedules = session.client.schedules;
      const change =
        action === "pause"
          ? () => schedules.pause({ scheduleId }, CALL)
          : action === "resume"
            ? () => schedules.resume({ scheduleId }, CALL)
            : action === "delete"
              ? () => schedules.delete({ scheduleId }, CALL)
              : undefined;
      if (change === undefined) throw "Choose pause, resume, or delete.";
      return schedule(await rpc(change));
    });
  }

  // Task files

  /**
   * Asks the Control Plane where the Task's files are, presenting this machine's identifier,
   * and remembers a local root for listing and reading.
   */
  locateTaskFiles(connectionId: string, taskId: string): Promise<TaskFilesPlace> {
    return this.call(connectionId, async (session) => {
      const machineId = await this.options
        .discoverLocal()
        .then((local) => local.machineId ?? "")
        .catch(() => "");
      const located = await rpc(() => session.client.taskFiles.locate({ taskId, machineId }, CALL));
      return place(connectionId, taskId, located.locations[0]);
    });
  }

  // Cache

  private scope(connectionId: string): CacheScope {
    if (String(this.generation) !== connectionId) throw CONNECTION_CHANGED;
    if (this.cacheScope === undefined) throw CONNECT_FIRST;
    return this.cacheScope;
  }

  /** The entry last cached under `key` for the current Gateway and principal, or null. */
  async cached(connectionId: string, key: string): Promise<unknown> {
    if (!validKey(key)) throw CACHE_ERROR;
    const value = await readEntry(entryPath(this.options.cache, this.scope(connectionId), key));
    return value === undefined ? null : value;
  }

  /** Replaces the entry under `key` for the current Gateway and principal. */
  async cache(connectionId: string, key: string, value: unknown): Promise<void> {
    if (!validKey(key)) throw CACHE_ERROR;
    await writeEntry(entryPath(this.options.cache, this.scope(connectionId), key), value);
  }

  // Watch and follows

  /**
   * Registers the Watch for `watchEpoch`, replacing an older one; a stale epoch is refused.
   * Exported for tests: `startWatch` runs it.
   */
  registerWatch(
    connectionId: string,
    watchEpoch: number,
  ): { id: string; session: Session; stop: AbortSignal } {
    const session = this.session;
    if (session === undefined || String(this.generation) !== connectionId) {
      throw CONNECTION_CHANGED;
    }
    if (watchEpoch <= this.watchEpoch) throw "The Watch subscription changed.";
    this.watch?.stop.abort();
    const id = `${connectionId}:${watchEpoch}`;
    const stop = new AbortController();
    this.watchEpoch = watchEpoch;
    this.watch = { id, stop };
    return { id, session, stop: stop.signal };
  }

  /** Starts the Watch, pushing to `updates` until stopped; returns its ID. */
  startWatch(connectionId: string, watchEpoch: number, updates: Subscriber<WatchUpdate>): string {
    const { id, session, stop } = this.registerWatch(connectionId, watchEpoch);
    updates.onEnd(() => this.stopWatch(id));
    void runWatch(session.client, stop, updates)
      .catch((error: unknown) => console.error("The Gateway Watch failed", error))
      .finally(() => updates.end());
    return id;
  }

  stopWatch(id: string): void {
    if (this.watch?.id === id) {
      this.watch.stop.abort();
      this.watch = undefined;
    }
  }

  /** Follows the caller's conversation with `read.tagId` from the copy `read` describes. */
  startFollow(connectionId: string, read: ReadMessages, updates: Subscriber<FollowUpdate>): string {
    const session = this.session;
    if (session === undefined || String(this.generation) !== connectionId) {
      throw CONNECTION_CHANGED;
    }
    this.nextFollow += 1;
    const id = `${connectionId}:follow:${this.nextFollow}`;
    const stop = new AbortController();
    this.follows.set(id, stop);
    updates.onEnd(() => this.stopFollow(id));
    void runFollow(session.client, new Cursor(read), stop.signal, updates)
      .catch((error: unknown) => console.error("A conversation follow failed", error))
      .finally(() => {
        if (this.follows.get(id) === stop) this.follows.delete(id);
        updates.end();
      });
    return id;
  }

  stopFollow(id: string): void {
    this.follows.get(id)?.abort();
    this.follows.delete(id);
  }

  /** Open follows of the current connection; for tests. */
  get openFollows(): number {
    return this.follows.size;
  }
}
