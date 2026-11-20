/**
 * The terminal UI's Gateway connections, in process: one `GatewayState` from
 * `@supertag/client/node`, the Gateways it can choose from (Local, the Gateways saved with
 * `supertag connect` and in the desktop app, a launch URL), and `TuiGateway`, the `Gateway` the
 * screens use. A `TuiGateway` knows its cache scope before it connects, so a launch paints the
 * cached conversations at once; its calls wait for the connection.
 */
import os from "node:os";
import path from "node:path";
import {
  type AddedWorkspace,
  type ApprovalDetails,
  type CacheKey,
  type Conversation,
  cacheScope,
  describe,
  type FollowUpdate,
  type Gateway,
  type HostPhases,
  type InboxItem,
  LOCAL_GATEWAY,
  type Message,
  type MessagePage,
  type NetworkLog,
  type NewObjective,
  type NewTag,
  type Note,
  type Objective,
  type ReadMessages,
  type Schedule,
  type ScheduleAction,
  type Tag,
  type TagActivity,
  type TagOptions,
  type TaskEvent,
  type Team,
  type WatchUpdate,
  type WorkBranch,
  type WorkDiff,
  type WorkSession,
  type WorkstreamPost,
} from "@supertag/client/model";
import {
  addWorkspaceWithCli,
  type CacheScope,
  type CliGateway,
  cliStore,
  type DirectConnection,
  deliveryDiff,
  desktopStore,
  entryPath,
  forget,
  forgetWithCli,
  GatewayState,
  gatewayOrigin,
  type LocalDiscovery,
  loadCliGateways,
  loadProfiles,
  openUrl,
  readEntry,
  readLocalGateway,
  type Subscriber,
  saveWithCli,
  type Tls,
  tlsOf,
  validKey,
  writeEntry,
} from "@supertag/client/node";

/** The conversation cache's root: `<user cache>/supertag/tui`. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const home = env["HOME"] || os.homedir();
  if (platform === "darwin") return path.join(home, "Library/Caches/supertag/tui");
  const xdg = env["XDG_CACHE_HOME"];
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "supertag/tui");
  return path.join(home, ".cache/supertag/tui");
}

/** One Gateway the chooser lists. */
export interface GatewayEntry {
  /** `local`, `saved:` and its origin, or `url:` and the launch URL. */
  id: string;
  name: string;
  /** The URL, or for Local where it runs or why it does not. */
  detail: string;
  kind: "local" | "saved" | "launch";
  /** Where a saved one is saved: `supertag connect` or the desktop app. */
  source?: "cli" | "desktop";
  available: boolean;
}

/** The add form's fields, filled from a Gateway to save or change. */
export interface GatewayDraft {
  name: string;
  url: string;
  token: string;
  serverCaFile: string;
  clientCertFile: string;
  clientKeyFile: string;
}

/** A saved or launch Gateway with its credential: never shown, never cached. */
interface Credentialed {
  entry: GatewayEntry;
  url: string;
  token: string;
  files?: Pick<CliGateway, "serverCaFile" | "clientCertFile" | "clientKeyFile">;
}

export interface ConnectionsOptions {
  env: NodeJS.ProcessEnv;
  /** The `supertag` CLI, for `__local-gateway` and `connect`. */
  cli: string;
  buildVersion: string;
  /** A launch URL and its token, from `--gateway URL` or `SUPERTAG_GATEWAY_URL`. */
  launchUrl?: { url: string; token: string; tls: Tls };
  /** For tests: how the local Gateway is found, and where saved Gateways are. */
  discoverLocal?: () => Promise<LocalDiscovery>;
  cliStore?: string;
  desktopStore?: string;
  cacheRoot?: string;
}

/** Builds a launch URL's TLS from `SUPERTAG_SERVER_CA_FILE` and the client certificate pair. */
export function launchTls(env: NodeJS.ProcessEnv): Promise<Tls> {
  const pick = (key: string) => env[key] || undefined;
  return tlsOf({
    serverCaFile: pick("SUPERTAG_SERVER_CA_FILE"),
    clientCertFile: pick("SUPERTAG_CLIENT_CERT_FILE"),
    clientKeyFile: pick("SUPERTAG_CLIENT_KEY_FILE"),
  });
}

export class Connections {
  readonly state: GatewayState;
  readonly cache: string;
  private readonly discoverLocal: () => Promise<LocalDiscovery>;
  private local: LocalDiscovery | undefined;

  constructor(private readonly options: ConnectionsOptions) {
    this.discoverLocal =
      options.discoverLocal ?? (() => readLocalGateway(options.cli, options.env));
    this.cache = options.cacheRoot ?? cacheRoot(options.env);
    this.state = new GatewayState({
      store: options.desktopStore ?? desktopStore(options.env),
      cache: this.cache,
      buildVersion: options.buildVersion,
      discoverLocal: this.discoverLocal,
    });
  }

  private async saved(): Promise<Credentialed[]> {
    const found: Credentialed[] = [];
    const seen = new Set<string>();
    const add = (item: Credentialed) => {
      if (seen.has(item.entry.id)) return;
      seen.add(item.entry.id);
      found.push(item);
    };
    const cli = await loadCliGateways(this.options.cliStore ?? cliStore(this.options.env)).catch(
      () => [],
    );
    for (const saved of cli) {
      let origin: string;
      try {
        origin = gatewayOrigin(saved.url);
      } catch {
        continue;
      }
      add({
        entry: {
          id: `saved:${origin}`,
          name: saved.name || origin,
          detail: origin,
          kind: "saved",
          source: "cli",
          available: true,
        },
        url: origin,
        token: saved.token,
        files: saved,
      });
    }
    const desktop = await loadProfiles(
      this.options.desktopStore ?? desktopStore(this.options.env),
    ).catch(() => ({ gateways: [] }));
    for (const saved of desktop.gateways) {
      const origin = saved.profile.origin;
      add({
        entry: {
          id: `saved:${origin}`,
          name: saved.profile.name || origin,
          detail: origin,
          kind: "saved",
          source: "desktop",
          available: true,
        },
        url: origin,
        token: saved.token,
      });
    }
    return found;
  }

  private launch(): Credentialed | undefined {
    const launch = this.options.launchUrl;
    if (!launch) return undefined;
    return {
      entry: {
        id: `url:${launch.url}`,
        name: launch.url,
        detail: "from the launch",
        kind: "launch",
        available: true,
      },
      url: launch.url,
      token: launch.token,
    };
  }

  /** Local's entry, asking the CLI where the local Gateway runs. */
  async localEntry(): Promise<GatewayEntry> {
    try {
      this.local = await this.discoverLocal();
    } catch (problem) {
      this.local = undefined;
      return {
        id: "local",
        name: "Local",
        detail: describe(problem),
        kind: "local",
        available: false,
      };
    }
    const local = this.local;
    return {
      id: "local",
      name: "Local",
      detail: local.running
        ? (local.url ?? "")
        : (local.message ?? "Not running. Start it with supertag up."),
      kind: "local",
      available: local.running,
    };
  }

  /** Every Gateway the chooser lists: the launch URL, Local, then the saved ones. */
  async entries(): Promise<GatewayEntry[]> {
    const [local, saved] = await Promise.all([this.localEntry(), this.saved()]);
    const launch = this.launch();
    return [...(launch ? [launch.entry] : []), local, ...saved.map((item) => item.entry)];
  }

  /** The saved Gateway with this name, as `--gateway NAME` names it. */
  async byName(name: string): Promise<GatewayEntry | undefined> {
    return (await this.saved()).find((item) => item.entry.name === name)?.entry;
  }

  /** What a connection to `id` is, with its credential, read fresh (Local's token may change). */
  async resolve(id: string): Promise<DirectConnection> {
    if (id === "local") {
      const local = await this.discoverLocal();
      if (!local.running || !local.url || !local.token) {
        throw local.message ?? "No local Gateway is running. Start it with supertag up.";
      }
      return {
        shown: LOCAL_GATEWAY,
        gateway: `${LOCAL_GATEWAY} ${local.stateDirectory}`,
        url: local.url,
        token: local.token,
        localState: local.stateDirectory,
      };
    }
    const item = [
      ...(this.launch() ? [this.launch() as Credentialed] : []),
      ...(await this.saved()),
    ].find((candidate) => candidate.entry.id === id);
    if (!item) throw "That Gateway is no longer saved.";
    const origin = gatewayOrigin(item.url);
    const tls = item.files ? await tlsOf(item.files) : (this.options.launchUrl?.tls ?? {});
    return { shown: origin, gateway: origin, url: item.url, token: item.token, tls };
  }

  /**
   * What the add form starts from to save the launch Gateway (`s`) or change a saved one's
   * credential (`e`): its name, URL, credential and TLS files. Local has none: its token is
   * read at every connect and never saved.
   */
  async draft(id: string): Promise<GatewayDraft | undefined> {
    if (id.startsWith("url:")) {
      const launch = this.options.launchUrl;
      if (!launch) return undefined;
      const env = this.options.env;
      return {
        name: "",
        url: launch.url,
        token: launch.token,
        serverCaFile: env["SUPERTAG_SERVER_CA_FILE"] ?? "",
        clientCertFile: env["SUPERTAG_CLIENT_CERT_FILE"] ?? "",
        clientKeyFile: env["SUPERTAG_CLIENT_KEY_FILE"] ?? "",
      };
    }
    const item = (await this.saved()).find((candidate) => candidate.entry.id === id);
    if (!item) return undefined;
    return {
      name: item.entry.name,
      url: item.url,
      token: item.token,
      serverCaFile: item.files?.serverCaFile ?? "",
      clientCertFile: item.files?.clientCertFile ?? "",
      clientKeyFile: item.files?.clientKeyFile ?? "",
    };
  }

  /** Saves a Gateway with `supertag connect`; returns the entry it is listed under. */
  async save(gateway: {
    name: string;
    url: string;
    token: string;
    serverCaFile?: string;
    clientCertFile?: string;
    clientKeyFile?: string;
  }): Promise<string> {
    const origin = gatewayOrigin(gateway.url);
    const existing = (await this.saved()).find((item) => item.entry.id === `saved:${origin}`);
    await saveWithCli(
      this.options.cli,
      { ...gateway, url: origin, replace: existing?.entry.name === gateway.name },
      this.options.env,
    );
    return `saved:${origin}`;
  }

  /**
   * Forgets a saved Gateway and deletes its cache: one saved with `supertag connect` with
   * `supertag disconnect`, one saved in the desktop app from the desktop's store.
   */
  async forget(entry: GatewayEntry): Promise<void> {
    if (entry.kind !== "saved") throw "Only a saved Gateway can be forgotten.";
    const origin = entry.id.replace(/^saved:/u, "");
    if (entry.source === "cli") await forgetWithCli(this.options.cli, entry.name, this.options.env);
    else await this.state.clearGateway(origin);
    await forget(this.cache, origin);
  }

  /** Adds a folder of this machine as a Workspace of the local services, with `supertag workspace add`. */
  addFolder(state: string, folder: string): Promise<AddedWorkspace> {
    return addWorkspaceWithCli(this.options.cli, state, folder, this.options.env);
  }
}

type Waiting = { resolve: (id: string) => void; reject: (error: unknown) => void };

/**
 * A `Gateway` for one entry and cache scope. It reads and writes the cache at once, and its
 * calls wait for `attach` (or fail with why connecting failed).
 */
export class TuiGateway implements Gateway {
  readonly scope: string;
  connectionId: string | undefined;
  private problem: string | undefined;
  private waiting: Waiting[] = [];

  constructor(
    private readonly connections: Connections,
    readonly entryId: string,
    readonly shown: string,
    readonly cacheScopeOf: CacheScope,
  ) {
    this.scope = cacheScope(shown, cacheScopeOf.principal);
  }

  /** The connection is current: calls go through it from now on. */
  attach(connectionId: string) {
    this.connectionId = connectionId;
    this.problem = undefined;
    for (const waiting of this.waiting.splice(0)) waiting.resolve(connectionId);
  }

  /** Connecting failed: waiting calls, and new ones until the next attempt, fail with why. */
  fail(problem: string) {
    this.problem = problem;
    for (const waiting of this.waiting.splice(0)) waiting.reject(problem);
  }

  /** Another attempt to connect started: calls wait again. */
  retrying() {
    this.problem = undefined;
  }

  private ready(): Promise<string> {
    if (this.connectionId !== undefined) return Promise.resolve(this.connectionId);
    if (this.problem !== undefined) return Promise.reject(this.problem);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private get state() {
    return this.connections.state;
  }

  async tags(): Promise<Tag[]> {
    return this.state.tags(await this.ready());
  }
  async conversations(): Promise<Conversation[]> {
    return this.state.conversations(await this.ready());
  }
  async messages(read: ReadMessages): Promise<MessagePage> {
    return this.state.messages(await this.ready(), read);
  }
  async send(tagId: string, text: string, operationId: string): Promise<Message> {
    return this.state.send(await this.ready(), tagId, text, operationId);
  }
  async markRead(tagId: string, order: number): Promise<Conversation> {
    return this.state.markRead(await this.ready(), tagId, order);
  }
  events = async (taskId: string, afterSequence: number): Promise<TaskEvent[]> =>
    this.state.events(await this.ready(), taskId, afterSequence);
  async hostPhases(): Promise<HostPhases> {
    return this.state.hostPhases(await this.ready());
  }

  // Tags: creating one, and what the palette shows of one

  async tagOptions(): Promise<TagOptions> {
    return this.state.tagOptions(await this.ready());
  }
  async createTag(tag: NewTag): Promise<Tag> {
    return this.state.createTag(await this.ready(), tag);
  }
  /** Whether this connection reaches the local services, which can add a folder as a Workspace. */
  get local(): boolean {
    return this.entryId === "local";
  }
  /** Adds the folder at `path` as a Workspace of the local services; only Local has them. */
  async addFolder(folder: string): Promise<AddedWorkspace> {
    const state = await this.state.localStateOf(await this.ready());
    return this.connections.addFolder(state, folder);
  }
  async notes(tagId: string): Promise<Note[]> {
    return this.state.notes(await this.ready(), tagId);
  }
  async deleteNote(memoryId: string): Promise<Note> {
    return this.state.deleteNote(await this.ready(), memoryId);
  }
  async schedules(tagId: string): Promise<Schedule[]> {
    return this.state.schedules(await this.ready(), tagId);
  }
  async changeSchedule(scheduleId: string, action: ScheduleAction): Promise<Schedule> {
    return this.state.changeSchedule(await this.ready(), scheduleId, action);
  }
  async networkLogs(tagId: string): Promise<NetworkLog[]> {
    return this.state.networkLogs(await this.ready(), tagId);
  }
  async tagActivity(tagId: string): Promise<TagActivity> {
    return this.state.tagActivity(await this.ready(), tagId);
  }

  // Objectives, the inbox, Teams, Work Sessions

  async objectives(): Promise<Objective[]> {
    return this.state.objectives(await this.ready());
  }
  async objective(objectiveId: string): Promise<Objective> {
    return this.state.objective(await this.ready(), objectiveId);
  }
  async createObjective(created: NewObjective): Promise<Objective> {
    return this.state.createObjective(await this.ready(), created);
  }
  async messageObjective(objectiveId: string, text: string) {
    return this.state.messageObjective(await this.ready(), objectiveId, text);
  }
  async reviewObjective(objectiveId: string, approved: boolean, feedback: string) {
    return this.state.reviewObjective(await this.ready(), objectiveId, approved, feedback);
  }
  async taskResult(taskId: string) {
    return this.state.taskResult(await this.ready(), taskId);
  }
  async inbox(): Promise<InboxItem[]> {
    return this.state.inbox(await this.ready());
  }
  async approval(approvalId: string): Promise<ApprovalDetails> {
    return this.state.approval(await this.ready(), approvalId);
  }
  async answerQuestion(taskId: string, text: string) {
    return this.state.answerQuestion(await this.ready(), taskId, text);
  }
  async decideApproval(approvalId: string, approve: boolean, reason: string) {
    return this.state.decideApproval(await this.ready(), approvalId, approve, reason);
  }
  async teams(): Promise<Team[]> {
    return this.state.teams(await this.ready());
  }
  async workstreamPosts(teamId: string): Promise<WorkstreamPost[]> {
    return this.state.workstreamPosts(await this.ready(), teamId);
  }
  async workSessions(tagId: string, sessionId: string): Promise<WorkSession[]> {
    return this.state.workSessions(await this.ready(), tagId, sessionId);
  }
  async workBranch(work: WorkSession): Promise<WorkBranch | undefined> {
    return this.state.workBranch(await this.ready(), work);
  }
  async taskActivity(taskId: string): Promise<string[]> {
    return this.state.taskActivity(await this.ready(), taskId);
  }
  /** Where a delivery's diff is computed: the directory the terminal UI was started in. */
  workDirectory = process.cwd();
  /** Opens a web address in the browser; tests replace it. */
  opener: (url: string) => void = openUrl;
  diff(branch: WorkBranch): Promise<WorkDiff> {
    return deliveryDiff(this.workDirectory, branch);
  }
  /** Opens a pull request in the browser. */
  open(url: string): void {
    this.opener(url);
  }

  /** An own property, as the follow hook calls it unbound. */
  follow = async (
    read: ReadMessages,
    receive: (update: FollowUpdate) => void,
  ): Promise<() => Promise<void>> => {
    const connectionId = await this.ready();
    const id = this.state.startFollow(connectionId, read, subscriber(receive));
    return async () => this.state.stopFollow(id);
  };

  /** Opens the connection's Watch, as `useGatewayWatch` starts it. */
  watch = async (
    connectionId: string,
    watchEpoch: number,
    receive: (update: WatchUpdate) => void,
  ): Promise<() => Promise<void>> => {
    const id = this.state.startWatch(connectionId, watchEpoch, subscriber(receive));
    return async () => this.state.stopWatch(id);
  };

  async readCache(key: CacheKey): Promise<unknown> {
    if (!validKey(key)) return null;
    const value = await readEntry(entryPath(this.connections.cache, this.cacheScopeOf, key));
    return value === undefined ? null : value;
  }
  async writeCache(key: CacheKey, value: unknown): Promise<void> {
    if (!validKey(key)) return;
    await writeEntry(entryPath(this.connections.cache, this.cacheScopeOf, key), value);
  }
}

function subscriber<U>(receive: (update: U) => void): Subscriber<U> {
  let ended = false;
  return {
    send(update) {
      if (ended) return false;
      receive(update);
      return true;
    },
    onEnd() {},
    end() {
      ended = true;
    },
  };
}
