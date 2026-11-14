/**
 * How a Worker returns a Task's committed workspace changes. `pull-request` needs a GitHub
 * `source`.
 */
export const WORKSPACE_DELIVERIES = ["patch", "branch", "pull-request"] as const;
export type WorkspaceDelivery = (typeof WORKSPACE_DELIVERIES)[number];

/** Operator-declared data copied beside a Task checkout. No credential value is stored here. */
export interface WorkspaceMount {
  readonly volume: string;
  readonly path: string;
  readonly access: "read-only" | "read-write";
  readonly strategy: "copy" | "mount";
  readonly maxBytes?: number;
}

/** GitHub repository Skills selected for every Task in a Workspace. */
export interface WorkspaceSkillCatalog {
  readonly repository: string;
  readonly path: string;
  readonly revision: string;
  readonly skills: readonly string[];
}

/** The pull request a Worker opened for a Task, as recorded on its Task Attempt result. */
export interface WorkspacePullRequest {
  readonly surfaceAccountId?: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}
