/**
 * Every command of the terminal UI, in one registry: the slash popup over the composer, the
 * Ctrl-K palette, the keys outside a panel, and the Keyboard shortcuts screen all read it, so
 * none of them lists a command the others don't, or a key nothing answers.
 */
import type { KeyEvent } from "./ui";

/** What a command can open: the screen's panels, by the names `app.tsx` gives them. */
export type CommandPanel =
  | "palette"
  | "gateways"
  | "help"
  | "newTag"
  | "goal"
  | "work"
  | "memory"
  | "schedules"
  | "network"
  | "activity";

/** What the screen lets a command do. */
export interface CommandActions {
  open(panel: CommandPanel): void;
  /** Opens the first inbox item, when there is one. */
  inbox(): void;
  /** Folds the Tag list to initials, or expands it. */
  fold(): void;
  quit(): void;
  /** Sends text to the conversation in front, like a message typed there. */
  send(text: string): void;
}

/** What a command's availability depends on. */
export interface CommandContext {
  /** A Tag is in front, so a command about one has one. */
  tag: boolean;
}

/** A key with Ctrl or nothing held, by OpenTUI's name for it. */
export interface CommandKey {
  name: string;
  ctrl?: boolean;
}

export interface Command {
  id: string;
  /** Its name in the palette. */
  title: string;
  /** One line: the popup, the palette's search, and the shortcuts screen show it. */
  description: string;
  slash?: {
    name: string;
    aliases?: readonly string[];
    /**
     * It takes an argument: choosing it from the popup writes `/name ` and waits for it. Without
     * one, Enter runs it alone. With `message`, `/name ARGUMENT` is a message the Gateway reads,
     * sent to the conversation like any other.
     */
    argument?: { hint: string; message?: boolean };
  };
  /** The key that runs it, outside a panel. */
  key?: CommandKey;
  /**
   * The key works over panels and before a Gateway connects (`App` answers it, not the
   * Workspace).
   */
  anywhere?: boolean;
  /** Listed in the palette (the palette's own command is not). */
  palette?: boolean;
  available?(context: CommandContext): boolean;
  run(actions: CommandActions, argument?: string): void;
}

const withTag = (context: CommandContext) => context.tag;

const panel = (
  id: "memory" | "schedules" | "network" | "activity",
  title: string,
  description: string,
): Command => ({
  id,
  title,
  description,
  slash: { name: id },
  available: withTag,
  run: (actions) => actions.open(id),
});

export const COMMANDS: readonly Command[] = [
  {
    id: "goal",
    title: "Create Objective",
    description: "An Objective the Tag owns; alone, the form",
    slash: { name: "goal", argument: { hint: "<outcome>", message: true } },
    available: withTag,
    run: (actions) => actions.open("goal"),
  },
  {
    id: "new-tag",
    title: "New Tag",
    description: "Create a Tag",
    slash: { name: "new" },
    key: { name: "n", ctrl: true },
    run: (actions) => actions.open("newTag"),
  },
  {
    id: "inbox",
    title: "Open inbox",
    description: "What waits on you, from the first item",
    slash: { name: "inbox" },
    run: (actions) => actions.inbox(),
  },
  {
    id: "work",
    title: "Work Sessions",
    description: "The longer work this conversation started",
    slash: { name: "work" },
    available: withTag,
    run: (actions) => actions.open("work"),
  },
  panel("memory", "Memory", "What the Tag's harness keeps on this machine"),
  panel("schedules", "Schedules", "The Tag's wake-ups: p pauses, x deletes"),
  panel("network", "Network", "Where the Tag's turns may connect"),
  panel("activity", "Activity", "What the Tag did lately"),
  {
    id: "gateways",
    title: "Gateways · add or switch",
    description: "Choose a Gateway (d forgets a saved one)",
    slash: { name: "gateways", aliases: ["gateway"] },
    key: { name: "p", ctrl: true },
    run: (actions) => actions.open("gateways"),
  },
  {
    id: "fold",
    title: "Fold or expand the Tag list",
    description: "Fold the Tag list to initials, or expand it",
    slash: { name: "fold" },
    key: { name: "b", ctrl: true },
    run: (actions) => actions.fold(),
  },
  {
    id: "help",
    title: "Keyboard shortcuts",
    description: "Every command and key",
    slash: { name: "help" },
    run: (actions) => actions.open("help"),
  },
  {
    id: "palette",
    title: "Search Tags and commands",
    description: "Search Tags and commands",
    key: { name: "k", ctrl: true },
    palette: false,
    run: (actions) => actions.open("palette"),
  },
  {
    id: "quit",
    title: "Quit",
    description: "Quit the terminal UI",
    slash: { name: "quit", aliases: ["exit", "q"] },
    key: { name: "c", ctrl: true },
    anywhere: true,
    run: (actions) => actions.quit(),
  },
];

/** The command with this ID; the registry has it. */
export function command(id: string): Command {
  const found = COMMANDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

/** The commands available now. */
export function availableCommands(context: CommandContext): Command[] {
  return COMMANDS.filter((entry) => entry.available?.(context) ?? true);
}

/** Runs a command: `/name ARGUMENT` of a message command is sent as the message. */
export function runCommand(entry: Command, actions: CommandActions, argument?: string): void {
  const slash = entry.slash;
  if (argument && slash?.argument?.message) actions.send(`/${slash.name} ${argument}`);
  else entry.run(actions, argument || undefined);
}

/** How a key shows: `Ctrl-N`. */
export function keyLabel(key: CommandKey): string {
  return `${key.ctrl ? "Ctrl-" : ""}${key.name.length === 1 ? key.name.toUpperCase() : key.name}`;
}

/** Whether a key event is the command's key: Ctrl as given, and no Alt. */
export function isKey(key: CommandKey, event: KeyEvent): boolean {
  return (
    event.name === key.name &&
    Boolean(event.ctrl) === Boolean(key.ctrl) &&
    !event.meta &&
    !event.option
  );
}

/** The command whose key this is, outside a panel. */
export function commandForKey(event: KeyEvent, context: CommandContext): Command | undefined {
  return availableCommands(context).find(
    (entry) => entry.key && !entry.anywhere && isKey(entry.key, event),
  );
}

/** Every name a command answers to, its own first. */
export function slashNames(entry: Command): string[] {
  return entry.slash ? [entry.slash.name, ...(entry.slash.aliases ?? [])] : [];
}

/** How the command shows in the popup and the shortcuts screen: `/goal <outcome>`. */
export function slashLabel(entry: Command, name = entry.slash?.name): string {
  const hint = entry.slash?.argument?.hint;
  return name ? `/${name}${hint ? ` ${hint}` : ""}` : "";
}

/**
 * What follows the `/` while a message is a command being typed: `/` is its first character,
 * and nothing after it is a space or another `/`. So `/usr/bin` and `fix /etc/hosts` stay text.
 */
export function slashQuery(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const query = text.slice(1);
  return /[\s/]/u.test(query) ? undefined : query;
}

/** A message that names a command: `/name` and what follows it, trimmed. */
export function slashHead(text: string): { name: string; argument: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match
    ? { name: (match[1] as string).toLowerCase(), argument: (match[2] ?? "").trim() }
    : undefined;
}

/** The command a message names, among those given, with its argument. */
export function namedCommand(
  text: string,
  commands: readonly Command[],
): { command: Command; argument: string } | undefined {
  const head = slashHead(text);
  if (!head) return undefined;
  const found = commands.find((entry) => slashNames(entry).includes(head.name));
  return found ? { command: found, argument: head.argument } : undefined;
}

/** Whether every character of `query` appears in `text`, in order. Both lower case. */
function inOrder(text: string, query: string): boolean {
  let at = 0;
  for (const character of query) {
    at = text.indexOf(character, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** How well a name matches: the start of it best, then within it, then its letters in order. */
function nameScore(name: string, query: string): number {
  if (name === query) return 4;
  if (name.startsWith(query)) return 3;
  if (name.includes(query)) return 2;
  return inOrder(name, query) ? 1 : 0;
}

export interface SlashMatch {
  command: Command;
  /** The name it matched by: an alias typed shows as itself. */
  name: string;
}

/** The most commands a query lists. */
export const SLASH_ROWS = 10;

/**
 * The commands a query after `/` matches, best first: by name or alias (the start of one best),
 * then by a word of the description. An empty query lists them all by name; a query, at most 10.
 */
export function slashMatches(query: string, commands: readonly Command[]): SlashMatch[] {
  const typed = query.toLowerCase();
  const named = commands.filter((entry) => entry.slash);
  if (!typed) {
    return named
      .map((entry) => ({ command: entry, name: entry.slash?.name as string }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const scored: (SlashMatch & { score: number })[] = [];
  for (const entry of named) {
    let best: SlashMatch & { score: number } = { command: entry, name: "", score: 0 };
    for (const name of slashNames(entry)) {
      const score = nameScore(name, typed);
      if (score > best.score) best = { command: entry, name, score };
    }
    if (best.score === 0 && entry.description.toLowerCase().includes(typed))
      best = { command: entry, name: entry.slash?.name as string, score: 0.5 };
    if (best.score > 0) scored.push(best);
  }
  return scored
    .sort(
      (a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
    )
    .slice(0, SLASH_ROWS)
    .map(({ command: entry, name }) => ({ command: entry, name }));
}
