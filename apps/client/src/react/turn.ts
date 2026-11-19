import { useEffect, useMemo, useState } from "react";
import type { Gateway, TaskEvent } from "../model/gateway";
import { mergeEvents } from "../model/turn";

/**
 * The events a turn shows. Its message carries them, and the conversation's follow pushes each
 * change to the message, so only a turn whose message left earlier events out reads them, once.
 */
export function useTurnEvents(
  events: Gateway["events"] | undefined,
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
