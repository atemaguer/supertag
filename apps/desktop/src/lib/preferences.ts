/**
 * What a person chose for this device, kept in the window's storage: which key sends a message.
 * Every view showing a preference follows a change at once.
 */
import { useCallback, useEffect, useState } from "react";

/** `enter`: Enter sends and Shift+Enter starts a line. `mod-enter`: ⌘Enter (Ctrl+Enter) sends. */
export type SendKey = "enter" | "mod-enter";

const SEND_KEY = "supertag.desktop.send-key";
const SEND_EVENT = "supertag-send-key";

export function readSendKey(): SendKey {
  try {
    return localStorage.getItem(SEND_KEY) === "mod-enter" ? "mod-enter" : "enter";
  } catch {
    return "enter";
  }
}

export function useSendKey() {
  const [key, setKey] = useState(readSendKey);
  useEffect(() => {
    const changed = () => setKey(readSendKey());
    window.addEventListener(SEND_EVENT, changed);
    return () => window.removeEventListener(SEND_EVENT, changed);
  }, []);
  const change = useCallback((next: SendKey) => {
    try {
      if (next === "enter") localStorage.removeItem(SEND_KEY);
      else localStorage.setItem(SEND_KEY, next);
    } catch {
      // Without storage, the choice lasts until the window closes.
    }
    setKey(next);
    window.dispatchEvent(new Event(SEND_EVENT));
  }, []);
  return [key, change] as const;
}

/** Whether a key press in the composer sends the message, under the person's choice. */
export function sendsMessage(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  choice: SendKey,
  mac: boolean,
): boolean {
  if (event.key !== "Enter") return false;
  const mod = mac ? event.metaKey : event.ctrlKey;
  return choice === "enter" ? !event.shiftKey && !mod : mod;
}

/** The composer's hint and the shortcut list: which keys send and which start a line. */
export function sendKeyWords(choice: SendKey, mac: boolean): { send: string; line: string } {
  const mod = mac ? "⌘Enter" : "Ctrl+Enter";
  return choice === "enter" ? { send: "Enter", line: "Shift+Enter" } : { send: mod, line: "Enter" };
}
