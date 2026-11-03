import { describe, expect, it } from "vitest";
import {
  artifactSelection,
  assertExactArtifactAdmission,
  assertNoSecrets,
  digest,
  hasExactLine,
  isToolCallStarted,
  nativeSessionEvidence,
  outputText,
  redactSecrets,
  taskAttempt,
} from "../scripts/hosted-render-validation-lib.js";

describe("hosted Render validation evidence helpers", () => {
  it("extracts durable Task placement, result, and exact artifact selectors", () => {
    const task = {
      status: {
        attempt: {
          id: "attempt-2",
          number: 2,
          phase: "completed",
          workerHostId: "host-b",
          workerId: "worker-b",
          workerProfile: { id: "native-profile", revision: "1" },
        },
        outcome: {
          text: "Completed successfully; the required artifact was published.",
          taskResult: {
            artifacts: [{ artifactId: "artifact-1", paths: ["outputs/evidence.txt"] }],
          },
        },
      },
    };

    expect(taskAttempt(task)).toEqual({
      id: "attempt-2",
      number: 2,
      phase: "completed",
      workerHostId: "host-b",
      workerId: "worker-b",
      profile: { id: "native-profile", revision: "1" },
    });
    expect(outputText(task)).toBe("Completed successfully; the required artifact was published.");
    expect(hasExactLine("ARTIFACT_value\nARTIFACT_READY", "ARTIFACT_value")).toBe(true);
    expect(hasExactLine("prefix ARTIFACT_value", "ARTIFACT_value")).toBe(false);
    expect(hasExactLine("ARTIFACT_changed", "ARTIFACT_value")).toBe(false);
    expect(isToolCallStarted({ type: "tool.call.started" })).toBe(true);
    expect(isToolCallStarted({ type: "execution.tool.call.started" })).toBe(true);
    expect(isToolCallStarted({ type: "execution.tool.call.completed" })).toBe(false);
    expect(artifactSelection(task)).toEqual({
      artifactId: "artifact-1",
      paths: ["outputs/evidence.txt"],
    });
    const admitted = {
      artifactId: "artifact-1",
      path: "outputs/evidence.txt",
      digest: "sha256:artifact-digest",
      sizeBytes: 41,
      uri: "supertag-artifact:sha256:artifact-digest",
      provenance: { taskId: "producer", attemptId: "attempt-1", attemptCount: 1 },
    };
    expect(
      assertExactArtifactAdmission([admitted], {
        artifactId: "artifact-1",
        path: "outputs/evidence.txt",
        digest: "sha256:artifact-digest",
        sizeBytes: 41,
      }),
    ).toEqual(admitted);
    for (const changed of [
      { ...admitted, artifactId: "artifact-2" },
      { ...admitted, path: "outputs/other.txt" },
      { ...admitted, digest: "sha256:changed" },
      { ...admitted, sizeBytes: 42 },
    ])
      expect(() =>
        assertExactArtifactAdmission([changed], {
          artifactId: "artifact-1",
          path: "outputs/evidence.txt",
          digest: "sha256:artifact-digest",
          sizeBytes: 41,
        }),
      ).toThrow();
    expect(() =>
      assertExactArtifactAdmission([admitted, admitted], {
        artifactId: "artifact-1",
        path: "outputs/evidence.txt",
        digest: "sha256:artifact-digest",
        sizeBytes: 41,
      }),
    ).toThrow("Expected one admitted input artifact");
  });

  it("requires stable native identity evidence and rejects protected report content", () => {
    expect(
      nativeSessionEvidence({
        states: [
          { id: "state-1", nativeId: "native-1" },
          { id: "state-2", nativeId: "native-1" },
        ],
      }),
    ).toEqual({ count: 2, nativeIds: ["native-1"], stateIds: ["state-1", "state-2"] });

    const protectedValue = "private-value";
    expect(() =>
      assertNoSecrets({ digest: digest(protectedValue) }, [protectedValue], "report"),
    ).not.toThrow();
    expect(() =>
      assertNoSecrets({ accidentallyLeaked: protectedValue }, [protectedValue], "report"),
    ).toThrow("report contains protected input");
    expect(redactSecrets(`Failure contained ${protectedValue}`, [protectedValue])).toBe(
      "Failure contained [redacted]",
    );
  });
});
