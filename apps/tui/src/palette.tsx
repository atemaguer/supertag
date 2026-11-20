/**
 * The palette (Ctrl-K, or `/` on an empty message): "Search Tags, conversations, settings…".
 * Tags first, with their Alt-N keys, then commands; typing narrows both by name, letters in
 * order. ↑ ↓ move, Enter runs, Esc closes. `/goal OUTCOME` typed here (the `/` that opened it
 * counts) leaves only Create Objective, and Enter sends it to the conversation on screen.
 */
import { goalOutcome } from "@supertag/client/model";
import { useState } from "react";
import { alt } from "./keys";
import { clip } from "./text";
import { color, type KeyEvent, pasteOnOneLine, useKeyboard } from "./ui";

export interface PaletteItem {
  id: string;
  label: string;
  /** More it matches by, such as a Tag's ID and latest message. */
  keywords?: string;
  hint?: string;
  /** The last only lists Tags found by their ID or latest message, after every name match. */
  section: "Tags" | "Commands" | "Tags by ID or message";
  run(): void;
}

/** Whether every character of `query` appears in `text`, in order, ignoring case. */
export function matches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  let at = 0;
  for (const character of query.toLowerCase().replace(/\s+/gu, "")) {
    at = haystack.indexOf(character, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** Whether `query`, as typed, appears in `text`, ignoring case: for an ID or a message. */
function matchesWords(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * The items `query` matches: those whose name matches, in their sections, then the Tags only an
 * ID or latest message matches, so a command typed by name is never behind a Tag's message.
 */
function narrowed(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const byName = items.filter((item) => matches(item.label, query));
  if (query.trim() === "") return byName;
  const byWords = items
    .filter(
      (item) =>
        !byName.includes(item) && item.keywords !== undefined && matchesWords(item.keywords, query),
    )
    .map((item) => ({ ...item, section: "Tags by ID or message" as const }));
  return [...byName, ...byWords];
}

/** The palette item that creates an Objective, which inline `/goal` text selects. */
export const GOAL_ITEM = "goal";

export function Palette({
  items,
  width,
  slash = false,
  onGoal,
  onClose,
}: {
  items: readonly PaletteItem[];
  width: number;
  /** `/` on an empty message opened it, so what is typed follows that `/`. */
  slash?: boolean;
  /** `/goal OUTCOME` was chosen: send it to the conversation on screen. */
  onGoal?(outcome: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const goal = goalOutcome(slash && !query.startsWith("/") ? `/${query}` : query);
  const shown =
    goal !== undefined ? items.filter((item) => item.id === GOAL_ITEM) : narrowed(items, query);
  const selected = Math.min(index, Math.max(0, shown.length - 1));
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape" || (key.ctrl && key.name === "k")) onClose();
    else if ((alt(key) || key.ctrl) && /^[1-9]$/u.test(key.name)) {
      // Alt-N opens the nth Tag at once, as outside the palette.
      const tag = items.filter((item) => item.section === "Tags")[Number(key.name) - 1];
      if (tag) {
        onClose();
        tag.run();
      }
    } else if (key.name === "down" || (key.ctrl && key.name === "n"))
      setIndex(Math.min(selected + 1, shown.length - 1));
    else if (key.name === "up" || (key.ctrl && key.name === "p"))
      setIndex(Math.max(selected - 1, 0));
  });
  const inner = Math.max(10, width - 4);
  let section: string | undefined;
  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title="Commands"
    >
      <input
        onPaste={pasteOnOneLine}
        focused
        placeholder="Search Tags, conversations, settings…"
        value={query}
        onInput={(value: string) => {
          setQuery(value);
          setIndex(0);
        }}
        onSubmit={() => {
          const item = shown[selected];
          if (item) {
            onClose();
            if (item.id === GOAL_ITEM && goal && onGoal) onGoal(goal);
            else item.run();
          }
        }}
      />
      {shown.length === 0 ? <text fg={color.muted}>Nothing matches.</text> : null}
      {shown.slice(0, 20).map((item, position) => {
        const header = item.section !== section ? item.section : undefined;
        section = item.section;
        const hint = item.hint ?? "";
        return (
          <box key={item.id} flexDirection="column">
            {header ? <text fg={color.faint}>{header}</text> : null}
            <text
              fg={position === selected ? color.strong : color.text}
              bg={position === selected ? color.selected : undefined}
            >
              {" "}
              {clip(item.label, inner - hint.length - 2).padEnd(inner - hint.length - 1)}
              <span fg={color.muted}>{hint}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}
