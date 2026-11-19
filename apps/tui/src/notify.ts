/**
 * Terminal notifications. Which replies and questions notify is `alertsFor`'s decision, shared
 * with the desktop app; this writes them as OSC 9 (`ESC ] 9 ; text BEL`), which iTerm2, kitty,
 * WezTerm, Ghostty and others show as a desktop notification. Inside tmux it goes through DCS
 * passthrough (tmux needs `allow-passthrough on`). OpenTUI's own notification only goes out where
 * it detected kitty's OSC 99, so this writer is ours. `bell` rings the bell instead.
 */
import type { Alert } from "@supertag/client/model";
import type { NotifyLevel } from "./launch";

/** The bytes one notification writes. */
export function notificationBytes(
  alert: Pick<Alert, "title" | "body">,
  level: NotifyLevel,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (level === "off") return "";
  if (level === "bell") return "\u0007";
  // Nothing from the Tag may end the sequence early or start another.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  const text = [clean(alert.title), clean(alert.body)].filter(Boolean).join(": ").slice(0, 200);
  const osc = `\u001b]9;${text}\u0007`;
  const inTmux = Boolean(env["TMUX"]) || env["TERM_PROGRAM"] === "tmux";
  return inTmux ? `\u001bPtmux;${osc.replaceAll("\u001b", "\u001b\u001b")}\u001b\\` : osc;
}

/** The level `alertsFor` decides with: `bell` rings for what `all` notifies. */
export function alertLevel(level: NotifyLevel): "all" | "questions" | "off" {
  return level === "bell" ? "all" : level;
}
