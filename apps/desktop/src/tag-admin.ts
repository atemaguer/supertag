import { invoke } from "@tauri-apps/api/core";
import type { Tag } from "./control-plane";

/** What a new Tag can run on: the harnesses and Workspaces the connected Worker Hosts offer. */
export interface TagOptions {
  harnesses: string[];
  workspaces: string[];
}

/** A new Tag: its permanent ID, a display name, its harness, and optionally its Workspace. */
export interface NewTag {
  tagId: string;
  name?: string;
  harness: string;
  workspaceId?: string;
  /** How many Work Sessions it may have open at once, 1 to 64. */
  maxWorkSessions?: number;
}

/** Creating Tags, which only an operator may do. */
export interface TagAdmin {
  options(): Promise<TagOptions>;
  create(tag: NewTag): Promise<Tag>;
}

export function tagAdminSession(connectionId: string): TagAdmin {
  return {
    options: () => invoke("list_tag_options", { connectionId }),
    create: (tag) => invoke("create_tag", { connectionId, tag }),
  };
}

/** The harnesses a Tag can name, in the order they are offered. */
export const HARNESSES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
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
