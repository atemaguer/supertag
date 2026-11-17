import { Lock, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlPlane, Note, Tag, WatchUpdate } from "../control-plane";
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
                {note.private && <Lock size={11} aria-hidden />} {noteCaption(note)}
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
