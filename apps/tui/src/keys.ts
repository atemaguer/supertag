/**
 * Every key the terminal UI answers, in one table: the Keyboard shortcuts screen lists it, and
 * the palette's hints come from it.
 */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "Enter", does: "Send the message" },
  { keys: "/goal OUTCOME", does: "Create an Objective the Tag owns; /goal alone opens the form" },
  { keys: "Ctrl-K, / on an empty message", does: "Search Tags and commands" },
  { keys: "Ctrl-N", does: "Create a Tag" },
  { keys: "Ctrl-P", does: "Choose a Gateway (d forgets a saved one)" },
  { keys: "Alt-1…9 (Ctrl-1…9)", does: "Open the nth Tag (the lead is first), also in the palette" },
  { keys: "Alt-↑ Alt-↓, Alt-k Alt-j", does: "Open the previous or next Tag" },
  { keys: "Tab", does: "Move between the list and the pane" },
  { keys: "↑ ↓, k j", does: "Move in the list: Tags, Objectives, the inbox, Teams" },
  { keys: "↑ on an empty message", does: "Work Sessions: Enter expands, d diff, o pull request" },
  { keys: "m", does: "Message an Objective's owner (a approve, c request changes)" },
  { keys: "a, d", does: "Approve once or deny an approval request" },
  { keys: "Ctrl-B", does: "Fold the Tag list to initials" },
  { keys: "[ ]", does: "Narrow or widen the Tag list (from the list)" },
  { keys: "PgUp PgDn", does: "Scroll the conversation; earlier messages load at the top" },
  { keys: "End, Ctrl-End", does: "Jump to the latest message" },
  { keys: "Ctrl-R", does: "Retry a message that was not delivered" },
  { keys: "Ctrl-X", does: "Edit a message that was not delivered" },
  { keys: "Esc, Ctrl-K", does: "Close a panel; Ctrl-K also closes the palette" },
  { keys: "Ctrl-C", does: "Quit" },
];

/** Whether a key event is Alt (or Option, or Meta) with nothing but Shift. */
export function alt(key: { meta: boolean; option: boolean; ctrl: boolean }): boolean {
  return (key.meta || key.option) && !key.ctrl;
}
