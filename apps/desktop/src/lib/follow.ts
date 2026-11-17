import { useEffect, useRef, useState } from "react";
import type { FollowUpdate, Gateway, MessagePage, ReadMessages } from "../gateway";

/** Why each queued turn still waits for a Worker Host, by Task ID. */
export type Waits = ReadonlyMap<string, string>;

const none: Waits = new Map();

/** The text of the message each running turn is writing now, by Task ID. */
export type Texts = ReadonlyMap<string, string>;

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

/** Applies a follow's update to the text running turns are writing; empty text clears one. */
export function nextTexts(texts: Texts, update: FollowUpdate): Texts {
  if (update.kind !== "changed" || !update.texts?.length) return texts;
  const next = new Map(texts);
  for (const { taskId, text } of update.texts) {
    if (text) next.set(taskId, text);
    else next.delete(taskId);
  }
  return next;
}

/**
 * Follows the conversation with `tagId`, from the copy `request` describes when the
 * follow opens. Each page of changes goes to `apply`. `live` (and `connected`, for rendering) says
 * the stream is open, so the view needs no reads of its own; the waits say why queued turns wait,
 * and the texts what running turns are writing.
 */
export function useConversationFollow(
  gateway: Gateway,
  tagId: string,
  request: () => ReadMessages,
  apply: (page: MessagePage) => void,
): { live: React.RefObject<boolean>; connected: boolean; waits: Waits; texts: Texts } {
  const live = useRef(false);
  const [connected, setConnected] = useState(false);
  const [waits, setWaits] = useState<Waits>(none);
  const [texts, setTexts] = useState<Texts>(none);
  const latest = useRef({ request, apply });
  latest.current = { request, apply };
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Tag is another conversation to follow.
  useEffect(() => {
    const follow = gateway.follow;
    if (!follow) return;
    let closed = false;
    setWaits(none);
    setTexts(none);
    const stopping = follow(latest.current.request(), (update) => {
      if (closed) return;
      if (update.kind === "changed") {
        if (update.messages) latest.current.apply(update.messages);
        setWaits((prior) => nextWaits(prior, update));
        setTexts((prior) => nextTexts(prior, update));
      } else {
        live.current = update.kind === "ready";
        setConnected(live.current);
        // Text is shown only while the stream is open; the recorded messages have it.
        if (!live.current) setTexts(none);
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
  }, [gateway, tagId]);
  return { live, connected, waits, texts };
}
