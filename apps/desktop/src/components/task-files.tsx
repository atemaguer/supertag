import { ArrowLeft, File, FileText, Folder, FolderOpen, Link2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Gateway, TaskFileEntry, TaskFilesPlace } from "../gateway";
import { describe } from "../lib/polling";
import { sessionBranch } from "../lib/session-branch";
import { CopyText } from "./conversation-entry";
import { Button } from "./ui/button";

/** How often a running Task's listing is read again. */
const LIVE_INTERVAL = 3_000;

/** A size in words: `512 B`, `4.0 KB`, `1.2 MB`. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A Task's files, read where they live. When the Task runs on this machine, the app lists its
 * checkout and opens text files read-only; binary files are listed only. Otherwise it says why the
 * files can't be read here. No file passes through SuperTag's servers.
 */
export function TaskFiles({
  gateway,
  taskId,
  session,
}: {
  gateway: Gateway;
  taskId: string;
  /** The Task's Tag and Session, to name the branch its finished work is on. */
  session?: { tagId: string; sessionId: string };
}) {
  const [branch, setBranch] = useState<string>();
  const tagId = session?.tagId;
  const sessionId = session?.sessionId;
  useEffect(() => {
    if (!tagId || !sessionId) return;
    let cancelled = false;
    sessionBranch(tagId, sessionId).then(
      (name) => !cancelled && setBranch(name),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [tagId, sessionId]);
  const [place, setPlace] = useState<TaskFilesPlace>();
  const [folder, setFolder] = useState("");
  const [entries, setEntries] = useState<TaskFileEntry[]>();
  const [open, setOpen] = useState<{ path: string; text: string }>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!gateway.locateTaskFiles) return;
    let cancelled = false;
    gateway
      .locateTaskFiles(taskId)
      .then((next) => !cancelled && setPlace(next))
      .catch((error) => !cancelled && setError(describe(error)));
    return () => {
      cancelled = true;
    };
  }, [gateway, taskId]);

  const list = useCallback(async () => {
    if (!place?.local || !gateway.listTaskFiles) return;
    try {
      setEntries(await gateway.listTaskFiles(taskId, folder));
      setError("");
    } catch (error) {
      setError(describe(error));
    }
  }, [gateway, taskId, folder, place]);

  useEffect(() => {
    void list();
    if (!place?.live) return;
    const timer = setInterval(() => void list(), LIVE_INTERVAL);
    return () => clearInterval(timer);
  }, [list, place]);

  async function view(entry: TaskFileEntry) {
    if (entry.kind === "directory") {
      setFolder(entry.path);
      setEntries(undefined);
      return;
    }
    if (!entry.text || !gateway.readTaskFile) return;
    try {
      const file = await gateway.readTaskFile(taskId, entry.path);
      setOpen({ path: file.path, text: file.text });
      setError("");
    } catch (error) {
      setError(describe(error));
    }
  }

  function up() {
    setFolder(folder.split("/").slice(0, -1).join("/"));
    setEntries(undefined);
  }

  if (!gateway.locateTaskFiles) return null;
  const reveal = gateway.revealTaskFile;
  return (
    <section className="details-section task-files" aria-labelledby="task-files-heading">
      <h3 id="task-files-heading">Files</h3>
      {error && (
        <p className="activity-status" role="status">
          {error}
        </p>
      )}
      {!place && !error && <p className="activity-status">Finding the files…</p>}
      {place && !place.local && (
        <p className="activity-status" role="status">
          {place.reason}
        </p>
      )}
      {place && !place.live && branch && <BranchHint branch={branch} />}
      {place?.local && open && (
        <div className="task-file-view">
          <div className="task-file-bar">
            <Button
              variant="ghost"
              size="icon"
              className="icon-button"
              aria-label="Back to the files"
              onClick={() => setOpen(undefined)}
            >
              <ArrowLeft size={14} aria-hidden />
            </Button>
            <span className="task-file-path" title={open.path}>
              {open.path}
            </span>
            {reveal && (
              <Button
                variant="ghost"
                size="icon"
                className="icon-button"
                aria-label={`Show ${open.path} in Finder`}
                title="Show in Finder"
                onClick={() => void reveal(taskId, open.path)}
              >
                <FolderOpen size={14} aria-hidden />
              </Button>
            )}
          </div>
          <pre className="task-file-text">{open.text}</pre>
        </div>
      )}
      {place?.local && !open && (
        <>
          {folder && (
            <button type="button" className="task-file-up" onClick={up}>
              <ArrowLeft size={12} aria-hidden /> {folder}
            </button>
          )}
          {entries?.length === 0 && <p className="activity-status">This folder is empty.</p>}
          <ul className="task-file-list" aria-label="Task files">
            {entries?.map((entry) => {
              const Icon =
                entry.kind === "directory"
                  ? Folder
                  : entry.kind === "link"
                    ? Link2
                    : entry.text
                      ? FileText
                      : File;
              const opens = entry.kind === "directory" || entry.text;
              const note =
                entry.kind === "link"
                  ? "link"
                  : entry.kind === "file" && !entry.text
                    ? `binary · ${sizeWords(entry.size)}`
                    : entry.kind === "file"
                      ? sizeWords(entry.size)
                      : "";
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="task-file"
                    disabled={!opens}
                    title={opens ? entry.path : "Binary files and links are listed only"}
                    onClick={() => void view(entry)}
                  >
                    <Icon size={13} aria-hidden />
                    <span className="task-file-name">{entry.name}</span>
                    {note && <small>{note}</small>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Where a finished Task's work is: its Session's branch, in the repository of the Workspace the
 * Tag works in, with commands to copy. A Task that made no commit leaves no branch.
 */
function BranchHint({ branch }: { branch: string }) {
  const commands = [`git diff main...${branch}`, `git checkout ${branch}`];
  return (
    <div className="branch-hint">
      <p className="activity-status">
        In the Workspace's repository, see what it committed, or check it out:
      </p>
      {commands.map((command) => (
        <div className="branch-command" key={command}>
          <code title={command}>{command}</code>
          <CopyText text={command} label="Copy command" />
        </div>
      ))}
    </div>
  );
}
