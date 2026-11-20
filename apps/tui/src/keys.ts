/**
 * The keys the terminal UI answers in one place, which no command runs: the composer's, the
 * list's, a panel's. The Keyboard shortcuts screen lists them after the commands, whose keys
 * come from `src/commands.ts` with the commands themselves.
 */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "Enter", does: "Send the message" },
  { keys: "/ at the start of a message", does: "Commands: ↑ ↓ choose, Tab completes, Enter runs" },
  {
    keys: "Esc, Ctrl-C over the commands",
    does: "Close them; Esc keeps the text, Ctrl-C drops it",
  },
  { keys: "Alt-1…9 (Ctrl-1…9)", does: "Open the nth Tag (the lead is first), also in the palette" },
  { keys: "Alt-↑ Alt-↓, Alt-k Alt-j", does: "Open the previous or next Tag" },
  { keys: "→ in the list", does: "Move to the conversation's composer or the pane" },
  { keys: "← at the start of a message", does: "Move to the list; elsewhere ← moves the cursor" },
  { keys: "Tab", does: "Move between the list and the pane" },
  { keys: "↑ ↓, k j", does: "Move in the list: Tags, Objectives, the inbox, Teams" },
  { keys: "↑ on an empty message", does: "Work Sessions: Enter expands, d diff, o pull request" },
  { keys: "m", does: "Message an Objective's owner (a approve, c request changes)" },
  { keys: "a, d", does: "Approve once or deny an approval request" },
  { keys: "[ ]", does: "Narrow or widen the Tag list (from the list)" },
  { keys: "PgUp PgDn", does: "Scroll the conversation; earlier messages load at the top" },
  { keys: "End, Ctrl-End", does: "Jump to the latest message" },
  { keys: "Ctrl-R", does: "Retry a message that was not delivered" },
  { keys: "Ctrl-X", does: "Edit a message that was not delivered" },
  { keys: "Esc, Ctrl-K", does: "Close a panel; Ctrl-K also closes the palette" },
];

/** Whether a key event is Alt (or Option, or Meta) with nothing but Shift. */
export function alt(key: { meta: boolean; option: boolean; ctrl: boolean }): boolean {
  return (key.meta || key.option) && !key.ctrl;
}
