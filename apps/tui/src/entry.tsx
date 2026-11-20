/**
 * One exchange of a conversation, as the desktop app shows it: the person's message on the
 * right with its delivery under the last one, the Tag's messages on the left in Markdown, the
 * text it is writing as it streams, animated dots while it works, why a queued turn waits, and
 * what a settled turn says when it did not succeed. A time divider precedes it when 15 minutes
 * passed. Activity never shows here: the conversation has only messages.
 */
import {
  dividerLabel,
  fromOperator,
  type Gateway,
  type Message,
  RUNNING,
  turnNotice,
  turnView,
} from "@supertag/client/model";
import { useTurnEvents } from "@supertag/client/react";
import { memo, useEffect, useState } from "react";
import { safe } from "./text";
import { color, Markdown } from "./ui";

export interface EntryProps {
  message: Message;
  /** The turn this message joined, when it is the last that joined it: its reply shows here. */
  answers?: Message | undefined;
  /** Only the person's message shows: its reply shows after a later message that joined it. */
  replyLater: boolean;
  readEvents: Gateway["events"];
  wait?: string | undefined;
  writing?: string | undefined;
  delivery?: string | undefined;
  divider?: number | undefined;
  /** Under the reply that created an Objective: how it stands, once it needs a person or ended. */
  home?: string | undefined;
  /** Under an uncertain turn: what it waits for and the keys that decide about it. */
  decide?: string | undefined;
}

export const Entry = memo(function Entry(props: EntryProps) {
  const { message, answers, replyLater, wait, writing, delivery, divider, home, decide } = props;
  const own = fromOperator(message);
  const joined = own && message.liveInput?.state === "accepted";
  const turn = answers ?? (joined ? undefined : message);
  const events = useTurnEvents(props.readEvents, turn ? { ...turn, taskId: turn.task.taskId } : {});
  const shown = answers ?? message;
  const { task } = shown;
  const input = !answers && own ? message.liveInput : undefined;
  const notice = turnNotice(task.state, input?.state);
  const inputJoined = input?.state === "accepted";
  const view = turnView(inputJoined ? [] : events, task.result);
  const working = RUNNING.has(task.state);
  const written = !inputJoined && !task.result && writing?.trim() ? writing : undefined;
  const typing = working && !inputJoined && !task.result;
  const waiting =
    turn && (turn.task.state === "queued" || turn.task.waitingForHolder) ? wait : undefined;
  const bubbles = [...view.messages, ...(task.result && !inputJoined ? [task.result] : [])];
  const caption =
    shown.workSessionReportId !== undefined
      ? "Report from a work Session"
      : shown.scheduleId !== undefined
        ? "On a Schedule"
        : undefined;
  return (
    <box flexDirection="column" flexShrink={0}>
      {divider !== undefined ? (
        <box flexDirection="row" justifyContent="center" marginTop={1}>
          <text fg={color.faint}>── {dividerLabel(divider)} ──</text>
        </box>
      ) : null}
      {own && message.task.prompt ? (
        <box flexDirection="column" alignItems="flex-end" marginTop={1}>
          <box maxWidth="75%" flexDirection="column" alignItems="flex-end">
            <text fg={color.you}>{safe(message.task.prompt)}</text>
          </box>
          {delivery ? <DeliveryLine text={delivery} /> : null}
        </box>
      ) : null}
      {!replyLater && (bubbles.length || written || typing || caption || notice || waiting) ? (
        <box flexDirection="column" marginTop={1} maxWidth="90%">
          {caption ? <text fg={color.muted}>{caption}</text> : null}
          {bubbles.map((text, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a turn's messages are append-only.
            <Markdown key={index} text={text} />
          ))}
          {written ? <Markdown text={written} streaming /> : null}
          {typing && !written ? <Dots /> : null}
          {waiting ? (
            <text fg={color.muted}>Waiting for a Worker Host: {safe(waiting)}</text>
          ) : null}
          {notice && !typing && notice.tone !== "muted" ? (
            <text fg={notice.tone === "error" ? color.error : color.warning}>{notice.text}</text>
          ) : null}
          {decide && !typing ? <text fg={color.muted}>{safe(decide)}</text> : null}
          {home ? <text fg={color.accent}>· {safe(home)}</text> : null}
        </box>
      ) : null}
    </box>
  );
});

/** Delivery under the person's last message: Sent, Seen, or why it did not arrive. */
export function DeliveryLine({ text }: { text: string }) {
  const failed = text === "Not delivered" || text === "Delivery uncertain";
  return <text fg={failed ? color.error : color.faint}>{failed ? `! ${text}` : text}</text>;
}

/** The Tag is working: three dots, one more lit each step. */
function Dots() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => (s + 1) % 4), 400);
    return () => clearInterval(timer);
  }, []);
  return <text fg={color.muted}>{"·".repeat(step || 1).padEnd(3, " ")}</text>;
}
