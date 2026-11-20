/** Creating Tags: the form's options, the new Tag, and who may create one. */
import type { Tag } from "./gateway";

/** What a new Tag can run on: the harnesses and Workspaces the connected Worker Hosts offer. */
export interface TagOptions {
  harnesses: string[];
  workspaces: string[];
  /** Offered harnesses no host runs commands for: a Tag on one reads and edits files only. */
  noCommands?: string[];
  /** Offered harnesses whose every host runs Tasks in a sandbox without network: web access off. */
  noWeb?: string[];
}

/** A folder of this machine just added as a Workspace, and where its Sessions start. */
export interface AddedWorkspace {
  workspace: string;
  /** The branch checked out in the folder. */
  workspaceRef?: string;
  /** The commit checked out, when the folder's HEAD is detached. */
  workspaceCommit?: string;
}

/** A new Tag: its permanent ID, a display name, its harness, and optionally its Workspace. */
export interface NewTag {
  tagId: string;
  name?: string;
  harness: string;
  workspaceId?: string;
  /** Where a Workspace just added starts; otherwise the branch its other Tags follow. */
  workspaceRef?: string;
  workspaceCommit?: string;
  /** How many Work Sessions it may have open at once, 1 to 64. */
  maxWorkSessions?: number;
  /** Whether it may read web pages and its commands reach the network (`web:fetch`); default on. */
  webAccess?: boolean;
}

/** Creating Tags, which only an operator may do. */
export interface TagAdmin {
  options(): Promise<TagOptions>;
  create(tag: NewTag): Promise<Tag>;
  /**
   * Asks for a folder and adds its git repository as a Workspace of this machine; `null` when
   * the person cancelled. Only the local Gateway has it.
   */
  addFolder?(): Promise<AddedWorkspace | null>;
}

/** The harnesses a Tag can run on, in the order the app offers them: Codex and Claude Code first. */
export const HARNESSES: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  cursor: "Cursor",
  openai_agents: "OpenAI Agents",
};

export function harnessLabel(kind: string): string | undefined {
  return HARNESSES[kind];
}

/** A Tag ID from a name: lowercase letters, digits, and hyphens, as `supertag init` names Tags. */
export function tagIdFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** Why this connection cannot create Tags, or nothing when it can. */
export function tagAdminRefusal(principal?: string): string | undefined {
  if (!principal || principal.startsWith("operator:")) return undefined;
  return `Only an operator can create Tags. This app is connected as ${principal}.`;
}

/** The harnesses a form offers: the hosts' own, Codex and Claude Code first; every one with no host. */
export function offeredHarnesses(options: TagOptions | undefined): string[] {
  const known = Object.keys(HARNESSES);
  const rank = (kind: string) => (known.includes(kind) ? known.indexOf(kind) : known.length);
  return options?.harnesses.length
    ? [...options.harnesses].sort((a, b) => rank(a) - rank(b))
    : known;
}

/** What the New Tag form says and decides for a harness and the person's Web access choice. */
export interface NewTagRules {
  /** No host here runs commands for the harness: the Tag reads and edits files only. */
  noCommands: boolean;
  /** Every host of the harness runs Tasks in a sandbox without network. */
  noWeb: boolean;
  /** Cursor has no tool for reading web pages, so it never gets Web access. */
  webless: boolean;
  /** Whether the Tag gets Web access: the person's choice, else on unless its hosts have no network. */
  webAccess: boolean;
}

/** Web access, as the New Tag form explains it. */
export const WEB_ACCESS_HINT =
  "The Tag can read web pages, and its commands can reach the network. Web pages can carry instructions, so leave this off for a Tag that handles secrets.";

export function newTagRules(
  options: TagOptions | undefined,
  harness: string,
  webChoice: boolean | undefined,
): NewTagRules {
  const noCommands = options?.noCommands?.includes(harness) ?? false;
  const noWeb = options?.noWeb?.includes(harness) ?? false;
  const webless = harness === "cursor";
  return { noCommands, noWeb, webless, webAccess: !webless && (webChoice ?? !noWeb) };
}

/** The notes the New Tag form shows under its fields for `rules`, in order. */
export function newTagNotes(
  options: TagOptions | undefined,
  harness: string,
  rules: NewTagRules,
): string[] {
  const label = harnessLabel(harness) ?? harness;
  const notes: string[] = [];
  if (options && options.harnesses.length === 0) {
    notes.push("No Worker Host is connected. Choose the harness its host will run.");
  }
  if (rules.noCommands) {
    notes.push(
      `${label} has no sandbox of its own, and no host here lets it run commands, so this Tag reads and edits files only.`,
    );
  }
  if (rules.webless) notes.push("Cursor has no tool for reading web pages.");
  else if (rules.noWeb) {
    notes.push(
      `${label} runs here only in sandboxes without network, which run no Tag with web access.`,
    );
  }
  if (!rules.webAccess && harness === "codex") {
    notes.push("Current Codex models may not run commands without web access.");
  }
  return notes;
}
