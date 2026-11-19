/**
 * The palette (Ctrl-K, or `/` on an empty message): "Search Tags, conversations, settings…".
 * Tags first, with their Alt-N keys, then commands; typing narrows both by name, letters in
 * order. ↑ ↓ move, Enter runs, Esc closes.
 */
import { useState } from "react";
import { clip } from "./text";
import { color, type KeyEvent, useKeyboard } from "./ui";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  section: "Tags" | "Commands";
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

export function Palette({
  items,
  width,
  onClose,
}: {
  items: readonly PaletteItem[];
  width: number;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const shown = items.filter((item) => matches(item.label, query));
  const selected = Math.min(index, Math.max(0, shown.length - 1));
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape") onClose();
    else if (key.name === "down" || (key.ctrl && key.name === "n"))
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
            item.run();
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
