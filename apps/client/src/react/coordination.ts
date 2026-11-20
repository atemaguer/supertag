/**
 * The work around conversations, kept current: the Gateway's Objectives, the inbox items waiting
 * on an operator, and its Teams. The Watch says when an Objective, a Team, or a turn outside a
 * conversation changed; while it is down they are read every few seconds, and the inbox, which
 * has no Watch of its own, is also read on a slow timer. A connection that may not read one of
 * them (a client device, for the inbox) shows none of it.
 */
import { useCallback, useEffect, useState } from "react";
import type { InboxItem, Objective, Team } from "../model/coordination";
import type { Gateway, WatchUpdate } from "../model/gateway";
import { useWatchRefresh, type WatchFeed } from "./watch";

export interface Coordination {
  objectives: Objective[];
  inbox: InboxItem[];
  teams: Team[];
  /** Whether a first read finished. */
  loaded: boolean;
  /** Reads everything again now, as after acting on an item. */
  refresh(): void;
}

const READ_INTERVAL = 5_000;
const INBOX_INTERVAL = 15_000;

const affects = (update: WatchUpdate) =>
  update.kind === "objective" ||
  update.kind === "team" ||
  update.kind === "work" ||
  update.kind === "conversation";

export function useCoordination(
  gateway: Gateway,
  watch: WatchFeed | undefined,
  connected: boolean,
): Coordination {
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loaded, setLoaded] = useState(false);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!connected) return false;
      const settle = async <T>(call: (() => Promise<T>) | undefined, set: (value: T) => void) => {
        if (!call) return true;
        try {
          const value = await call();
          if (!signal.aborted) set(value);
          return true;
        } catch {
          return false;
        }
      };
      const results = await Promise.all([
        settle(gateway.objectives?.bind(gateway), setObjectives),
        settle(gateway.inbox?.bind(gateway), setInbox),
        settle(gateway.teams?.bind(gateway), setTeams),
      ]);
      if (!signal.aborted) setLoaded(true);
      // A refusal (a client device's inbox) is not retried faster than the Watch asks.
      return results.some(Boolean) ? undefined : false;
    },
    [gateway, connected],
  );
  const request = useWatchRefresh(read, READ_INTERVAL, watch, affects);
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(request, INBOX_INTERVAL);
    return () => clearInterval(timer);
  }, [connected, request]);
  return { objectives, inbox, teams, loaded, refresh: request };
}
