import { type Objective, TagMessagingError } from "@supertag/core";
import { describe, expect, it } from "vitest";
import {
  authorityRevokedError,
  controlPlaneAbortMessage,
  objectiveStopCause,
} from "./src/objective-controller.js";

describe("Task Attempt authority revocation cause", () => {
  it("names the Control Plane's revocation cause", () => {
    const error = authorityRevokedError(new TagMessagingError(403, "Objective deadline passed"));
    expect(error.name).toBe("ExecutionAuthorityRevokedError");
    expect(error.message).toBe(
      "Control Plane revoked Task Attempt authority: Objective deadline passed",
    );
  });

  it("falls back to a lost lease when the check gives no cause", () => {
    expect(authorityRevokedError(undefined).message).toBe(
      "Control Plane revoked Task Attempt authority: Execution lease lost",
    );
  });

  it("prefers the Control Plane abort cause over the harness error", () => {
    const abort = new AbortController();
    expect(controlPlaneAbortMessage(abort.signal)).toBeUndefined();
    abort.abort(authorityRevokedError(new Error("Attempt authority expired")));
    expect(controlPlaneAbortMessage(abort.signal)).toBe(
      "Control Plane revoked Task Attempt authority: Attempt authority expired",
    );
  });

  it("ignores a bare abort that carries no cause", () => {
    const abort = new AbortController();
    abort.abort();
    expect(controlPlaneAbortMessage(abort.signal)).toBeUndefined();
  });

  it("names a deadline, cancellation, or completion as the Objective's stop cause", () => {
    const now = "2026-10-02T18:30:00.000Z";
    const objective = (fields: Partial<Objective>) =>
      ({ status: "working", deadline: null, ...fields }) as Objective;
    expect(objectiveStopCause(objective({}), false, now, 0)).toBeUndefined();
    expect(
      objectiveStopCause(objective({ deadline: "2026-10-02T18:00:00.000Z" }), false, now, 0),
    ).toBe("Objective deadline passed");
    // Within the grace period after the deadline, the Attempt keeps its authority.
    expect(
      objectiveStopCause(
        objective({ deadline: "2026-10-02T18:00:00.000Z" }),
        false,
        now,
        60 * 60_000,
      ),
    ).toBeUndefined();
    expect(objectiveStopCause(objective({ status: "cancelled" }), false, now, 0)).toBe(
      "Objective was cancelled",
    );
    expect(objectiveStopCause(objective({ status: "completed" }), false, now, 0)).toBe(
      "Objective was completed",
    );
    expect(objectiveStopCause(objective({ status: "completed" }), true, now, 0)).toBeUndefined();
  });

  it("records a budget stop as a revocation cause", () => {
    const abort = new AbortController();
    abort.abort(authorityRevokedError(new Error("Objective budget exhausted")));
    expect(controlPlaneAbortMessage(abort.signal)).toBe(
      "Control Plane revoked Task Attempt authority: Objective budget exhausted",
    );
  });

  it("does not revoke running work when a reported budget is exhausted", () => {
    const objective = {
      status: "working",
      deadline: null,
      budgetLimitMinor: 100,
      budgetCurrency: "USD",
      limitState: {
        budgetExhausted: { limitMinor: 100, spentMinor: 110, at: "2026-10-02T18:00:00.000Z" },
      },
    } as Objective;
    expect(objectiveStopCause(objective, false, "2026-10-02T18:30:00.000Z", 0)).toBeUndefined();
  });
});
