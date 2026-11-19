import type {
  Gateway,
  NetworkLog,
  NetworkRequest,
  Note,
  Tag,
  TagActivity,
  WatchUpdate,
} from "@supertag/client/model";
import { describe } from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { Lock, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScheduleList } from "./schedules";
import { relativeTime } from "./sidebar";
import { Button } from "./ui/button";

/** How often the notes are read again while the watch is down. */
const NOTES_INTERVAL = 30_000;

/** What the details panel says of a note: who sees it, when it was kept, and last seen. */
export function noteCaption(note: Note, now = Date.now()): string {
  const parts = [
    note.private ? "Only you" : "Shared",
    `kept ${relativeTime(note.updatedAtMs || note.createdAtMs, now)}`,
    note.lastSeenAtMs ? `last used ${relativeTime(note.lastSeenAtMs, now)}` : "not used yet",
  ];
  return parts.join(" · ");
}

/**
 * The Tag details panel beside the conversation, opened from the Tag's name: one section per
 * kind of thing the Tag keeps, each reading its own data. The conversation itself stays messages
 * only.
 */
export function TagDetails({
  gateway,
  watch,
  tag,
  onClose,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
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
      <ActivitySection gateway={gateway} watch={watch} tag={tag} />
      <NotesSection gateway={gateway} watch={watch} tag={tag} />
      <ScheduleList gateway={gateway} watch={watch} tagId={tag.tagId} />
      <NetworkSection gateway={gateway} watch={watch} tag={tag} />
    </aside>
  );
}

/**
 * The notes the Tag keeps that you may see, each of which you can delete. People never write notes
 * here; they tell the Tag.
 */
export function NotesSection({
  gateway,
  watch,
  tag,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [notes, setNotes] = useState<Note[]>();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!gateway.notes) {
        setNotes([]);
        return;
      }
      try {
        const next = await gateway.notes(tagId);
        if (signal.aborted) return;
        setNotes(next);
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [gateway, tagId],
  );
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "memory" && update.tagId === tagId,
    [tagId],
  );
  const refresh = useWatchRefresh(read, NOTES_INTERVAL, watch, affected);

  async function remove(note: Note) {
    if (!gateway.deleteNote || deleting) return;
    setDeleting(note.memoryId);
    try {
      await gateway.deleteNote(note.memoryId);
      setNotes((prior) => prior?.filter(({ memoryId }) => memoryId !== note.memoryId));
      setError("");
      refresh();
    } catch (error) {
      setError(describe(error));
    } finally {
      setDeleting(undefined);
    }
  }

  const name = tag.name ?? tag.tagId;
  const status =
    error ||
    (notes === undefined
      ? "Loading notes…"
      : notes.length
        ? ""
        : `${name} keeps no notes you can see yet. Tell it what to remember.`);
  return (
    <section className="details-section" aria-labelledby="tag-details-notes">
      <h3 id="tag-details-notes">Notes</h3>
      <p className="tag-details-intro">
        What {name} keeps between turns. Delete a note to have it forget it.
      </p>
      {status && (
        <p className="activity-status" role="status">
          {status}
        </p>
      )}
      <ul className="notes" aria-label="Notes">
        {notes?.map((note) => (
          <li key={note.memoryId} className="note">
            <p className="note-text">{note.text}</p>
            <div className="note-footer">
              <small>
                {note.private && <Lock size={11} aria-hidden />}
                {noteCaption(note)}
              </small>
              {gateway.deleteNote && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="icon-button"
                  aria-label={`Delete note: ${note.text}`}
                  title="Delete note"
                  disabled={deleting !== undefined}
                  onClick={() => void remove(note)}
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
            <div className="note-footer">
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
