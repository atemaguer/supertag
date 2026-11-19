import { useEffect, useState } from "react";
import type { Tag } from "../gateway";
import { describe } from "../lib/polling";
import {
  type AddedWorkspace,
  HARNESSES,
  harnessLabel,
  type TagAdmin,
  type TagOptions,
  tagIdFor,
} from "../tag-admin";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/** The Workspace picker's entry that adds a folder of this machine; no Workspace ID has a space. */
const CHOOSE_FOLDER = " choose-folder";

/**
 * Creates a Tag from a name and a harness, and optionally a Workspace. The rest matches the lead
 * Tag `supertag init` creates: it may edit files and, where its host can, run commands. On the
 * local Gateway, a folder of this machine can be added as a new Workspace.
 */
export function NewTagDialog({
  admin,
  open,
  onOpenChange,
  onCreated,
}: {
  admin: TagAdmin;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(tag: Tag): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace-dialog">
        <DialogHeader>
          <DialogTitle>New Tag</DialogTitle>
          <DialogDescription>
            A Tag can edit files and run commands, like the lead Tag supertag init creates.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <NewTagForm
            admin={admin}
            onCreated={(tag) => {
              onCreated(tag);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewTagForm({ admin, onCreated }: { admin: TagAdmin; onCreated(tag: Tag): void }) {
  const [options, setOptions] = useState<TagOptions>();
  const [name, setName] = useState("");
  const [harness, setHarness] = useState("");
  const [workspace, setWorkspace] = useState("");
  /** Folders added while the form is open, by Workspace, with where their Sessions start. */
  const [added, setAdded] = useState<Record<string, AddedWorkspace>>({});
  const [adding, setAdding] = useState(false);
  const [maxWorkSessions, setMaxWorkSessions] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    admin.options().then(
      (offered) => {
        if (!live) return;
        setOptions(offered);
        setHarness(
          Object.keys(HARNESSES).find((kind) => offered.harnesses.includes(kind)) ??
            offered.harnesses[0] ??
            "codex",
        );
        if (offered.workspaces.length === 1) setWorkspace(offered.workspaces[0] ?? "");
      },
      () => {
        // Without the hosts' offer, every harness and no Workspace can still be chosen.
        if (!live) return;
        setOptions({ harnesses: [], workspaces: [] });
        setHarness("codex");
      },
    );
    return () => {
      live = false;
    };
  }, [admin]);

  const tagId = tagIdFor(name);
  const known = Object.keys(HARNESSES);
  const rank = (kind: string) => (known.includes(kind) ? known.indexOf(kind) : known.length);
  const harnesses = options?.harnesses.length
    ? [...options.harnesses].sort((a, b) => rank(a) - rank(b))
    : known;
  const workspaces = options
    ? [...new Set([...options.workspaces, ...Object.keys(added)])].sort()
    : [];
  const noCommands = options?.noCommands?.includes(harness) ?? false;

  /** Asks for a folder, adds it as a Workspace of this machine, and selects it. */
  async function addFolder() {
    if (!admin.addFolder || adding) return;
    setAdding(true);
    setError("");
    try {
      const folder = await admin.addFolder();
      if (folder) {
        setAdded((prior) => ({ ...prior, [folder.workspace]: folder }));
        setWorkspace(folder.workspace);
      }
    } catch (error) {
      setError(describe(error));
    } finally {
      setAdding(false);
    }
  }

  async function create() {
    if (!tagId || !harness || busy || adding) return;
    setBusy(true);
    setError("");
    try {
      const start = workspace ? added[workspace] : undefined;
      onCreated(
        await admin.create({
          tagId,
          name: name.trim(),
          harness,
          workspaceId: workspace || undefined,
          workspaceRef: start?.workspaceRef,
          workspaceCommit: start?.workspaceCommit,
          maxWorkSessions,
        }),
      );
    } catch (error) {
      setError(describe(error));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <label htmlFor="tag-name">Name</label>
      <Input
        id="tag-name"
        name="name"
        maxLength={63}
        placeholder="Reviewer"
        autoComplete="off"
        required
        value={name}
        aria-describedby="tag-id"
        onChange={(event) => setName(event.target.value)}
      />
      <small id="tag-id" className="field-hint">
        {tagId ? `ID: ${tagId}. It cannot change later.` : "Use letters or digits."}
      </small>
      <label htmlFor="tag-harness">Harness</label>
      <select
        id="tag-harness"
        className="field-select"
        value={harness}
        disabled={!options}
        onChange={(event) => setHarness(event.target.value)}
      >
        {harnesses.map((kind) => (
          <option key={kind} value={kind}>
            {harnessLabel(kind) ?? kind}
          </option>
        ))}
      </select>
      {options && options.harnesses.length === 0 && (
        <small className="field-hint">
          No Worker Host is connected. Choose the harness its host will run.
        </small>
      )}
      {noCommands && (
        <small className="field-hint">
          {harnessLabel(harness) ?? harness} has no sandbox of its own, and no host here lets it run
          commands, so this Tag reads and edits files only.
        </small>
      )}
      {options && (workspaces.length > 0 || admin.addFolder) && (
        <>
          <label htmlFor="tag-workspace">Workspace</label>
          <select
            id="tag-workspace"
            className="field-select"
            value={workspace}
            disabled={adding}
            aria-describedby={adding ? "tag-workspace-adding" : undefined}
            onChange={(event) => {
              if (event.target.value === CHOOSE_FOLDER) void addFolder();
              else setWorkspace(event.target.value);
            }}
          >
            <option value="">None</option>
            {workspaces.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            {admin.addFolder && <option value={CHOOSE_FOLDER}>Choose a folder…</option>}
          </select>
          {adding && (
            <small id="tag-workspace-adding" className="field-hint">
              Adding the folder and restarting SuperTag…
            </small>
          )}
        </>
      )}
      <label htmlFor="tag-work-sessions">Work Sessions open at once</label>
      <Input
        id="tag-work-sessions"
        name="maxWorkSessions"
        type="number"
        min={1}
        max={64}
        required
        value={maxWorkSessions}
        aria-describedby="tag-work-sessions-hint"
        onChange={(event) => setMaxWorkSessions(Number(event.target.value))}
      />
      <small id="tag-work-sessions-hint" className="field-hint">
        Longer work the Tag may have open across all its conversations.
      </small>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <DialogFooter className="dialog-actions">
        <Button className="primary" type="submit" disabled={!tagId || !options || busy || adding}>
          {busy ? "Creating…" : "Create Tag"}
        </Button>
      </DialogFooter>
    </form>
  );
}
