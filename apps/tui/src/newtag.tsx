/**
 * New Tag (Ctrl-N): a name, from which its permanent ID is derived as `supertag init` names
 * Tags; a harness and a Workspace from what the connected Worker Hosts offer (every harness when
 * none is connected); how many Work Sessions it may have open; and Web access, on unless its
 * hosts have no network. On Local, "Choose a folder…" adds a folder of this machine as a
 * Workspace with `supertag workspace add`. The rest matches the lead Tag `supertag init` creates,
 * with the desktop app's rules from `@supertag/client`. Only an operator may create Tags.
 */
import {
  type AddedWorkspace,
  describe,
  harnessLabel,
  newTagNotes,
  newTagRules,
  offeredHarnesses,
  type Tag,
  type TagOptions,
  tagAdminRefusal,
  tagIdFor,
  WEB_ACCESS_HINT,
} from "@supertag/client/model";
import { useEffect, useRef, useState } from "react";
import type { TuiGateway } from "./connection";
import { clip, safe } from "./text";
import { color, type KeyEvent, pasteOnOneLine, useKeyboard } from "./ui";

const FIELDS = ["Name", "Harness", "Workspace", "Sessions", "Web access"] as const;
/** The Workspace choice that adds a folder; no Workspace ID has a space. */
const CHOOSE_FOLDER = " choose-folder";

export function NewTagForm({
  gateway,
  principal,
  width,
  onCreated,
  onClose,
}: {
  gateway: TuiGateway;
  principal: string | undefined;
  width: number;
  onCreated(tag: Tag): void;
  onClose(): void;
}) {
  const refusal = tagAdminRefusal(principal);
  const [options, setOptions] = useState<TagOptions>();
  // The field in front, also as a ref: keys can land before the next render.
  const [field, showField] = useState(0);
  const at = useRef(0);
  const setField = (next: number) => {
    at.current = Math.max(0, Math.min(FIELDS.length - 1, next));
    showField(at.current);
  };
  // The typed fields, also as refs: Ctrl-S can land with the last keys typed, before a render.
  const [name, showName] = useState("");
  const typed = useRef({ name: "", sessions: "8" });
  const setName = (value: string) => {
    typed.current = { ...typed.current, name: value };
    showName(value);
  };
  const [harness, setHarness] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [added, setAdded] = useState<Record<string, AddedWorkspace>>({});
  const [folder, setFolder] = useState<string | undefined>();
  const [sessions, showSessions] = useState("8");
  const setSessions = (value: string) => {
    typed.current = { ...typed.current, sessions: value };
    showSessions(value);
  };
  const [webChoice, setWebChoice] = useState<boolean>();
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (refusal) return;
    let live = true;
    gateway.tagOptions().then(
      (offered) => {
        if (!live) return;
        setOptions(offered);
        setHarness(offeredHarnesses(offered)[0] ?? "codex");
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
  }, [gateway, refusal]);

  const tagId = tagIdFor(name);
  const harnesses = offeredHarnesses(options);
  const workspaces = options
    ? [...new Set([...options.workspaces, ...Object.keys(added)])].sort()
    : [];
  const choices = ["", ...workspaces, ...(gateway.local ? [CHOOSE_FOLDER] : [])];
  const rules = newTagRules(options, harness, webChoice);
  const notes = newTagNotes(options, harness, rules);

  async function addFolder(path: string) {
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    setBusy("Adding the folder and restarting SuperTag…");
    setProblem("");
    try {
      const made = await gateway.addFolder(trimmed);
      setAdded((prior) => ({ ...prior, [made.workspace]: made }));
      setWorkspace(made.workspace);
      setFolder(undefined);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function create() {
    if (busy || !options) return;
    const { name, sessions } = typed.current;
    const tagId = tagIdFor(name);
    if (!tagId) {
      setProblem("Use letters or digits in the name.");
      setField(0);
      return;
    }
    const max = Number(sessions);
    if (!Number.isInteger(max) || max < 1 || max > 64) {
      setProblem("A Tag may have 1 to 64 Work Sessions open at once.");
      setField(3);
      return;
    }
    setBusy("Creating…");
    setProblem("");
    try {
      const start = workspace ? added[workspace] : undefined;
      const created = await gateway.createTag({
        tagId,
        name: name.trim(),
        harness,
        ...(workspace ? { workspaceId: workspace } : {}),
        ...(start?.workspaceRef ? { workspaceRef: start.workspaceRef } : {}),
        ...(start?.workspaceCommit ? { workspaceCommit: start.workspaceCommit } : {}),
        maxWorkSessions: max,
        webAccess: rules.webAccess,
      });
      onCreated(created);
    } catch (error) {
      setProblem(describe(error));
      setBusy(undefined);
    }
  }

  const cycle = <T,>(list: readonly T[], current: T, by: number): T => {
    if (list.length === 0) return current;
    const at = list.indexOf(current);
    return list[(at + by + list.length) % list.length] as T;
  };
  useKeyboard((key: KeyEvent) => {
    if (busy) return;
    if (key.name === "escape") {
      if (folder !== undefined) setFolder(undefined);
      else onClose();
      return;
    }
    if (refusal || folder !== undefined) return;
    if (key.ctrl && key.name === "s") void create();
    else if (key.name === "up") setField(at.current - 1);
    else if (key.name === "down" || key.name === "tab") setField(at.current + 1);
    else if (key.name === "left" || key.name === "right" || key.name === "space") {
      const by = key.name === "left" ? -1 : 1;
      if (at.current === 1) setHarness((prior) => cycle(harnesses, prior, by));
      else if (at.current === 2) setWorkspace((prior) => cycle(choices, prior, by));
      else if (at.current === 4 && !rules.webless) setWebChoice(!rules.webAccess);
    } else if (key.name === "return" || key.name === "enter") {
      if (at.current === 2 && workspace === CHOOSE_FOLDER) setFolder("");
      else if (at.current === 4) void create();
      else setField(at.current + 1);
    }
  });

  const shownWorkspace =
    workspace === CHOOSE_FOLDER ? "Choose a folder… (Enter)" : workspace || "None";
  const inner = Math.max(10, width - 16);
  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title="New Tag"
    >
      {refusal ? (
        <>
          <text fg={color.warning}>{safe(refusal)}</text>
          <text fg={color.faint}>Esc close</text>
        </>
      ) : (
        <>
          <text fg={color.muted}>
            A Tag can edit files, run commands, and read web pages, like the lead Tag supertag init
            creates.
          </text>
          {FIELDS.map((label, position) => {
            const at = position === field && folder === undefined;
            return (
              <box key={label} flexDirection="row" height={1}>
                <text fg={at ? color.strong : color.muted} width={12}>
                  {label}
                </text>
                <box width={inner} height={1}>
                  {position === 0 ? (
                    <input
                      onPaste={pasteOnOneLine}
                      focused={at}
                      placeholder="Reviewer"
                      value={name}
                      onInput={setName}
                    />
                  ) : position === 1 ? (
                    <text fg={color.text}>
                      ‹ {safe(harnessLabel(harness) ?? (harness || "…"))} ›
                    </text>
                  ) : position === 2 ? (
                    <text fg={color.text}>‹ {clip(shownWorkspace, inner - 4)} ›</text>
                  ) : position === 3 ? (
                    <input
                      onPaste={pasteOnOneLine}
                      focused={at}
                      placeholder="8"
                      value={sessions}
                      onInput={setSessions}
                    />
                  ) : (
                    <text fg={rules.webless ? color.faint : color.text}>
                      {rules.webAccess ? "[x] on" : "[ ] off"}
                    </text>
                  )}
                </box>
              </box>
            );
          })}
          <text fg={color.faint}>
            {tagId ? `ID: ${tagId}. It cannot change later.` : "Use letters or digits."}
          </text>
          {field === 3 ? (
            <text fg={color.faint}>
              Longer work the Tag may have open across all its conversations.
            </text>
          ) : null}
          {field === 4 ? <text fg={color.faint}>{WEB_ACCESS_HINT}</text> : null}
          {notes.map((note) => (
            <text key={note} fg={color.muted}>
              {safe(note)}
            </text>
          ))}
          {folder !== undefined ? (
            <box border borderColor={color.focus} height={3} title="Folder of this machine">
              <input
                onPaste={pasteOnOneLine}
                focused
                placeholder="/path/to/a/git/checkout"
                value={folder}
                onInput={setFolder}
                onSubmit={(value: string) => void addFolder(String(value))}
              />
            </box>
          ) : null}
          {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
          <text fg={color.faint}>
            {busy ??
              (folder !== undefined
                ? "Enter adds it with supertag workspace add · Esc back"
                : options
                  ? "↑ ↓ fields · ← → choose · Space toggles · Enter on Web access or Ctrl-S creates · Esc close"
                  : "Asking the Worker Hosts what they offer…")}
          </text>
        </>
      )}
    </box>
  );
}
