import type {
  Gateway,
  HarnessMemory,
  HarnessMemoryList,
  NetworkLog,
  NetworkRequest,
  Tag,
  TagActivity,
  WatchUpdate,
} from "@supertag/client/model";
import { describe } from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { Lock, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AvatarEditing, AvatarEditorDialog } from "./avatar-editor";
import { ScheduleList } from "./schedules";
import { relativeTime } from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import { Button } from "./ui/button";

/**
 * The Tag details panel beside the conversation, opened from the Tag's name: one section per
 * kind of thing the Tag keeps, each reading its own data. The conversation itself stays messages
 * only.
 */
export function TagDetails({
  gateway,
  watch,
  tag,
  avatar,
  onClose,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
  /** Changes the Tag's portrait, when this connection may manage Tags. */
  avatar?: AvatarEditing;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus moves into the panel, and back to what opened it once the panel closes.
    const opener = document.activeElement;
    close.current?.focus();
    return () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        document.activeElement === document.body
      ) {
        opener.focus();
      }
    };
  }, []);
  // Esc closes the panel, unless a dialog or menu is open: that one takes Esc first.
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      closing.current();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);
  const name = tag.name ?? tag.tagId;
  return (
    <aside id="tag-details" className="activity tag-details" aria-label={`${name} details`}>
      <div className="activity-header">
        <h2>{name}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button"
          ref={close}
          aria-label="Close Tag details"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      <AvatarSection tag={tag} editing={avatar} />
      <ActivitySection gateway={gateway} watch={watch} tag={tag} />
      <MemorySection gateway={gateway} watch={watch} tag={tag} />
      <ScheduleList gateway={gateway} watch={watch} tagId={tag.tagId} />
      <NetworkSection gateway={gateway} watch={watch} tag={tag} />
    </aside>
  );
}

/**
 * The Tag's portrait, which everyone who can see the Tag sees, and the way into its editor for a
 * principal that may manage Tags. The name in the panel's heading names it.
 */
function AvatarSection({ tag, editing }: { tag: Tag; editing?: AvatarEditing }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const name = tag.name ?? tag.tagId;
  return (
    <section className="details-section details-avatar" aria-label="Avatar">
      <TagAvatar tag={tag} large />
      {editing ? (
        <>
          <Button
            ref={opener}
            variant="outline"
            className="secondary"
            onClick={() => setOpen(true)}
          >
            Edit avatar
          </Button>
          <AvatarEditorDialog
            tag={tag}
            editing={editing}
            open={open}
            onOpenChange={setOpen}
            opener={opener}
          />
        </>
      ) : (
        <p className="tag-details-intro">Only an operator can change {name}'s avatar.</p>
      )}
    </section>
  );
}

/** How often the Tag's memory is read again; a turn that changes it is also a conversation change. */
const MEMORY_INTERVAL = 30_000;

const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
};

/**
 * What the details panel says of a memory: whose harness keeps it, what it is about, who sees it,
 * whether it waits for the Tag's daily memory review or a turn that may not write the Tag's
 * memory last changed it, and when.
 */
export function memoryCaption(memory: HarnessMemory, now = Date.now()): string {
  const parts = [
    HARNESS_NAMES[memory.harness] ?? memory.harness,
    memory.kind,
    memory.private ? "Only you" : "Shared",
  ];
  if (memory.status === "proposed") parts.push("waits for the daily memory review");
  else if (memory.trust === "proposed-only") parts.push("changed by a Work Session");
  parts.push(`kept ${relativeTime(memory.updatedAtMs, now)}`);
  return parts.join(" · ");
}

/** What deleting a memory does: a proposal is dropped before the review merges it. */
function deleteLabel(memory: HarnessMemory): string {
  return memory.status === "proposed" ? "Drop proposed memory" : "Delete memory";
}

/**
 * The Tag's memory, which its harness keeps, such as Claude Code's auto-memory, as this Mac's
 * Worker Host reads it from the harness's files, with the changes Work Sessions proposed to it;
 * each can be deleted. It never passes through the Control Plane, so a shared Gateway's Tags show
 * none here.
 */
export function MemorySection({
  gateway,
  watch,
  tag,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [list, setList] = useState<HarnessMemoryList>();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!gateway.harnessMemory) return;
      try {
        const next = await gateway.harnessMemory(tagId);
        if (signal.aborted) return;
        setList(next);
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [gateway, tagId],
  );
  // A finished turn is when the harness may have changed its memory.
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "conversation" && update.tagId === tagId,
    [tagId],
  );
  const refresh = useWatchRefresh(read, MEMORY_INTERVAL, watch, affected);

  async function remove(memory: HarnessMemory) {
    if (!gateway.deleteHarnessMemory || deleting) return;
    setDeleting(memory.memoryId);
    try {
      await gateway.deleteHarnessMemory(memory.memoryId);
      setList(
        (prior) =>
          prior && {
            ...prior,
            memories: prior.memories.filter(({ memoryId }) => memoryId !== memory.memoryId),
          },
      );
      setError("");
      refresh();
    } catch (error) {
      setError(describe(error));
    } finally {
      setDeleting(undefined);
    }
  }

  if (!gateway.harnessMemory) return null;
  const name = tag.name ?? tag.tagId;
  const memories = list?.memories ?? [];
  const status =
    error ||
    (list === undefined
      ? "Loading memory…"
      : (list.unavailable ?? (memories.length ? "" : `${name} keeps no memory on this Mac yet.`)));
  return (
    <section className="details-section" aria-labelledby="tag-details-memory">
      <h3 id="tag-details-memory">Memory</h3>
      <p className="tag-details-intro">
        What {name} keeps between turns, on this Mac's Worker Host. Delete one to have it forget it.
      </p>
      {status && (
        <p className="activity-status" role="status">
          {status}
        </p>
      )}
      {list && list.keptOn.length > 0 && (
        <p className="activity-status">
          More is kept on Worker Host {list.keptOn.join(", ")}, and shows only there.
        </p>
      )}
      <ul className="memories" aria-label="Memory">
        {memories.map((memory) => (
          <li key={memory.memoryId} className="memory" data-status={memory.status}>
            <p className="memory-text">
              <strong>{memory.title}</strong>
              {memory.title && memory.text ? " — " : ""}
              {memory.text}
              {memory.truncated ? "…" : ""}
            </p>
            <div className="details-footer">
              <small>
                {memory.status === "proposed" && <span className="memory-badge">Proposed</span>}
                {memory.private && <Lock size={11} aria-hidden />}
                {memoryCaption(memory)}
              </small>
              {gateway.deleteHarnessMemory && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="icon-button"
                  aria-label={`${deleteLabel(memory)}: ${memory.title || memory.text}`}
                  title={deleteLabel(memory)}
                  disabled={deleting !== undefined}
                  onClick={() => void remove(memory)}
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How often the network log is read again; it changes only when a Task Attempt ends. */
const NETWORK_INTERVAL = 30_000;

/** One line of the network log: `GET https://api.github.com/repos/acme → 200 · github`. */
export function networkRequestLine(request: NetworkRequest): string {
  const target = `${request.method} ${request.origin}${request.path}`;
  if (!request.allowed) return `${target} refused: ${request.reason ?? "outside the scope"}`;
  const parts = [`${target} → ${request.status ?? "no answer"}`];
  if (request.credential) parts.push(`with ${request.credential}`);
  return parts.join(" · ");
}

/** A Task Attempt's totals: `3 allowed · 1 refused`, and how many were not kept. */
export function networkTotals(log: NetworkLog): string {
  const parts = [`${log.allowed} allowed`, `${log.denied} refused`];
  if (log.unrecorded) parts.push(`${log.unrecorded} more not listed`);
  return parts.join(" · ");
}

/**
 * What the Tag's Task Attempts sent through their Worker Host's egress proxy, for Tasks whose
 * Permission Sets limit web:fetch: each request allowed or refused, newest Task Attempt first.
 * Only operators may read it.
 */
export function NetworkSection({
  gateway,
  watch,
  tag,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [logs, setLogs] = useState<NetworkLog[]>();
  const [error, setError] = useState("");
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!gateway.networkLogs) {
        setLogs([]);
        return;
      }
      try {
        const next = await gateway.networkLogs(tagId);
        if (signal.aborted) return;
        setLogs(next);
        setError("");
      } catch (error) {
        if (signal.aborted) return false;
        const text = describe(error);
        setError(
          // The desktop words a permission-denied refusal as "cannot access".
          /cannot access|permission|denied|operator/i.test(text)
            ? "Only operators can see the network log."
            : text,
        );
        return false;
      }
    },
    [gateway, tagId],
  );
  // A conversation change is the sign that one of the Tag's turns ended.
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "conversation" && update.tagId === tagId,
    [tagId],
  );
  useWatchRefresh(read, NETWORK_INTERVAL, watch, affected);
  const name = tag.name ?? tag.tagId;
  const status =
    error ||
    (logs === undefined
      ? "Loading the network log…"
      : logs.length
        ? ""
        : `No network log yet. ${name}'s Tasks get one when its Permission Sets limit web:fetch to hosts.`);
  return (
    <section className="details-section" aria-labelledby="tag-details-network">
      <h3 id="tag-details-network">Network</h3>
      <p className="tag-details-intro">
        Web requests {name}'s Tasks made through the Worker Host, allowed or refused.
      </p>
      {status && (
        <p className="activity-status" role="status">
          {status}
        </p>
      )}
      <ul className="network-logs" aria-label="Network log">
        {logs?.map((log) => (
          <li key={log.attemptId} className="network-log">
            <div className="details-footer">
              <small>Task {log.taskId.slice(0, 8)}</small>
              <small>{networkTotals(log)}</small>
            </div>
            <ul className="network-requests">
              {log.requests.map((request) => (
                <li
                  key={`${request.atMs}-${request.method}-${request.origin}${request.path}-${request.status ?? request.reason}`}
                  className={request.allowed ? "network-request" : "network-request refused"}
                  title={new Date(request.atMs).toLocaleString()}
                >
                  {networkRequestLine(request)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How often the activity is read again while the watch is down. */
const ACTIVITY_INTERVAL = 60_000;

/** A period in words: `hour`, `2 hours`, `day`, `30 minutes`. */
export function periodWords(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return count === 1 ? unit : `${count} ${unit}s`;
    }
  }
  return `${Math.round(ms / 1000)} seconds`;
}

/** The unprompted messages in one line: `6 posted · 4 read · 2 answered · 19 stayed quiet`. */
export function attentionLine(activity: TagActivity): string {
  return [
    `${activity.posted} posted`,
    `${activity.read} read`,
    `${activity.answered} answered`,
    `${activity.quiet} stayed quiet`,
  ].join(" · ");
}

/** An idle Objective in one line: `Ship SSO · idle since 4:01 PM`. */
export function idleObjectiveLine(
  idle: NonNullable<TagActivity["idleObjectives"]>[number],
  now = Date.now(),
): string {
  const outcome = idle.outcome.split("\n")[0]?.trim() || idle.objectiveId;
  return `${outcome} · idle since ${relativeTime(idle.idleSinceMs, now)}`;
}

/** The start rate in one line: `At most 10 per hour · 3 started in the last hour`. */
export function startRateLine(rate: NonNullable<TagActivity["startRate"]>): string {
  const period = periodWords(rate.perMs);
  return `At most ${rate.starts} per ${period} · ${rate.inWindow} started in the last ${period}`;
}

/**
 * How the Tag's messages that no person asked for landed lately, and how often its work may
 * start: what `supertag describe tag` shows under attention and start rate.
 */
export function ActivitySection({
  gateway,
  watch,
  tag,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [activity, setActivity] = useState<TagActivity>();
  const [error, setError] = useState("");
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!gateway.tagActivity) return;
      try {
        const next = await gateway.tagActivity(tagId);
        if (signal.aborted) return;
        setActivity(next);
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [gateway, tagId],
  );
  // A conversation change is the sign that one of the Tag's turns ended.
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "conversation" && update.tagId === tagId,
    [tagId],
  );
  useWatchRefresh(read, ACTIVITY_INTERVAL, watch, affected);
  if (!gateway.tagActivity) return null;
  const name = tag.name ?? tag.tagId;
  const days = activity?.windowDays || 30;
  const sent = activity && (activity.posted || activity.quiet);
  return (
    <section className="details-section" aria-labelledby="tag-details-activity">
      <h3 id="tag-details-activity">Activity</h3>
      {error || !activity ? (
        <p className="activity-status" role="status">
          {error || "Loading activity…"}
        </p>
      ) : (
        <dl className="tag-activity">
          <dt>Unprompted, last {days} days</dt>
          <dd title="Schedule wake-ups and Objective notices. Read counts only conversations; other surfaces have no read receipts.">
            {sent ? attentionLine(activity) : `${name} sent nothing unprompted.`}
          </dd>
          <dt>Start rate</dt>
          <dd>{activity.startRate ? startRateLine(activity.startRate) : "None"}</dd>
          {activity.idleObjectives && activity.idleObjectives.length > 0 && (
            <>
              <dt>Idle Objectives</dt>
              {activity.idleObjectives.map((idle) => (
                <dd key={idle.objectiveId} title={idle.objectiveId}>
                  {idleObjectiveLine(idle)}
                </dd>
              ))}
            </>
          )}
        </dl>
      )}
    </section>
  );
}
