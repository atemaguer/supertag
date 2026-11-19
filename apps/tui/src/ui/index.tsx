/**
 * The OpenTUI layer: the hooks, Markdown, scroll view and fields the screens use. Screens import
 * OpenTUI only through here (JSX elements aside), so a breaking OpenTUI minor touches one place.
 */
import type { KeyEvent, ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { createContext, memo, useContext, useMemo } from "react";
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
export type { KeyEvent, ScrollBoxRenderable };
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

/** Whether a scroll view shows its end. */
export function atBottom(box: ScrollBoxRenderable | null): boolean {
  if (!box) return true;
  return box.scrollTop + box.viewport.height >= box.scrollHeight - 1;
}

/**
 * A field whose text shows as dots, for a credential: it takes typed and pasted text while
 * `focused`, and Backspace.
 */
export function MaskedField({
  focused,
  value,
  onChange,
  placeholder,
}: {
  focused: boolean;
  value: string;
  /** Takes how the text changes, as several keys can land before the next render. */
  onChange(change: (value: string) => string): void;
  placeholder: string;
}) {
  useKeyboard((key: KeyEvent) => {
    if (!focused || key.ctrl || key.meta) return;
    if (key.name === "backspace") onChange((prior) => prior.slice(0, -1));
    else if (key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f")
      onChange((prior) => prior + key.sequence);
  });
  usePaste((event) => {
    const pasted = decodePasteBytes(event.bytes).replace(/\s+/gu, "");
    if (focused) onChange((prior) => prior + pasted);
  });
  return (
    <text fg={value ? color.text : color.faint}>
      {value ? "•".repeat(Math.min(value.length, 40)) : placeholder}
      {focused ? "▏" : ""}
    </text>
  );
}
