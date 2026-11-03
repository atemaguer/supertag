import { describe, expect, it } from "vitest";
import { verifyArtifactOrganizationEvidence } from "../scripts/artifact-organization-evidence.js";

type Input = Parameters<typeof verifyArtifactOrganizationEvidence>[0];
const nonce = "7d47ed98-49e6-4c28-8762-c9a35bc7e931";
function fixture(delivery: "read" | "materialize" = "read"): Input {
  const native = (id: string) => ({ harnessId: "codex", id });
  return {
    owner: "owner",
    reviewer: "reviewer",
    expectedMinutes: 5848,
    state: {
      objectives: [{ ownerTagId: "owner", status: "completed" }],
      assignments: [
        {
          taskId: "review-task",
          assignedTagId: "reviewer",
          requestedByTagId: "owner",
          status: "accepted",
        },
      ],
      tasks: [
        { id: "source-task", tagId: "owner" },
        { id: "review-task", tagId: "reviewer" },
        { id: "final-task", tagId: "owner" },
      ],
      attempts: [
        {
          id: "source-attempt",
          taskId: "source-task",
          workerHostId: "host-a",
          status: "completed",
        },
        {
          id: "review-attempt",
          taskId: "review-task",
          workerSnapshot: JSON.stringify({ workerHostId: "host-b" }),
          status: "completed",
        },
        { id: "final-attempt", taskId: "final-task", workerHostId: "host-a", status: "completed" },
      ],
      artifacts: [
        {
          id: "source",
          taskId: "source-task",
          attemptId: "source-attempt",
          tagId: "owner",
          harnessSession: native("source-native"),
          createdAt: "2026-09-16T10:00:00Z",
        },
        {
          id: "review",
          taskId: "review-task",
          attemptId: "review-attempt",
          tagId: "reviewer",
          harnessSession: JSON.stringify(native("review-native")),
          createdAt: "2026-09-16T10:01:00Z",
        },
        {
          id: "final",
          taskId: "final-task",
          attemptId: "final-attempt",
          tagId: "owner",
          harnessSession: native("final-native"),
          createdAt: "2026-09-16T10:03:00Z",
        },
      ],
      acquisitions: [
        {
          artifactId: "source",
          taskId: "review-task",
          attemptId: "review-attempt",
          delivery,
          status: "delivered",
          paths: JSON.stringify(["source.md"]),
          updatedAt: "2026-09-16T10:00:30Z",
        },
        {
          artifactId: "review",
          taskId: "final-task",
          attemptId: "final-attempt",
          delivery: "read",
          status: "delivered",
          paths: ["review.md"],
          updatedAt: "2026-09-16T10:02:00Z",
        },
      ],
    },
    contents: [
      {
        artifactId: "source",
        tagId: "owner",
        path: "source.md",
        text: `SOURCE_NONCE: ${nonce}\n17 * 43 * 8 = 5,848`,
      },
      {
        artifactId: "review",
        tagId: "reviewer",
        path: "review.md",
        text: `Verified ${nonce}, 5,848 minutes; producer codex/source-native`,
      },
      {
        artifactId: "final",
        tagId: "owner",
        path: "final.md",
        text: "Proceed: 5,848 minutes independently validated by artifact review.",
      },
    ],
    nativeSessions: [
      { attemptId: "source-attempt", harnessSession: native("source-native") },
      { attemptId: "review-attempt", harnessSession: native("review-native") },
      { attemptId: "final-attempt", harnessSession: native("final-native") },
    ],
  };
}
function row(input: Input, table: string, index = 0) {
  const value = input.state[table]?.[index];
  if (!value) throw new Error("Fixture row missing");
  return value;
}

describe("artifact organization evidence integrity", () => {
  it.each(["read", "materialize"] as const)(
    "accepts a complete cross-host %s handoff",
    (delivery) => {
      expect(verifyArtifactOrganizationEvidence(fixture(delivery))).toMatchObject({
        passed: true,
        sourceDelivery: delivery,
        reviewDelivery: "read",
        sourceNonce: nonce,
        sourceArtifactId: "source",
        reviewArtifactId: "review",
        finalArtifactId: "final",
        crossTagTransfers: 2,
      });
    },
  );
  it("requires owner acceptance of delegated review", () => {
    const input = fixture();
    row(input, "assignments")["status"] = "submitted";
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("accept independent review");
  });
  it.each(["same", "unknown"])(
    "rejects a %s review host even when unrelated Attempts span hosts",
    (mode) => {
      const input = fixture();
      row(input, "attempts", 1)["workerSnapshot"] =
        mode === "same" ? { workerHostId: "host-a" } : {};
      input.state["attempts"]?.push({
        id: "unrelated",
        taskId: "unrelated",
        workerHostId: "host-c",
        status: "completed",
      });
      expect(() => verifyArtifactOrganizationEvidence(input)).toThrow(
        "bidirectional delivered artifacts",
      );
    },
  );
  it("matches both native conversation ID and Harness provider to real observations", () => {
    for (const native of [
      { harnessId: "codex", id: "wrong" },
      { harnessId: "claude-code", id: "source-native" },
    ]) {
      const input = fixture();
      row(input, "artifacts")["harnessSession"] = native;
      expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("observed native Harness");
    }
  });
  it("does not borrow the correct nonce from an unrelated stale source", () => {
    const input = fixture();
    input.contents.unshift({
      artifactId: "stale-source",
      tagId: "owner",
      path: "source.md",
      text: `SOURCE_NONCE: ${nonce}; 5,848 minutes`,
    });
    const actual = input.contents.find((content) => content.artifactId === "source");
    if (!actual) throw new Error("Missing source");
    actual.text = "SOURCE_NONCE: b7b2a454-b67e-44b1-879d-37fa445a3e41; 5,848 minutes";
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("No verified consumed-source");
  });
  it.each([0, 1])("requires the actual evidence file in acquisition %s", (index) => {
    const input = fixture();
    row(input, "acquisitions", index)["paths"] = ["unrelated.md"];
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("No verified consumed-source");
  });
  it("requires final recommendation to cite the consumed review artifact", () => {
    const input = fixture();
    const final = input.contents.find((content) => content.artifactId === "final");
    if (!final) throw new Error("Missing final");
    final.text = "Proceed: 5,848 minutes, no supporting artifact citation.";
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("No verified consumed-source");
  });
  it("rejects an older final artifact produced before review consumption", () => {
    const input = fixture();
    row(input, "artifacts", 2)["createdAt"] = "2026-09-16T10:01:30Z";
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow("No verified consumed-source");
  });
  it("rejects authorized acquisitions whose bytes were never delivered", () => {
    const input = fixture();
    row(input, "acquisitions")["status"] = "authorized";
    expect(() => verifyArtifactOrganizationEvidence(input)).toThrow(
      "bidirectional delivered artifacts",
    );
  });
});
