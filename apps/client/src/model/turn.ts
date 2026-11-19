import type { TaskEvent } from "./gateway";
import { linkText } from "./preview-line";

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
  if (event.kind === "message") return linkText(event.text).trim() || undefined;
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
