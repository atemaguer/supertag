import { desktop } from "./desktop";
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

/** Tag creation over a connection; `local` when it is the local Gateway, which can add folders. */
export function tagAdminSession(connectionId: string, local = false): TagAdmin {
  const api = desktop();
  return {
    options: () => api.listTagOptions({ connectionId }),
    create: (tag) => api.createTag({ connectionId, tag }),
    ...(local && { addFolder: () => api.addLocalWorkspace({ connectionId }) }),
  };
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
