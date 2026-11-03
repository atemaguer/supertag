import type { CapturedArtifactEntry } from "./artifact-catalog.js";
export type ArtifactApprovalActor =
  | { readonly kind: "tag"; readonly tagId: string }
  | { readonly kind: "operator"; readonly operatorId: string };

export interface ArtifactPublication {
  readonly id: string;
  readonly sourceTaskId: string;
  readonly sourceObjectiveId: string;
  readonly artifactId: string;
  readonly paths: readonly string[];
  readonly entries: readonly CapturedArtifactEntry[];
  readonly sourceAttemptId: string;
  readonly sourceAttemptCount: number;
  readonly reviewedByTagId: string;
  /** Complete review evidence stays internal; audience-facing projections omit it by default. */
  readonly assessment: string;
  readonly acceptedAt: string;
  readonly audienceObjectiveIds: readonly string[];
  readonly approvedBy: ArtifactApprovalActor;
  readonly approvedAt: string;
  readonly supersedesPublicationId: string | null;
  readonly status: "available" | "withdrawn";
  readonly revision: number;
  readonly withdrawnBy: ArtifactApprovalActor | null;
  readonly withdrawnAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactPublicationAudienceView {
  readonly id: string;
  readonly sourceObjectiveId: string;
  readonly artifactId: string;
  readonly paths: readonly string[];
  readonly entries: readonly CapturedArtifactEntry[];
  readonly sourceAttemptCount: number;
  readonly acceptedAt: string;
  readonly supersedesPublicationId: string | null;
  readonly status: ArtifactPublication["status"];
  readonly revision: number;
}

export interface ArtifactConsumptionApproval {
  readonly id: string;
  readonly publicationApprovalId: string;
  readonly objectiveId: string;
  readonly approvedBy: ArtifactApprovalActor;
  readonly approvedAt: string;
  readonly status: "available" | "withdrawn";
  readonly revision: number;
  readonly withdrawnBy: ArtifactApprovalActor | null;
  readonly withdrawnAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactApprovalAuditEvent {
  readonly id: string;
  readonly approvalType: "publication" | "consumption";
  readonly approvalId: string;
  readonly objectiveId: string;
  readonly revision: number;
  readonly action: "approved" | "withdrawn";
  readonly actor: ArtifactApprovalActor;
  readonly createdAt: string;
}

export interface ApproveArtifactPublicationInput {
  readonly id: string;
  readonly artifactId: string;
  readonly paths: readonly string[];
  readonly audienceObjectiveIds: readonly string[];
  readonly supersedesPublicationId?: string;
}

export interface ApproveArtifactConsumptionInput {
  readonly id: string;
  readonly publicationApprovalId: string;
  readonly objectiveId: string;
}

export interface WithdrawArtifactApprovalInput {
  readonly id: string;
  readonly expectedRevision: number;
}

export interface ArtifactPublicationStore {
  approveArtifactPublication(
    input: ApproveArtifactPublicationInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactPublication>;
  approveArtifactConsumption(
    input: ApproveArtifactConsumptionInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactConsumptionApproval>;
  withdrawArtifactPublication(
    input: WithdrawArtifactApprovalInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactPublication>;
  withdrawArtifactConsumption(
    input: WithdrawArtifactApprovalInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactConsumptionApproval>;
  getArtifactPublication(id: string): Promise<ArtifactPublication | undefined>;
  getArtifactConsumptionApproval(id: string): Promise<ArtifactConsumptionApproval | undefined>;
  listArtifactPublicationsForObjective(
    objectiveId: string,
  ): Promise<readonly ArtifactPublicationAudienceView[]>;
  listArtifactConsumptionApprovals(
    objectiveId: string,
  ): Promise<readonly ArtifactConsumptionApproval[]>;
  listArtifactApprovalAuditEvents(input: {
    approvalType: ArtifactApprovalAuditEvent["approvalType"];
    approvalId: string;
  }): Promise<readonly ArtifactApprovalAuditEvent[]>;
}
