import { useEffect, useRef, useState } from "react";
import type { ControlPlane, FollowUpdate, MessagePage, ReadMessages } from "../control-plane";

/** Why each queued turn still waits for a Worker Host, by Task ID. */
export type Waits = ReadonlyMap<string, string>;

const noWaits: Waits = new Map();

/** Applies a follow's update to the waits it pushed; an empty reason clears one. */
export function nextWaits(waits: Waits, update: FollowUpdate): Waits {
  if (update.kind !== "changed" || !update.waits?.length) return waits;
  const next = new Map(waits);
  for (const { taskId, reason } of update.waits) {
    if (reason) next.set(taskId, reason);
    else next.delete(taskId);
  }
  return next;
}

/**
 * Follows the conversation with `tagId`, from the copy `request` describes when the
 * follow opens. Each page of changes goes to `apply`. `live` (and `connected`, for rendering) says
 * the stream is open, so the view needs no reads of its own; the waits say why queued turns wait.
 */
export function useConversationFollow(
  controlPlane: ControlPlane,
  tagId: string,
  request: () => ReadMessages,
  apply: (page: MessagePage) => void,
): { live: React.RefObject<boolean>; connected: boolean; waits: Waits } {
  const live = useRef(false);
  const [connected, setConnected] = useState(false);
  const [waits, setWaits] = useState<Waits>(noWaits);
  const latest = useRef({ request, apply });
  latest.current = { request, apply };
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Tag is another conversation to follow.
  useEffect(() => {
    const follow = controlPlane.follow;
    if (!follow) return;
    let closed = false;
    setWaits(noWaits);
    const stopping = follow(latest.current.request(), (update) => {
      if (closed) return;
      if (update.kind === "changed") {
        if (update.messages) latest.current.apply(update.messages);
        setWaits((prior) => nextWaits(prior, update));
      } else {
        live.current = update.kind === "ready";
        setConnected(live.current);
      }
    });
    stopping.catch(() => {
      live.current = false;
      setConnected(false);
    });
    return () => {
      closed = true;
      live.current = false;
      setConnected(false);
      // Cleanup can race the IPC registration; stop the follow once it exists.
      void stopping.then((stop) => stop()).catch(() => {});
    };
  }, [controlPlane, tagId]);
  return { live, connected, waits };
}
