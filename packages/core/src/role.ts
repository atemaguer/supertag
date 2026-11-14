/** Exact Role and assignment state captured before durable Task admission. */
export interface TagRoleSnapshot {
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly role: {
    readonly id: string;
    readonly name: string;
    readonly purpose: string;
    readonly instructions: string;
    readonly revision: number;
    readonly contextSetIds: readonly string[];
    readonly permissionSetIds: readonly string[];
  };
}
