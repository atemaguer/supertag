import { z } from "zod";
import {
  type CommitReview,
  CommitReviewDecision,
  type HarnessReviewPatch,
  type WorkspaceDeliveryReference,
} from "./gen/supertag/runtime/v2/runtime_pb.js";

const fullCommit = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;
const hash = /^[0-9a-f]{64}(?![\s\S])/u;
const workspaceId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}(?![\s\S])/u;
const maximumBlobBytes = 256 * 1024 * 1024;
const patchPageBytes = 16 * 1024;
const reviewId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\s\p{Cc}]/u.test(value));

export const commitReviewInput = z
  .strictObject({
    commit: z
      .string()
      .regex(fullCommit)
      .refine((value) => value.length === 40 || value.length === 64)
      .optional(),
    requestId: reviewId.optional(),
    verdict: z.enum(["approved", "changes_requested"]).optional(),
  })
  .refine(({ commit, requestId, verdict }) =>
    commit === undefined
      ? requestId !== undefined && verdict !== undefined
      : requestId === undefined && verdict === undefined,
  );

export const reviewPatchInput = z.strictObject({
  requestId: reviewId,
  offset: z.number().int().min(0).max(maximumBlobBytes).optional(),
});

export function reviewSubmission(review: z.infer<typeof commitReviewInput> | undefined) {
  if (review?.commit !== undefined) {
    return { case: "commit", value: review.commit.toLowerCase() } as const;
  }
  if (review?.requestId !== undefined && review.verdict !== undefined) {
    return {
      case: "response",
      value: {
        requestId: review.requestId,
        verdict:
          review.verdict === "approved"
            ? CommitReviewDecision.APPROVED
            : CommitReviewDecision.CHANGES_REQUESTED,
      },
    } as const;
  }
  return undefined;
}

function gitCommit(value: string) {
  return (
    (value.length === 40 || value.length === 64) &&
    fullCommit.test(value) &&
    value === value.toLowerCase()
  );
}

function identity(value: string) {
  return value.length > 0 && Buffer.byteLength(value) <= 256 && !/\p{Cc}/u.test(value);
}

export function verifiedReview(review: CommitReview) {
  const verdict = review.verdict;
  return (
    reviewId.safeParse(review.requestId).success &&
    gitCommit(review.commit) &&
    workspaceId.test(review.workspaceId) &&
    identity(review.objectiveId) &&
    identity(review.sourceTaskId) &&
    identity(review.requesterTagId) &&
    identity(review.reviewerTagId) &&
    review.requestedAtMs > 0n &&
    (!verdict ||
      ((verdict.decision === CommitReviewDecision.APPROVED ||
        verdict.decision === CommitReviewDecision.CHANGES_REQUESTED) &&
        identity(verdict.taskId) &&
        verdict.summary.length > 0 &&
        verdict.summary.length <= 8000 &&
        verdict.summary.trim().length > 0 &&
        !verdict.summary.includes("\0") &&
        verdict.recordedAtMs >= review.requestedAtMs))
  );
}

export function projectReview(review: CommitReview, safeText: (text: string) => string) {
  return {
    requestId: safeText(review.requestId),
    commit: safeText(review.commit),
    ...(review.verdict
      ? {
          verdict: {
            decision:
              review.verdict.decision === CommitReviewDecision.APPROVED
                ? "approved"
                : "changes_requested",
            summary: safeText(review.verdict.summary),
          },
        }
      : {}),
  };
}

export function verifiedReviewPage(page: HarnessReviewPatch, requestId: string, offset: bigint) {
  const delivery = page.delivery;
  const patch = delivery?.patch;
  const bundle = delivery?.bundle;
  const end = offset + BigInt(page.data.length);
  if (
    page.reviewId !== requestId ||
    page.offset !== offset ||
    !delivery ||
    !workspaceId.test(delivery.workspaceId) ||
    !hash.test(delivery.deliveryId) ||
    ![delivery.baseCommit, delivery.startCommit, delivery.headCommit].every(
      (commit) => gitCommit(commit) && commit.length === delivery.baseCommit.length,
    ) ||
    delivery.committed !== (delivery.startCommit !== delivery.headCommit) ||
    delivery.committed !== delivery.changedFiles > 0n ||
    !patch ||
    !hash.test(patch.sha256) ||
    delivery.committed !== patch.byteLength > 0n ||
    patch.byteLength > BigInt(maximumBlobBytes) ||
    !bundle ||
    !hash.test(bundle.sha256) ||
    bundle.byteLength === 0n ||
    bundle.byteLength > BigInt(maximumBlobBytes) ||
    page.data.length > patchPageBytes ||
    (offset !== patch.byteLength && page.data.length === 0) ||
    end > patch.byteLength ||
    page.nextOffset !== (end < patch.byteLength ? end : undefined)
  )
    return undefined;
  return delivery;
}

export function reviewDeliveryKey(delivery: WorkspaceDeliveryReference) {
  return JSON.stringify([
    delivery.workspaceId,
    delivery.deliveryId,
    delivery.baseCommit,
    delivery.startCommit,
    delivery.headCommit,
    delivery.changedFiles.toString(),
    delivery.patch?.sha256,
    delivery.patch?.byteLength.toString(),
    delivery.bundle?.sha256,
    delivery.bundle?.byteLength.toString(),
  ]);
}

export function reviewPatchText(data: Uint8Array) {
  try {
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
    };
  } catch {
    // Byte offsets can split UTF-8 and Git patches can contain arbitrary bytes.
    const text = Array.from(data, (byte) => {
      if (byte === 92) return "\\\\";
      return byte < 128 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`;
    }).join("");
    return { encoding: "escaped-bytes", text };
  }
}
