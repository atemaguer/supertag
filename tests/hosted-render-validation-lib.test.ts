import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  digest,
  hasExactLine,
  isToolCallStarted,
  nativeSessionEvidence,
  redactSecrets,
  taskAttempt,
} from "../scripts/hosted-render-validation-lib.js";

describe("hosted Render validation evidence helpers", () => {
  it("extracts durable Task placement and recognizes exact lines and tool calls", () => {
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
    expect(hasExactLine("ARTIFACT_value\nARTIFACT_READY", "ARTIFACT_value")).toBe(true);
    expect(hasExactLine("prefix ARTIFACT_value", "ARTIFACT_value")).toBe(false);
    expect(hasExactLine("ARTIFACT_changed", "ARTIFACT_value")).toBe(false);
    expect(isToolCallStarted({ type: "tool.call.started" })).toBe(true);
    expect(isToolCallStarted({ type: "execution.tool.call.started" })).toBe(true);
    expect(isToolCallStarted({ type: "execution.tool.call.completed" })).toBe(false);
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
