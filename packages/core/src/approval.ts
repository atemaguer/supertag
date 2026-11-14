/**
 * One granted action that a Permission Set marks `approval: required`, frozen into a Task's
 * authorization snapshot. `permissionSets` names every requiring set; `approvers` is the union
 * of their approvers.
 */
export type TagApprovalRequirement =
  | {
      readonly target: "surface";
      readonly surfaceAccountId: string;
      readonly scope: string;
      readonly action: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    }
  | {
      readonly target: "runtime";
      readonly action: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    }
  | {
      readonly target: "mcp";
      /** The grant's `server/tool`, where the tool part may contain `*`. */
      readonly action: string;
      /** Omitted when the requirement covers every resource. */
      readonly resource?: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    };
