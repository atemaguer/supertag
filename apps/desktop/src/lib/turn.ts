import { useEffect, useState } from "react";
import type { ControlPlane, TaskEvent } from "../control-plane";

/** How often a running turn's events are read. */
const LIVE_INTERVAL = 1_000;
/** The most events one read returns (`list_message_events`). */
const PAGE = 100;

/** What a turn shows from its recorded events, beside its prompt and result. */
export interface TurnView {
  /** The messages the Tag wrote while it worked, in order, without the ones its result repeats. */
  messages: string[];
  /** What the Tag is doing now, while the turn runs. */
  status?: string;
}

/**
 * Each message the Tag wrote is its own message. A harness reports its last message both as it
 * writes it and as the turn's result, so trailing messages the result contains are dropped.
 * Activity and plans only show as the latest status line while the turn has no result.
 */
export function turnView(events: readonly TaskEvent[], result?: string): TurnView {
  const messages = events
    .filter((event) => event.kind === "message" && event.text.trim())
    .map((event) => event.text.trim());
  if (result !== undefined)
    while (messages.length && result.includes(messages[messages.length - 1] ?? "")) messages.pop();
  let status: string | undefined;
  if (result === undefined)
    for (const event of events) {
      if (event.kind === "message") status = undefined;
      else if (event.kind === "activity" || event.kind === "progress")
        status = eventLine(event) ?? status;
    }
  return status ? { messages, status } : { messages };
}

/** One line for an event: its text, or a plan's summary and current step. */
export function eventLine(event: TaskEvent): string | undefined {
  if (event.kind !== "progress") return event.text.trim() || undefined;
  try {
    const { progress } = JSON.parse(event.text) as {
      progress?: { summary?: string; items?: { text?: string; status?: string }[] };
    };
    const summary = progress?.summary?.trim() ?? "";
    const step = progress?.items?.find((item) => item.status === "active")?.text?.trim();
    if (step) return summary ? `${summary}: ${step}` : step;
    return summary || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The recorded events of a turn: read every second while it runs, and once when it is done.
 * Returns nothing until the first read.
 */
export function useTurnEvents(
  events: ControlPlane["events"] | undefined,
  tagId: string,
  taskId: string | undefined,
  running: boolean,
): TaskEvent[] {
  const [read, setRead] = useState<TaskEvent[]>([]);
  useEffect(() => {
    if (!events || !taskId) return;
    let stopped = false;
    let timer: number | undefined;
    let after = 0;
    const known: TaskEvent[] = [];
    async function poll() {
      try {
        for (;;) {
          const page = await events?.(tagId, taskId ?? "", after);
          if (stopped || !page) return;
          const next = page.filter((event) => event.sequence > after);
          if (!next.length) break;
          known.push(...next);
          after = next[next.length - 1]?.sequence ?? after;
          setRead([...known]);
          if (next.length < PAGE) break;
        }
      } catch {
        // Events are presentation only; the turn's state and result still show.
      }
      if (running && !stopped) timer = window.setTimeout(() => void poll(), LIVE_INTERVAL);
    }
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [events, tagId, taskId, running]);
  return read;
}
