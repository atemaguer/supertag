/**
 * The OpenTUI layer: the hooks, Markdown, scroll view and fields the screens use. Screens import
 * OpenTUI only through here (JSX elements aside), so a breaking OpenTUI minor touches one place.
 */
import type {
  CliRenderer,
  EditBufferRenderable,
  InputRenderable,
  KeyEvent,
  Renderable,
  ScrollBoxRenderable,
  SyntaxStyle,
} from "@opentui/core";
import { decodePasteBytes, PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { createContext, memo, useContext, useEffect, useMemo, useRef } from "react";
import { safe } from "../text";
import { color, syntaxStyle } from "./theme";

export {
  useBlur,
  useFocus,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
export type { InputRenderable, KeyEvent, Renderable, ScrollBoxRenderable };
export { color };

const StyleContext = createContext<SyntaxStyle | undefined>(undefined);

/** Gives Markdown beneath it the renderer's syntax style. */
export function StyleProvider({ children }: { children: React.ReactNode }) {
  const renderer = useRenderer();
  const style = useMemo(() => syntaxStyle(renderer), [renderer]);
  return <StyleContext.Provider value={style}>{children}</StyleContext.Provider>;
}

/** Markdown a Tag wrote, escape sequences shown as text; `streaming` while it is being written. */
export const Markdown = memo(function Markdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const style = useContext(StyleContext);
  if (!style) return <text fg={color.text}>{safe(text)}</text>;
  return <markdown content={safe(text)} syntaxStyle={style} streaming={streaming ?? false} />;
});

/**
 * An `<input>`'s `onPaste`: pasted lines join with a space, as in the Go TUI's fields, instead of
 * the field dropping the line breaks and running the lines together. A trailing break goes.
 */
export function pasteOnOneLine(this: EditBufferRenderable, event: PasteEvent) {
  // The input's own paste handling, which also removes escape sequences and control characters.
  const field = this as EditBufferRenderable & { handlePaste?(event: PasteEvent): void };
  if (!field.handlePaste) return;
  const text = decodePasteBytes(event.bytes);
  if (!/[\r\n]/u.test(text)) return;
  event.preventDefault();
  const line = text.replace(/[\r\n]+$/u, "").replace(/[ \t]*(?:\r\n?|\n)[ \t]*/gu, " ");
  field.handlePaste(new PasteEvent(new TextEncoder().encode(line)));
}

/**
 * Whether the field that has the keyboard has text before its cursor, so ← moves the cursor
 * instead of the keyboard moving to the Tag list. Asked before the field takes the key.
 */
export function textBeforeCursor(renderer: CliRenderer): boolean {
  const field = renderer.currentFocusedRenderable as
    | (Renderable & { cursorOffset?: number })
    | null;
  if (!field || field.isDestroyed || !field.focused) return false;
  return typeof field.cursorOffset === "number" && field.cursorOffset > 0;
}

/**
 * A key layer over every other handler while `enabled`: it hears each key before the other
 * `useKeyboard` hooks and the focused field, whatever order they mounted in, and a key it takes
 * (`stopPropagation`) reaches none of them. The slash popup takes ↑ ↓ Tab Enter Esc this way.
 */
export function useKeyLayer(enabled: boolean, handler: (key: KeyEvent) => void) {
  const renderer = useRenderer();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const keys = renderer.keyInput;
    const listener = (key: KeyEvent) => latest.current(key);
    keys.prependListener("keypress", listener);
    return () => {
      keys.off("keypress", listener);
    };
  }, [renderer, enabled]);
}

/** Whether a scroll view shows its end. */
export function atBottom(box: ScrollBoxRenderable | null): boolean {
  if (!box) return true;
  return box.scrollTop + box.viewport.height >= box.scrollHeight - 1;
}

/**
 * A field whose text shows as dots, for a credential: it takes typed and pasted text while
 * `focused()`, Backspace, and Ctrl-U to clear it.
 */
export function MaskedField({
  focused,
  value,
  onChange,
  placeholder,
}: {
  /** Whether it takes keys now, asked at each key: Tab and the text after it can land together. */
  focused(): boolean;
  value: string;
  /** Takes how the text changes, as several keys can land before the next render. */
  onChange(change: (value: string) => string): void;
  placeholder: string;
}) {
  useKeyboard((key: KeyEvent) => {
    if (!focused()) return;
    if (key.ctrl && key.name === "u") onChange(() => "");
    if (key.ctrl || key.meta) return;
    if (key.name === "backspace") onChange((prior) => prior.slice(0, -1));
    else if (key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f")
      onChange((prior) => prior + key.sequence);
  });
  usePaste((event) => {
    const pasted = decodePasteBytes(event.bytes).replace(/\s+/gu, "");
    if (focused()) onChange((prior) => prior + pasted);
  });
  return (
    <text fg={value ? color.text : color.faint}>
      {value ? "•".repeat(Math.min(value.length, 40)) : placeholder}
      {focused() ? "▏" : ""}
    </text>
  );
}
