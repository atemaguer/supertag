import type { InboundSurfaceEvent } from "./index.js";

export type SurfaceObjectiveCommand =
  | { readonly kind: "create"; readonly outcome: string }
  | { readonly kind: "approve" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "invalid" };

/** Parse only the authenticated invocation, never history or model-supplied text. */
export function parseSurfaceObjectiveCommand(
  event: InboundSurfaceEvent,
): SurfaceObjectiveCommand | undefined {
  if (event.actor.kind !== "user" || event.kind !== "mention") return undefined;
  const text = event.text?.trim() ?? "";
  const mention = event.provider === "slack" ? /^(?:@SuperTag|<@[A-Z0-9]+>)\s+/i : /^@SuperTag\s+/i;
  const prefix = mention.exec(text);
  if (!prefix) return undefined;
  const body = text.slice(prefix[0].length);
  // Approves the Objective whose home thread this is; valid only in that thread.
  if (/^approve[.!]?$/i.test(body.trim())) return { kind: "approve" };
  // Pause and resume, like approve, act on the Objective whose home thread this is.
  if (/^pause[.!]?$/i.test(body.trim())) return { kind: "pause" };
  if (/^resume[.!]?$/i.test(body.trim())) return { kind: "resume" };
  const command = /^objective(?:\s+([\s\S]*))?$/i.exec(body);
  if (!command) return undefined;
  const argument = command[1]?.trim() ?? "";
  if (!argument) return { kind: "invalid" };
  return { kind: "create", outcome: argument };
}
