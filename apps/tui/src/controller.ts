/**
 * Which Gateway the terminal UI shows, and how its connection is going. It opens the startup
 * choice, switches when the chooser picks another (ending every call and stream of the one it
 * replaces), keeps trying a connection that failed, and remembers each entry's cache scope so
 * the next launch paints from the cache before connecting. Screens read it through `subscribe`.
 */
import { describe } from "@supertag/client/model";
import { type RestartStep, shouldStart } from "@supertag/client/node";
import { type Connections, type GatewayEntry, TuiGateway } from "./connection";
import type { Launch } from "./launch";
import { type Preferences, savePreferences } from "./preferences";

export type ConnectionStatus =
  | { kind: "choosing" }
  | { kind: "connecting" }
  | { kind: "connected"; principal: string }
  | { kind: "failed"; problem: string }
  /** `supertag up` is starting the local services, which were set up but stopped. */
  | { kind: "starting" }
  /** Starting or restarting the local services failed: what the CLI printed. */
  | { kind: "startFailed"; problem: string }
  /** SuperTag is not set up on this machine; connecting keeps trying, quietly. */
  | { kind: "notSetUp"; stateDirectory: string }
  /** The local Gateway runs an older release; restarting it with this one is offered. */
  | { kind: "upgrade"; running: string; version: string }
  | { kind: "restarting"; step: RestartStep };

/** The states the local services panel shows, over the conversations or in place of them. */
export const LOCAL_STATES: ReadonlySet<ConnectionStatus["kind"]> = new Set([
  "starting",
  "startFailed",
  "notSetUp",
  "upgrade",
  "restarting",
]);

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class Controller {
  gateway: TuiGateway | undefined;
  entry: GatewayEntry | undefined;
  status: ConnectionStatus = { kind: "connecting" };
  private listeners = new Set<() => void>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  /**
   * Opening Local starts its stopped services, once: at a launch without `--gateway`, and when
   * the chooser opens Local. A Gateway that stops later reconnects instead.
   */
  private startLocal = false;

  constructor(
    readonly connections: Connections,
    readonly preferences: Preferences,
    private readonly preferencesFile: string | undefined,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  savePreferences(change: Partial<Preferences>) {
    Object.assign(this.preferences, change);
    if (this.preferencesFile) savePreferences(this.preferencesFile, this.preferences);
  }

  /**
   * What to open first: `--gateway`, else a launch URL, else the Gateway used last if it is
   * still listed, else Local when it runs or was set up, else the first saved one, else Local
   * when SuperTag is not set up here (which says how to set it up); none opens the chooser.
   * Without `--gateway`, Local's services that were set up but are stopped start when it opens,
   * as the desktop app starts them.
   */
  async startupEntry(launch: Launch, launchUrl?: string): Promise<string | undefined> {
    if (launch.gateway === "local") return "local";
    if (launchUrl !== undefined) return `url:${launchUrl}`;
    if (launch.gateway) {
      const named = await this.connections.byName(launch.gateway);
      if (!named) throw `No saved Gateway is named ${JSON.stringify(launch.gateway)}.`;
      return named.id;
    }
    this.startLocal = true;
    const last = this.preferences.lastGateway;
    // The last Gateway's cached conversations paint before the CLI is even asked.
    if (last === "local" || launch.stateDirectory) return "local";
    const entries = await this.connections.entries();
    if (last && entries.some((entry) => entry.id === last)) return last;
    const local = this.connections.local;
    if (local && (local.running || shouldStart(local))) return "local";
    const saved = entries.find((entry) => entry.kind === "saved")?.id;
    if (saved) return saved;
    return local ? "local" : undefined;
  }

  /** Shows the chooser without a Gateway. */
  choose() {
    this.status = { kind: "choosing" };
    this.changed();
  }

  /**
   * Opens `id`: its cache at once when its scope is known, then the connection. `start` starts
   * Local's services when they were set up and are stopped, as the chooser opens Local.
   */
  open(id: string, entry?: GatewayEntry, options: { start?: boolean } = {}): Promise<void> {
    if (options.start) this.startLocal = true;
    clearTimeout(this.retryTimer);
    this.connections.state.disconnect();
    const attempt = ++this.attempt;
    const known = this.preferences.scopes[id];
    this.entry = entry ?? {
      id,
      name: id === "local" ? "Local" : id.replace(/^(saved|url):/u, ""),
      detail: "",
      kind: id === "local" ? "local" : id.startsWith("url:") ? "launch" : "saved",
      available: true,
    };
    this.gateway = known ? new TuiGateway(this.connections, id, shownOf(id), known) : undefined;
    this.status = { kind: "connecting" };
    this.changed();
    return this.connect(attempt, id, FIRST_RETRY_MS);
  }

  private async connect(attempt: number, id: string, retryMs: number): Promise<void> {
    this.gateway?.retrying();
    try {
      const connection = await this.connections.resolve(id);
      const activation = await this.connections.connect(connection);
      if (attempt !== this.attempt) return;
      if (id === "local") this.startLocal = false;
      let gateway = this.gateway;
      if (
        !gateway ||
        gateway.cacheScopeOf.gateway !== activation.scope.gateway ||
        gateway.cacheScopeOf.principal !== activation.scope.principal
      ) {
        gateway = new TuiGateway(this.connections, id, connection.shown, activation.scope);
      }
      gateway.attach(activation.connectionId);
      this.gateway = gateway;
      this.status = { kind: "connected", principal: activation.principal };
      this.savePreferences({
        lastGateway: id,
        scopes: { ...this.preferences.scopes, [id]: activation.scope },
      });
      this.changed();
    } catch (error) {
      if (attempt !== this.attempt) return;
      const problem = describe(error);
      const local = id === "local" ? this.connections.local : undefined;
      if (this.startLocal && shouldStart(local)) {
        this.startLocal = false;
        return this.start(attempt);
      }
      if (local?.running) {
        // An older local release refuses this one's protocol: offer to restart it instead of
        // trying again, which can never succeed.
        const upgrade = await this.connections.localUpgrade(local);
        if (attempt !== this.attempt) return;
        if (upgrade) {
          this.gateway?.fail(problem);
          this.status = { kind: "upgrade", ...upgrade };
          this.changed();
          return;
        }
      }
      this.gateway?.fail(problem);
      this.status =
        local && !local.running && !local.setUp
          ? { kind: "notSetUp", stateDirectory: local.stateDirectory }
          : { kind: "failed", problem };
      this.changed();
      // Keep trying: the local services may be starting or being set up, or the network may
      // come back.
      this.retryTimer = setTimeout(
        () => void this.connect(attempt, id, Math.min(retryMs * 2, MAX_RETRY_MS)),
        retryMs,
      );
    }
  }

  /** Starts Local's stopped services with `supertag up`, then connects. */
  private async start(attempt: number): Promise<void> {
    this.status = { kind: "starting" };
    this.changed();
    try {
      await this.connections.startLocal();
    } catch (error) {
      if (attempt !== this.attempt) return;
      const problem = describe(error);
      this.gateway?.fail(problem);
      this.status = { kind: "startFailed", problem };
      this.changed();
      return;
    }
    if (attempt !== this.attempt) return;
    this.status = { kind: "connecting" };
    this.changed();
    return this.connect(attempt, "local", FIRST_RETRY_MS);
  }

  /** After starting or restarting failed: open Local again, starting it if it is stopped. */
  retryLocal(): Promise<void> {
    return this.open("local", this.entry, { start: true });
  }

  /**
   * Restarts an older local Gateway with this release (`supertag down`, then `supertag up`),
   * then connects. Running Tasks are interrupted; the screen asks before calling this.
   */
  async restartLocal(): Promise<void> {
    if (this.status.kind !== "upgrade") return;
    clearTimeout(this.retryTimer);
    this.connections.state.disconnect();
    const attempt = ++this.attempt;
    const step = (step: RestartStep) => {
      if (attempt !== this.attempt) return;
      this.status = { kind: "restarting", step };
      this.changed();
    };
    step("stopping");
    try {
      await this.connections.restartLocal(step);
    } catch (error) {
      if (attempt !== this.attempt) return;
      const problem = describe(error);
      this.gateway?.fail(problem);
      this.status = { kind: "startFailed", problem };
      this.changed();
      return;
    }
    if (attempt !== this.attempt) return;
    this.status = { kind: "connecting" };
    this.changed();
    return this.connect(attempt, "local", FIRST_RETRY_MS);
  }

  /** A saved Gateway was forgotten: its scope goes, and if it was open, the chooser shows. */
  forgot(id: string) {
    const { [id]: _, ...scopes } = this.preferences.scopes;
    this.savePreferences({
      scopes,
      ...(this.preferences.lastGateway === id ? { lastGateway: undefined } : {}),
    });
    if (this.entry?.id !== id) return;
    this.close();
    this.gateway = undefined;
    this.entry = undefined;
    this.choose();
  }

  close() {
    clearTimeout(this.retryTimer);
    this.attempt++;
    this.connections.state.disconnect();
  }
}

function shownOf(id: string): string {
  if (id === "local") return "local";
  return id.replace(/^(saved|url):/u, "");
}
