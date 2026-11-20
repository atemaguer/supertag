/**
 * The palette's panels about the selected Tag: **Memory** (what its harness keeps between turns
 * on this machine's Worker Hosts, with the changes Work Sessions proposed to it; `x` deletes
 * one), **Schedules** (its wake-ups that will still fire; `p` pauses or resumes one, `x` deletes
 * it), **Network** (what its Task Attempts' egress proxy allowed and refused; operators only) and
 * **Activity** (how its unprompted messages landed). The Watch keeps Memory and Schedules
 * current. ↑ ↓ move, Esc closes.
 */
import {
  describe,
  type HarnessMemory,
  type HarnessMemoryList,
  type NetworkLog,
  type Schedule,
  type TagActivity,
  type WatchUpdate,
} from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { type ReactNode, useCallback, useState } from "react";
import type { TuiGateway } from "./connection";
import { clip, safe, shortTime } from "./text";
import { color, type KeyEvent, useKeyboard } from "./ui";

export type PanelKind = "memory" | "schedules" | "network" | "activity";

export const PANEL_TITLES: Record<PanelKind, string> = {
  memory: "Memory",
  schedules: "Schedules",
  network: "Network",
  activity: "Activity",
};

interface PanelProps {
  gateway: TuiGateway;
  watch: WatchFeed | undefined;
  tagId: string;
  tagName: string;
  width: number;
  height: number;
  onClose(): void;
}

function Frame({
  title,
  width,
  height,
  hint,
  problem,
  children,
}: {
  title: string;
  width: number;
  height: number;
  hint: string;
  problem: string;
  children: ReactNode;
}) {
  return (
    <box
      width={width}
      maxHeight={height}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title={title}
      marginTop={2}
    >
      {children}
      {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
      <text fg={color.faint}>{hint}</text>
    </box>
  );
}

/** Reads `read` now and whenever the Watch says `affected`, polling while the Watch is down. */
function useRead<T>(
  read: () => Promise<T>,
  watch: WatchFeed | undefined,
  affected: (update: WatchUpdate) => boolean,
) {
  const [value, setValue] = useState<T | undefined>();
  const [problem, setProblem] = useState("");
  const run = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await read();
        if (signal.aborted) return;
        setValue(next);
        setProblem("");
      } catch (error) {
        if (!signal.aborted) setProblem(describe(error));
        return false;
      }
    },
    [read],
  );
  const request = useWatchRefresh(run, 5_000, watch, affected);
  return { value, problem, setProblem, request };
}

/** ↑ ↓ (k j) move within `count` rows; Esc closes; `act` gets every other key with the row. */
function useList(count: number, onClose: () => void, act: (key: KeyEvent, at: number) => void) {
  const [index, setIndex] = useState(0);
  const at = Math.min(index, Math.max(0, count - 1));
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape") onClose();
    else if (key.name === "down" || key.name === "j") setIndex(Math.min(at + 1, count - 1));
    else if (key.name === "up" || key.name === "k") setIndex(Math.max(at - 1, 0));
    else if (count > 0) act(key, at);
  });
  return at;
}

const when = (ms: number | undefined) => (ms ? shortTime(ms) : "never");

const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

/**
 * Whose harness keeps a memory, who sees it, whether it waits for the Tag's daily memory review
 * or a turn that may not write the Tag's memory last changed it, and when.
 */
function memoryCaption(memory: HarnessMemory): string {
  return [
    HARNESS_NAMES[memory.harness] ?? memory.harness,
    memory.kind,
    memory.private ? "only you" : "everyone",
    ...(memory.status === "proposed"
      ? ["waits for review"]
      : memory.trust === "proposed-only"
        ? ["changed by a Work Session"]
        : []),
    `kept ${when(memory.updatedAtMs)}`,
  ].join(" · ");
}

export function MemoryPanel(props: PanelProps) {
  const { gateway, tagId } = props;
  const read = useCallback(() => gateway.harnessMemory(tagId), [gateway, tagId]);
  // A finished turn is when the harness may have changed its memory.
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "conversation" && update.tagId === tagId,
    [tagId],
  );
  const { value, problem, setProblem, request } = useRead<HarnessMemoryList>(
    read,
    props.watch,
    affected,
  );
  const memories = value?.memories ?? [];
  const at = useList(memories.length, props.onClose, (key, index) => {
    const memory = memories[index];
    if (key.name !== "x" || !memory) return;
    void gateway
      .deleteHarnessMemory(memory.memoryId)
      .then(request, (error) => setProblem(describe(error)));
  });
  const inner = props.width - 4;
  const elsewhere = value?.keptOn ?? [];
  return (
    <Frame
      title={`Memory · ${clip(props.tagName, 30)}`}
      width={props.width}
      height={props.height}
      problem={problem}
      hint="↑ ↓ move · x delete · Esc close"
    >
      {value === undefined && !problem ? <text fg={color.muted}>Loading memory…</text> : null}
      {value?.unavailable ? (
        <text fg={color.faint}>{safe(clip(value.unavailable, inner))}</text>
      ) : value && memories.length === 0 ? (
        <text fg={color.muted}>{safe(props.tagName)} keeps no memory on this machine yet.</text>
      ) : null}
      {elsewhere.length > 0 ? (
        <text fg={color.faint}>
          {safe(clip(`More memory is kept on Worker Host ${elsewhere.join(", ")}.`, inner))}
        </text>
      ) : null}
      {memories.slice(0, Math.max(1, props.height - 7)).map((memory, position) => {
        const selected = position === at;
        const proposed = memory.status === "proposed";
        return (
          <text
            key={memory.memoryId}
            fg={selected ? color.strong : color.text}
            bg={selected ? color.selected : undefined}
          >
            {proposed ? <span fg={color.warning}>proposed </span> : null}
            {clip(memory.title || memory.text, Math.max(10, inner - 44 - (proposed ? 9 : 0)))}
            <span fg={color.muted}> · {memoryCaption(memory)}</span>
          </text>
        );
      })}
    </Frame>
  );
}

function scheduleWhen(schedule: Schedule): string {
  const recurrence = schedule.every
    ? `${schedule.every.cron} (${schedule.every.timeZone})`
    : "once";
  const next = schedule.nextDueAtMs ?? schedule.atMs;
  return `${recurrence} · next ${next ? shortTime(next) : "—"}`;
}

export function SchedulesPanel(props: PanelProps) {
  const { gateway, tagId } = props;
  const read = useCallback(() => gateway.schedules(tagId), [gateway, tagId]);
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "schedule" && update.tagId === tagId,
    [tagId],
  );
  const { value, problem, setProblem, request } = useRead<Schedule[]>(read, props.watch, affected);
  const schedules = value ?? [];
  const at = useList(schedules.length, props.onClose, (key, index) => {
    const schedule = schedules[index];
    if (!schedule) return;
    const action =
      key.name === "x"
        ? "delete"
        : key.name === "p"
          ? schedule.state === "paused"
            ? "resume"
            : "pause"
          : undefined;
    if (action)
      void gateway
        .changeSchedule(schedule.scheduleId, action)
        .then(request, (error) => setProblem(describe(error)));
  });
  const inner = props.width - 4;
  return (
    <Frame
      title={`Schedules · ${clip(props.tagName, 30)}`}
      width={props.width}
      height={props.height}
      problem={problem}
      hint="↑ ↓ move · p pause or resume · x delete · Esc close"
    >
      {value === undefined && !problem ? <text fg={color.muted}>Loading Schedules…</text> : null}
      {value?.length === 0 ? (
        <text fg={color.muted}>{safe(props.tagName)} has no Schedules that will fire.</text>
      ) : null}
      {schedules.slice(0, Math.max(1, props.height - 6)).map((schedule, position) => {
        const detail = ` · ${schedule.state === "paused" ? "paused · " : ""}${scheduleWhen(schedule)} · by ${schedule.createdBy}`;
        return (
          <text
            key={schedule.scheduleId}
            fg={position === at ? color.strong : color.text}
            bg={position === at ? color.selected : undefined}
          >
            {clip(schedule.note || schedule.scheduleId, Math.max(10, inner - detail.length))}
            <span fg={color.muted}>{clip(detail, inner)}</span>
          </text>
        );
      })}
    </Frame>
  );
}

const never = () => false;

export function NetworkPanel(props: PanelProps) {
  const { gateway, tagId } = props;
  const read = useCallback(() => gateway.networkLogs(tagId), [gateway, tagId]);
  const { value, problem } = useRead<NetworkLog[]>(read, props.watch, never);
  const logs = value ?? [];
  const at = useList(logs.length, props.onClose, () => {});
  const log = logs[at];
  const inner = props.width - 4;
  return (
    <Frame
      title={`Network · ${clip(props.tagName, 30)}`}
      width={props.width}
      height={props.height}
      problem={problem}
      hint="↑ ↓ Task Attempt · Esc close"
    >
      {value === undefined && !problem ? <text fg={color.muted}>Loading network logs…</text> : null}
      {value?.length === 0 ? (
        <text fg={color.muted}>No Task Attempt of {safe(props.tagName)} has a network log.</text>
      ) : null}
      {log ? (
        <>
          <text fg={color.strong}>
            Task {safe(log.taskId)} · {at + 1} of {logs.length}
          </text>
          <text fg={color.muted}>
            {log.allowed} allowed · {log.denied} refused
            {log.unrecorded ? ` · ${log.unrecorded} not kept` : ""}
          </text>
          {log.requests.slice(0, Math.max(1, props.height - 8)).map((request, position) => (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: a log's requests never change.
              key={position}
              fg={request.allowed ? color.text : color.error}
            >
              {clip(
                `${request.allowed ? "✓" : "✗"} ${request.method} ${request.origin}${request.path}${request.status ? ` ${request.status}` : ""}${request.reason ? ` · ${request.reason}` : ""}`,
                inner,
              )}
            </text>
          ))}
        </>
      ) : null}
    </Frame>
  );
}

export function ActivityPanel(props: PanelProps) {
  const { gateway, tagId } = props;
  const read = useCallback(() => gateway.tagActivity(tagId), [gateway, tagId]);
  const { value, problem } = useRead<TagActivity>(read, props.watch, never);
  useList(0, props.onClose, () => {});
  return (
    <Frame
      title={`Activity · ${clip(props.tagName, 30)}`}
      width={props.width}
      height={props.height}
      problem={problem}
      hint="Esc close"
    >
      {value === undefined && !problem ? <text fg={color.muted}>Loading activity…</text> : null}
      {value ? (
        <>
          <text fg={color.text}>
            Over the last {value.windowDays} days, {safe(props.tagName)} posted {value.posted}{" "}
            {value.posted === 1 ? "message" : "messages"} nobody asked for.
          </text>
          <text fg={color.muted}>
            {value.read} read · {value.answered} answered · {value.quiet} quiet checks
          </text>
          {value.startRate ? (
            <text fg={color.muted}>
              It may start {value.startRate.starts} turns per{" "}
              {Math.round(value.startRate.perMs / 60_000)} minutes; {value.startRate.inWindow} so
              far.
            </text>
          ) : null}
          {(value.idleObjectives ?? []).map((idle) => (
            <text key={idle.objectiveId} fg={color.warning}>
              {clip(`Idle since ${shortTime(idle.idleSinceMs)}: ${idle.outcome}`, props.width - 4)}
            </text>
          ))}
        </>
      ) : null}
    </Frame>
  );
}

export const PANELS: Record<PanelKind, (props: PanelProps) => ReactNode> = {
  memory: MemoryPanel,
  schedules: SchedulesPanel,
  network: NetworkPanel,
  activity: ActivityPanel,
};
