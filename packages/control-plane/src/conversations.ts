import { objectiveSessionKey, type Store, type Task } from "@supertag/core";

/** A CLI conversation's name: 1 to 64 letters, digits, `.`, `_` or `-`, starting with one of the first two. */
export const CONVERSATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** The Session key of an operator's CLI conversation with a Tag. */
export function cliConversationKey(operatorId: string, name: string): string {
  return `cli:${operatorId}:${name}`;
}

/** The operator and name of a CLI conversation's Session key; undefined for any other key. */
export function parseCliConversationKey(
  key: string,
): { readonly operatorId: string; readonly name: string } | undefined {
  if (!key.startsWith("cli:")) return undefined;
  // An operator ID such as `token:NAME` has colons; a conversation name has none.
  const last = key.lastIndexOf(":");
  const operatorId = key.slice("cli:".length, last);
  const name = key.slice(last + 1);
  return last > "cli:".length && CONVERSATION_NAME.test(name) ? { operatorId, name } : undefined;
}

/**
 * The CLI conversation a Task is a message of, and the operator who reads it there. A turn of
 * the conversation's own Session belongs to its operator. An Objective's own turn belongs where
 * its home thread is: to the operator whose CLI conversation that is, or, for an Objective without
 * a home thread, to every operator (`*`), named `objective:ID`. A work Session's Task is no
 * message: undefined, as for every other Task.
 */
export async function messageConversation(
  store: Pick<Store, "findSessionById" | "findInboundEventById">,
  task: Task,
): Promise<{ readonly owner: string; readonly name: string } | undefined> {
  const origin = task.trigger["origin"];
  const key =
    typeof origin === "object" && origin !== null && !Array.isArray(origin)
      ? (origin as Record<string, unknown>)["sessionKey"]
      : undefined;
  const own = typeof key === "string" ? parseCliConversationKey(key) : undefined;
  if (own !== undefined) return { owner: own.operatorId, name: own.name };
  if (task.objectiveId === undefined || !task.inboundEventId) return undefined;
  const session = await store.findSessionById(task.sessionId);
  if (session?.sessionKey !== objectiveSessionKey(task.objectiveId)) return undefined;
  const callback = (await store.findInboundEventById(task.inboundEventId))?.event.callback;
  if (callback?.mode !== "cli_conversation") return undefined;
  if (callback.threadKey === session.sessionKey) return { owner: "*", name: session.sessionKey };
  const home = parseCliConversationKey(callback.threadKey);
  return home === undefined ? undefined : { owner: home.operatorId, name: home.name };
}
