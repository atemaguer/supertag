import type { Tag, TagSummary } from "@supertag/client/model";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { onMac, tagShortcut } from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** What the search field says before anything is typed. */
export const PALETTE_PLACEHOLDER = "Search Tags, conversations, settings…";

/** One row of the palette's Actions section. */
export interface PaletteAction {
  id: string;
  label: string;
  /** A short line under the label. */
  caption?: string;
  icon?: ReactNode;
  /** The key that does the same outside the palette, such as ⌘N. */
  shortcut?: string;
  /** More words the action is found by. */
  keywords?: string;
  disabled?: boolean;
  run(): void;
}

/** One row of the palette's Tags section. */
export interface PaletteTag {
  tag: Tag;
  /** The latest message, or the cached message the search matched. */
  caption?: string;
  /** Where ⌘1…⌘9 put it, counting from zero, when it has a shortcut. */
  index: number;
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, terms: readonly string[]) => {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
};

/** A line of a message around where it first matches, short enough for one row. */
export function snippet(text: string, term: string, width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = Math.max(flat.toLowerCase().indexOf(term), 0);
  const start = Math.max(at - Math.floor(width / 3), 0);
  const end = Math.min(start + width, flat.length);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * What the palette lists for a query: each Tag whose name, ID, or latest message matches, then
 * each whose cached messages match, captioned with the matching message; and each action whose
 * label, caption, or keywords match. Every word of the query must match.
 */
export function searchPalette(
  query: string,
  tags: readonly Tag[],
  summaries: Record<string, TagSummary>,
  actions: readonly PaletteAction[],
  messageTexts?: (tagId: string) => readonly string[],
): { tags: PaletteTag[]; actions: PaletteAction[] } {
  const terms = words(query);
  const shown: PaletteTag[] = [];
  for (const [index, tag] of tags.entries()) {
    const preview = summaries[tag.tagId]?.preview;
    if (matches(`${tag.name ?? ""} ${tag.tagId} ${preview ?? ""}`, terms)) {
      shown.push({ tag, caption: preview, index });
      continue;
    }
    const message = messageTexts?.(tag.tagId).find((text) => matches(text, terms));
    if (message && terms[0]) shown.push({ tag, caption: snippet(message, terms[0]), index });
  }
  return {
    tags: shown,
    actions: actions.filter((action) =>
      matches(`${action.label} ${action.caption ?? ""} ${action.keywords ?? ""}`, terms),
    ),
  };
}

/** How a key with the platform's command key reads: ⌘K on macOS, Ctrl+K elsewhere. */
export const commandKeyLabel = (key: string, mac = onMac()) => (mac ? `⌘${key}` : `Ctrl+${key}`);

/**
 * The command palette: a field that searches the Tags, their conversations, and what the app can
 * do, in a dialog over the window. Enter opens the selected row, the arrow keys move the
 * selection, ⌘1…⌘9 open a Tag, and Esc closes it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  tags,
  summaries,
  actions,
  messageTexts,
  onSelectTag,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The Tags in sidebar order: the lead first, then by latest activity. */
  tags: readonly Tag[];
  summaries: Record<string, TagSummary>;
  actions: readonly PaletteAction[];
  /** The text of each cached message of the Tag's conversation, newest first. */
  messageTexts?(tagId: string): readonly string[];
  onSelectTag?(tagId: string): void;
}) {
  const [query, setQuery] = useState("");
  const mac = onMac();
  const found = useMemo(
    () => (open ? searchPalette(query, tags, summaries, actions, messageTexts) : undefined),
    [open, query, tags, summaries, actions, messageTexts],
  );
  const close = () => {
    onOpenChange(false);
    setQuery("");
  };
  const openTag = (tagId: string) => {
    close();
    onSelectTag?.(tagId);
  };
  const runAction = (action: PaletteAction) => {
    if (action.disabled) return;
    close();
    action.run();
  };
  function onKeyDown(event: ReactKeyboardEvent) {
    const shortcut = tagShortcut(event.nativeEvent, mac);
    if (!shortcut) return;
    if (shortcut.kind === "nth") {
      const target = tags[shortcut.index];
      if (target) openTag(target.tagId);
    } else if (shortcut.kind === "new") {
      const create = actions.find((action) => action.id === "new-tag");
      if (create) runAction(create);
    } else if (shortcut.kind === "palette") close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Search"
      description="Search Tags, conversations, and settings, and open one."
      className="command-palette"
      commandProps={{ shouldFilter: false, loop: true, onKeyDown, label: "Search" }}
    >
      <CommandInput placeholder={PALETTE_PLACEHOLDER} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>
        {found && found.tags.length > 0 && (
          <CommandGroup heading="Tags">
            {found.tags.map(({ tag, caption, index }) => {
              const name = tag.name ?? tag.tagId;
              return (
                <CommandItem
                  key={tag.tagId}
                  value={`tag:${tag.tagId}`}
                  className="palette-row"
                  onSelect={() => openTag(tag.tagId)}
                >
                  <TagAvatar tag={tag} />
                  <span className="palette-text">
                    <span className="palette-label">{name}</span>
                    {caption && <span className="palette-caption">{caption}</span>}
                  </span>
                  {index < 9 && (
                    <CommandShortcut>{commandKeyLabel(String(index + 1), mac)}</CommandShortcut>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {found && found.actions.length > 0 && (
          <CommandGroup heading="Actions">
            {found.actions.map((action) => (
              <CommandItem
                key={action.id}
                value={`action:${action.id}`}
                className="palette-row"
                disabled={action.disabled}
                onSelect={() => runAction(action)}
              >
                <span className="palette-icon">{action.icon}</span>
                <span className="palette-text">
                  <span className="palette-label">{action.label}</span>
                  {action.caption && <span className="palette-caption">{action.caption}</span>}
                </span>
                {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/** Every key the desktop app answers to, as the Keyboard shortcuts dialog lists them. */
export function keyboardShortcuts(mac = onMac()): [string, string][] {
  const key = (letter: string) => commandKeyLabel(letter, mac);
  return [
    [key("K"), "Search Tags, conversations, settings"],
    [`${key("1")}…${key("9")}`, "Open the nth Tag; the lead Tag is first"],
    [`${key("↑")} ${key("↓")}`, "Open the previous or next Tag"],
    [key("N"), "New Tag"],
    [key("B"), "Fold the sidebar into a rail, or expand it"],
    [key(","), "Open Settings"],
    ["Enter", "Send the message"],
    ["Shift+Enter", "Start a new line"],
    ["Esc", "Close a dialog or the search"],
  ];
}

/** Lists the app's keyboard shortcuts. */
export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace-dialog shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>What each key does in the app.</DialogDescription>
        </DialogHeader>
        <dl className="shortcut-list">
          {keyboardShortcuts().map(([keys, does]) => (
            <div key={does} className="shortcut-row">
              <dt>{does}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
