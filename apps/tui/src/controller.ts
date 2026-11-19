/**
 * Which Gateway the terminal UI shows, and how its connection is going. It opens the startup
 * choice, switches when the chooser picks another (ending every call and stream of the one it
 * replaces), keeps trying a connection that failed, and remembers each entry's cache scope so
 * the next launch paints from the cache before connecting. Screens read it through `subscribe`.
 */
import { describe } from "@supertag/client/model";
import { type Connections, type GatewayEntry, TuiGateway } from "./connection";
import type { Launch } from "./launch";
import { type Preferences, savePreferences } from "./preferences";

export type ConnectionStatus =
  | { kind: "choosing" }
  | { kind: "connecting" }
  | { kind: "connected"; principal: string }
  | { kind: "failed"; problem: string };

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
   * still listed, else Local when it runs, else the first saved one; none opens the chooser.
   */
  async startupEntry(launch: Launch, launchUrl?: string): Promise<string | undefined> {
    if (launch.gateway === "local" || (launch.stateDirectory && !launch.gateway)) return "local";
    if (launchUrl !== undefined) return `url:${launchUrl}`;
    if (launch.gateway) {
      const named = await this.connections.byName(launch.gateway);
      if (!named) throw `No saved Gateway is named ${JSON.stringify(launch.gateway)}.`;
      return named.id;
    }
    const last = this.preferences.lastGateway;
    // The last Gateway's cached conversations paint before the CLI is even asked.
    if (last === "local") return last;
    const entries = await this.connections.entries();
    if (last && entries.some((entry) => entry.id === last)) return last;
    const local = entries.find((entry) => entry.kind === "local");
    if (local?.available) return local.id;
    return entries.find((entry) => entry.kind === "saved")?.id;
  }

  /** Shows the chooser without a Gateway. */
  choose() {
    this.status = { kind: "choosing" };
    this.changed();
  }

  /** Opens `id`: its cache at once when its scope is known, then the connection. */
  open(id: string, entry?: GatewayEntry): Promise<void> {
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
      const activation = await this.connections.state.connectTo(connection);
      if (attempt !== this.attempt) return;
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
      this.gateway?.fail(problem);
      this.status = { kind: "failed", problem };
      this.changed();
      // Keep trying: the local services may be starting, or the network may come back.
      this.retryTimer = setTimeout(
        () => void this.connect(attempt, id, Math.min(retryMs * 2, MAX_RETRY_MS)),
        retryMs,
      );
    }
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
