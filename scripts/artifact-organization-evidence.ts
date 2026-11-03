import assert from "node:assert/strict";

type Row = Record<string, unknown>;
export interface ArtifactOrganizationContent {
  artifactId: unknown;
  tagId: unknown;
  path: unknown;
  text: string;
}
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const json = (value: unknown): Row =>
  typeof value === "string" ? record(JSON.parse(value)) : record(value);
const host = (attempt: Row | undefined): unknown =>
  attempt?.["workerHostId"] ?? json(attempt?.["workerSnapshot"])["workerHostId"];
const selectedPath = (acquisition: Row, path: unknown): boolean => {
  const paths: unknown =
    typeof acquisition["paths"] === "string"
      ? JSON.parse(acquisition["paths"])
      : acquisition["paths"];
  return Array.isArray(paths) && paths.includes(path);
};
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const minutes = (text: string, expected: number) =>
  new RegExp(`(^|[^0-9])${expected}([^0-9]|$)`).test(text.replaceAll(",", ""));

/** Verify observed organization output; supports both native reads and admitted file attachments. */
export function verifyArtifactOrganizationEvidence(input: {
  state: Record<string, Row[]>;
  contents: ArtifactOrganizationContent[];
  nativeSessions: Row[];
  owner: string;
  reviewer: string;
  expectedMinutes: number;
}) {
  const { state, contents, nativeSessions, owner, reviewer, expectedMinutes } = input;
  const artifacts = state["artifacts"] ?? [],
    acquisitions = state["acquisitions"] ?? [],
    attempts = state["attempts"] ?? [],
    tasks = state["tasks"] ?? [],
    assignments = state["assignments"] ?? [];
  assert(
    state["objectives"]?.some(
      (objective) => objective["ownerTagId"] === owner && objective["status"] === "completed",
    ),
    "Owner Objective was not completed",
  );
  assert(
    attempts.length > 0 &&
      attempts.every((attempt) =>
        ["completed", "failed", "cancelled"].includes(String(attempt["status"])),
      ),
    "Organization still has unsettled Attempts",
  );
  const acceptedReviews = assignments.filter(
    (assignment) =>
      assignment["assignedTagId"] === reviewer &&
      assignment["requestedByTagId"] === owner &&
      assignment["status"] === "accepted",
  );
  assert(acceptedReviews.length, "Owner did not delegate and accept independent review");
  assert(
    new Set(attempts.map(host).filter(textId)).size >= 2,
    "Organization did not execute on two known Worker Hosts",
  );
  for (const artifact of artifacts) {
    const native = json(artifact["harnessSession"]);
    assert(
      textId(native["id"]) && textId(native["harnessId"]),
      "Artifact is missing native conversation provenance",
    );
    assert(
      nativeSessions.some(
        (observed) =>
          observed["attemptId"] === artifact["attemptId"] &&
          json(observed["harnessSession"])["id"] === native["id"] &&
          json(observed["harnessSession"])["harnessId"] === native["harnessId"],
      ),
      "Captured conversation differs from observed native Harness execution",
    );
  }
  const delivered = acquisitions.filter((acquisition) => {
    if (
      !["read", "materialize"].includes(String(acquisition["delivery"])) ||
      acquisition["status"] !== "delivered"
    )
      return false;
    const artifact = artifacts.find((item) => item["id"] === acquisition["artifactId"]);
    const consumer = tasks.find((item) => item["id"] === acquisition["taskId"]);
    const sourceAttempt = attempts.find((item) => item["id"] === artifact?.["attemptId"]);
    const consumerAttempt = attempts.find((item) => item["id"] === acquisition["attemptId"]);
    return (
      artifact &&
      consumer &&
      sourceAttempt &&
      consumerAttempt &&
      sourceAttempt["taskId"] === artifact["taskId"] &&
      consumerAttempt["taskId"] === consumer["id"] &&
      textId(host(sourceAttempt)) &&
      textId(host(consumerAttempt)) &&
      host(sourceAttempt) !== host(consumerAttempt) &&
      artifact["tagId"] !== consumer["tagId"]
    );
  });
  for (const [producer, consumer] of [
    [owner, reviewer],
    [reviewer, owner],
  ])
    assert(
      delivered.some(
        (acquisition) =>
          artifacts.find((item) => item["id"] === acquisition["artifactId"])?.["tagId"] ===
            producer &&
          tasks.find((item) => item["id"] === acquisition["taskId"])?.["tagId"] === consumer,
      ),
      "Missing bidirectional delivered artifacts between known distinct Worker Hosts",
    );

  // Follow one actual source -> accepted review -> final artifact chain, rather than mixing retries.
  for (const sourceRead of delivered) {
    const source = artifacts.find((item) => item["id"] === sourceRead["artifactId"]);
    if (
      source?.["tagId"] !== owner ||
      !acceptedReviews.some((review) => review["taskId"] === sourceRead["taskId"])
    )
      continue;
    const native = json(source["harnessSession"]);
    const sourceContents = contents.filter(
      (content) =>
        content.artifactId === source["id"] &&
        content.tagId === owner &&
        selectedPath(sourceRead, content.path),
    );
    for (const sourceContent of sourceContents) {
      const nonce =
        /SOURCE_NONCE:\s*[`"']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(
          sourceContent.text,
        )?.[1];
      if (!nonce || !minutes(sourceContent.text, expectedMinutes)) continue;
      for (const review of artifacts) {
        if (
          review["tagId"] !== reviewer ||
          review["taskId"] !== sourceRead["taskId"] ||
          review["attemptId"] !== sourceRead["attemptId"]
        )
          continue;
        const reviewContent = contents.find(
          (content) =>
            content.artifactId === review["id"] &&
            content.tagId === reviewer &&
            content.text.includes(nonce) &&
            content.text.includes(String(native["id"])) &&
            content.text.includes(String(native["harnessId"])) &&
            minutes(content.text, expectedMinutes),
        );
        if (!reviewContent) continue;
        for (const reviewRead of delivered) {
          if (
            reviewRead["artifactId"] !== review["id"] ||
            !selectedPath(reviewRead, reviewContent.path) ||
            tasks.find((task) => task["id"] === reviewRead["taskId"])?.["tagId"] !== owner
          )
            continue;
          const readAt = Date.parse(String(reviewRead["updatedAt"]));
          if (!Number.isFinite(readAt)) continue;
          const final = artifacts.find(
            (artifact) =>
              artifact["tagId"] === owner &&
              artifact["attemptId"] === reviewRead["attemptId"] &&
              Date.parse(String(artifact["createdAt"])) >= readAt &&
              contents.some(
                (content) =>
                  content.artifactId === artifact["id"] &&
                  content.tagId === owner &&
                  content.text.includes(String(review["id"])) &&
                  minutes(content.text, expectedMinutes),
              ),
          );
          if (!final) continue;
          return {
            passed: true as const,
            attempts: attempts.length,
            artifacts: artifacts.length,
            crossTagTransfers: delivered.length,
            sourceNonce: nonce,
            sourceArtifactId: source["id"],
            reviewArtifactId: review["id"],
            finalArtifactId: final["id"],
            sourceDelivery: sourceRead["delivery"],
            reviewDelivery: reviewRead["delivery"],
            expectedMinutes,
          };
        }
      }
    }
  }
  assert.fail(
    "No verified consumed-source nonce and native-session chain through accepted review to a subsequent final owner recommendation",
  );
}
