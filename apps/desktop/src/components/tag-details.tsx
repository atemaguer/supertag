import { Lock, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ControlPlane,
  NetworkLog,
  NetworkRequest,
  Note,
  Tag,
  WatchUpdate,
} from "../control-plane";
import { describe } from "../lib/polling";
import { useWatchRefresh, type WatchFeed } from "../lib/watch";
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
  controlPlane,
  watch,
  tag,
  onClose,
}: {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
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
      <NotesSection controlPlane={controlPlane} watch={watch} tag={tag} />
      <NetworkSection controlPlane={controlPlane} watch={watch} tag={tag} />
    </aside>
  );
}

/**
 * The notes the Tag keeps that you may see, each of which you can delete. People never write notes
 * here; they tell the Tag.
 */
export function NotesSection({
  controlPlane,
  watch,
  tag,
}: {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [notes, setNotes] = useState<Note[]>();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!controlPlane.notes) {
        setNotes([]);
        return;
      }
      try {
        const next = await controlPlane.notes(tagId);
        if (signal.aborted) return;
        setNotes(next);
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [controlPlane, tagId],
  );
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "memory" && update.tagId === tagId,
    [tagId],
  );
  const refresh = useWatchRefresh(read, NOTES_INTERVAL, watch, affected);

  async function remove(note: Note) {
    if (!controlPlane.deleteNote || deleting) return;
    setDeleting(note.memoryId);
    try {
      await controlPlane.deleteNote(note.memoryId);
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
              {controlPlane.deleteNote && (
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
  controlPlane,
  watch,
  tag,
}: {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
}) {
  const [logs, setLogs] = useState<NetworkLog[]>();
  const [error, setError] = useState("");
  const tagId = tag.tagId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!controlPlane.networkLogs) {
        setLogs([]);
        return;
      }
      try {
        const next = await controlPlane.networkLogs(tagId);
        if (signal.aborted) return;
        setLogs(next);
        setError("");
      } catch (error) {
        if (signal.aborted) return false;
        const text = describe(error);
        setError(
          /permission|denied|operator/i.test(text)
            ? "Only operators can see the network log."
            : text,
        );
        return false;
      }
    },
    [controlPlane, tagId],
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
