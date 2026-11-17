import { useEffect, useMemo, useState } from "react";
import type { ControlPlane, TaskEvent } from "../control-plane";

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

/** Events by sequence, oldest first, each once. */
export function mergeEvents(
  known: readonly TaskEvent[],
  read: readonly TaskEvent[],
): readonly TaskEvent[] {
  if (!read.length) return known;
  if (!known.length) return read;
  return [...new Map([...known, ...read].map((event) => [event.sequence, event])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
}

/**
 * The events a turn shows. Its message carries them, and the conversation's follow pushes each
 * change to the message, so only a turn whose message left earlier events out reads them, once.
 */
export function useTurnEvents(
  events: ControlPlane["events"] | undefined,
  turn: { taskId?: string; events?: readonly TaskEvent[]; eventsTruncated?: boolean },
): readonly TaskEvent[] {
  const { taskId, eventsTruncated } = turn;
  const carried = turn.events ?? noEvents;
  const [read, setRead] = useState<readonly TaskEvent[]>(noEvents);
  useEffect(() => {
    if (!events || !taskId || !eventsTruncated) return;
    let stopped = false;
    void events(taskId, 0)
      .then((page) => {
        if (!stopped) setRead((prior) => mergeEvents(prior, page));
      })
      .catch(() => {
        // Events are presentation only; the turn's state and result still show.
      });
    return () => {
      stopped = true;
    };
  }, [events, taskId, eventsTruncated]);
  return useMemo(() => mergeEvents(carried, read), [carried, read]);
}

const noEvents: readonly TaskEvent[] = [];
