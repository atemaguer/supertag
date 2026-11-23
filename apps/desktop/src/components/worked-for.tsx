/**
 * The "Worked for 2m 14s" pointer under a reply whose turn took a while. It is only a way to the
 * turn's Task activity: it never shows a tool, a command, or any other activity itself. To
 * remove it, delete this file, its use in `conversation-entry.tsx`, and `.worked-for` in
 * `style.css`.
 */
import type { Message } from "@supertag/client/model";
import { ChevronRight } from "lucide-react";

/** A turn shorter than this gets no pointer. */
export const WORKED_FOR_MIN_MS = 30_000;

/**
 * How long a finished turn took, from when its message was sent to when it finished, when that
 * is known and at least `WORKED_FOR_MIN_MS`. The time it waited in the queue counts.
 */
export function workedForMs(message: Pick<Message, "completedAtMs" | "task">): number | undefined {
  const { completedAtMs, task } = message;
  if (completedAtMs === undefined || task.createdAtMs === undefined) return undefined;
  const elapsed = completedAtMs - task.createdAtMs;
  return elapsed >= WORKED_FOR_MIN_MS ? elapsed : undefined;
}

/** A duration in at most two units: `48s`, `2m 14s`, `1h 3m`. */
export function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function WorkedFor({
  ms,
  expanded,
  controls,
  onOpen,
}: {
  ms: number;
  /** The turn's Task activity is open. */
  expanded: boolean;
  controls?: string;
  onOpen(trigger: HTMLButtonElement): void;
}) {
  const text = `Worked for ${durationWords(ms)}`;
  return (
    <button
      type="button"
      className="worked-for"
      aria-label={`${text} · View Task activity`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {text}
      <ChevronRight size={12} aria-hidden />
    </button>
  );
}
