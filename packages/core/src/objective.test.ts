import { describe, expect, it } from "vitest";
import {
  objectiveClosed,
  parseCancelObjective,
  parseCreateObjective,
  parseObjectiveStatus,
} from "./objective.js";

describe("Objective cancellation input", () => {
  it("accepts an optional bounded reason and rejects cancellation through status updates", () => {
    expect(parseCancelObjective(undefined)).toEqual({ reason: null });
    expect(parseCancelObjective({ reason: "  Priorities changed " })).toEqual({
      reason: "Priorities changed",
    });
    expect(() => parseCancelObjective({ reason: "" })).toThrow("reason must contain");
    expect(() => parseCancelObjective({ reason: "x".repeat(2001) })).toThrow("reason must contain");
    expect(() => parseCancelObjective({ revision: 1 })).toThrow("Unknown field: revision");
    expect(() => parseObjectiveStatus({ status: "cancelled", expectedRevision: 1 })).toThrow(
      "Only an operator can cancel an Objective",
    );
    expect(objectiveClosed("cancelled") && objectiveClosed("completed")).toBe(true);
    expect(objectiveClosed("ready_for_review")).toBe(false);
  });
});

const definition = {
  id: "launch",
  outcome: "Launch the product",
};

describe("Objective budget denomination", () => {
  it("preserves currencyless budgets as internal allocation units", () => {
    expect(parseCreateObjective({ ...definition, budgetLimitMinor: 10_000 })).toMatchObject({
      budgetLimitMinor: 10_000,
      budgetCurrency: null,
    });
  });

  it("accepts an explicit uppercase three-letter currency code with a budget", () => {
    expect(
      parseCreateObjective({
        ...definition,
        budgetLimitMinor: 10_000,
        budgetCurrency: "USD",
      }),
    ).toMatchObject({ budgetLimitMinor: 10_000, budgetCurrency: "USD" });
  });

  it.each(["usd", "US", "USDD", "12A", " USD"])(
    "rejects unsupported budget currency shape %j",
    (budgetCurrency) => {
      expect(() =>
        parseCreateObjective({ ...definition, budgetLimitMinor: 10_000, budgetCurrency }),
      ).toThrow("budgetCurrency must be an uppercase three-letter currency code");
    },
  );

  it("rejects denomination without a budget", () => {
    expect(() => parseCreateObjective({ ...definition, budgetCurrency: "USD" })).toThrow(
      "budgetCurrency requires budgetLimitMinor",
    );
  });
});

describe("Objective limit updates", () => {
  it("accepts one bounded owner limit summary and keeps limited distinct from closure", () => {
    expect(
      parseObjectiveStatus({
        status: "limited",
        expectedRevision: 2,
        completionSummary:
          "Progress: tests pass. Open: review. Blocker: budget. Next: raise budget.",
      }),
    ).toMatchObject({
      status: "limited",
      completionSummary: "Progress: tests pass. Open: review. Blocker: budget. Next: raise budget.",
    });
    expect(objectiveClosed("limited")).toBe(false);
    expect(() => parseObjectiveStatus({ status: "limited", expectedRevision: 2 })).toThrow();
  });
  it("accepts a new deadline, normalized to ISO", () => {
    expect(parseObjectiveStatus({ deadline: "2031-02-03T04:05:06Z", expectedRevision: 2 })).toEqual(
      { deadline: "2031-02-03T04:05:06.000Z", expectedRevision: 2 },
    );
  });

  it.each([null, "tomorrow", 5])("rejects deadline %j", (deadline) => {
    expect(() => parseObjectiveStatus({ deadline, expectedRevision: 2 })).toThrow(
      "deadline must be an ISO timestamp",
    );
  });

  it("keeps limit behavior out of the public input", () => {
    expect(() =>
      parseObjectiveStatus({ deadlineBehavior: "notify", expectedRevision: 2 }),
    ).toThrow();
    expect(() =>
      parseCreateObjective({ ...definition, budget: { limitMinor: 100, currency: "USD" } }),
    ).toThrow();
  });
});

describe("Objective statement", () => {
  it("is one outcome statement without separate criteria or constraints", () => {
    expect(parseCreateObjective({ id: "sso", outcome: "Ship SSO" }).outcome).toBe("Ship SSO");
    expect(() =>
      parseCreateObjective({ id: "sso", outcome: "Ship SSO", successCriteria: ["Suite passes"] }),
    ).toThrow("Unknown field: successCriteria");
    expect(() =>
      parseCreateObjective({ id: "sso", outcome: "Ship SSO", constraints: ["API unchanged"] }),
    ).toThrow("Unknown field: constraints");
  });

  it("refuses an outcome longer than the limit", () => {
    expect(() => parseCreateObjective({ id: "sso", outcome: "x".repeat(8001) })).toThrow(
      "outcome must contain",
    );
  });
});
