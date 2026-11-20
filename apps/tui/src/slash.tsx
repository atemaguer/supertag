/**
 * The slash popup: `/` as a message's first character lists the commands above the composer,
 * narrowed as the name is typed. The text stays in the composer the whole time. ↑ ↓ (Ctrl-P
 * Ctrl-N) choose, Tab completes the name, Enter runs it (one that takes an argument is written
 * out as `/name ` to type it after), Esc closes it and keeps the text, Ctrl-C drops the text.
 * A space after the name closes it: what follows is the argument. `/usr/bin` and a `/` later
 * in a message never open it. OpenCode's prompt autocomplete works this way; the code is ours.
 */
import { useMemo, useRef, useState } from "react";
import {
  type Command,
  namedCommand,
  type SlashMatch,
  slashLabel,
  slashMatches,
  slashQuery,
} from "./commands";
import { color, type KeyEvent, useKeyLayer } from "./ui";

export interface SlashOptions {
  /** The composer's text, as rendered. */
  text: string;
  /** The composer has the keyboard. */
  focused: boolean;
  commands: readonly Command[];
  /** Replaces the composer's text. */
  setText(text: string): void;
  run(command: Command, argument?: string): void;
}

export interface Slash {
  open: boolean;
  matches: SlashMatch[];
  selected: number;
  /** The command being given its argument (`/goal `), whose hint shows over the composer. */
  awaiting: Command | undefined;
  /** The composer's text changed (before the next render). */
  input(text: string): void;
  /** Enter reached the composer: whether the popup took it, as keys landing together can. */
  submit(text: string): boolean;
}

export function useSlash({ text, focused, commands, setText, run }: SlashOptions): Slash {
  const [dismissed, setDismissed] = useState<string | undefined>();
  const [selected, setSelected] = useState(0);
  // What is typed and chosen now: keys that land together arrive before the next render.
  const latest = useRef({ text, selected });
  latest.current.text = text;
  const query = slashQuery(text);
  const open = focused && query !== undefined && dismissed !== text;
  const matches = useMemo(
    () => (query === undefined ? [] : slashMatches(query, commands)),
    [query, commands],
  );

  const now = () => {
    const typed = latest.current.text;
    const typedQuery = slashQuery(typed);
    if (!focused || typedQuery === undefined || dismissed === typed) return undefined;
    const shown = slashMatches(typedQuery, commands);
    return { typed, shown, at: Math.min(latest.current.selected, Math.max(0, shown.length - 1)) };
  };
  const select = (at: number) => {
    latest.current.selected = at;
    setSelected(at);
  };
  const replace = (next: string) => {
    latest.current = { text: next, selected: 0 };
    setSelected(0);
    setText(next);
  };
  const choose = (match: SlashMatch | undefined) => {
    if (!match) return;
    if (match.command.slash?.argument) replace(`/${match.name} `);
    else {
      replace("");
      run(match.command);
    }
  };

  useKeyLayer(open, (key: KeyEvent) => {
    const state = now();
    if (!state) return;
    const { typed, shown, at } = state;
    const count = shown.length;
    let taken = true;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      if (count) select((at - 1 + count) % count);
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      if (count) select((at + 1) % count);
    } else if (key.name === "tab" && !key.ctrl) {
      const match = shown[at];
      if (match) replace(`/${match.name}${match.command.slash?.argument ? " " : ""}`);
    } else if (key.name === "return" || key.name === "enter") {
      choose(shown[at]);
    } else if (key.name === "escape") {
      setDismissed(typed);
    } else if (key.ctrl && key.name === "c") {
      replace("");
    } else taken = false;
    if (taken) key.stopPropagation();
  });

  const head = namedCommand(text, commands);
  const awaiting =
    !open && head?.command.slash?.argument && head.argument === "" ? head.command : undefined;
  return {
    open,
    matches,
    selected: Math.min(selected, Math.max(0, matches.length - 1)),
    awaiting,
    input(next: string) {
      if (next !== latest.current.text) latest.current = { text: next, selected: 0 };
      setSelected(latest.current.selected);
    },
    submit(typed: string) {
      latest.current.text = typed;
      const state = now();
      if (!state) return false;
      choose(state.shown[state.at]);
      return true;
    },
  };
}

/** The popup's rows, just above the composer. */
export function SlashPopup({ slash }: { slash: Slash }) {
  const { matches, selected } = slash;
  const column = Math.max(
    0,
    ...matches.map((match) => slashLabel(match.command, match.name).length),
  );
  return (
    <box
      position="absolute"
      bottom={3}
      left={0}
      right={0}
      zIndex={20}
      flexDirection="column"
      border
      borderColor={color.border}
      backgroundColor="#151515"
      height={Math.max(1, matches.length) + 2}
    >
      {matches.length === 0 ? <text fg={color.muted}>No matching commands</text> : null}
      {matches.map((match, position) => {
        const chosen = position === selected;
        return (
          <text
            key={`${match.command.id}:${match.name}`}
            wrapMode="none"
            fg={chosen ? color.strong : color.text}
            bg={chosen ? color.selected : undefined}
          >
            {" "}
            {slashLabel(match.command, match.name).padEnd(column + 2)}
            <span fg={chosen ? color.text : color.muted}>{match.command.description}</span>
          </text>
        );
      })}
    </box>
  );
}

/** Over the composer while a command waits for its argument: `/goal <outcome> · …`. */
export function ArgumentHint({ command }: { command: Command }) {
  return (
    <text fg={color.faint} flexShrink={0} wrapMode="none">
      {" "}
      {slashLabel(command)} · {command.description}
    </text>
  );
}
