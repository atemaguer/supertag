import { describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { formatSpend, runSpendCommand } from "./src/spend.js";

describe("spend output", () => {
  it("renders reported sums, unknown usage, and Objective budgets", () => {
    expect(
      formatSpend({
        by: "objective",
        since: null,
        groups: [
          {
            key: "build",
            attempts: 2,
            reportedCostByCurrency: { USD: 1380 },
            unknownCostAttempts: 1,
            reportedTokens: 40,
            unknownTokenAttempts: 1,
            budget: { limitMinor: 100, currency: "USD" },
            postTriggered: {
              attempts: 1,
              reportedCostByCurrency: { USD: 380 },
              unknownCostAttempts: 0,
              reportedTokens: 10,
              unknownTokenAttempts: 0,
            },
          },
        ],
      }),
    ).toContain(
      "cost $13.80; 1 unknown-cost Attempt(s): no cost reported in 1 | tokens 40; 1 unknown-token Attempt(s) | budget $1.00\n  Post-triggered activations (included in total) | 1 Attempt(s) | cost $3.80 | tokens 10",
    );
    expect(
      formatSpend({
        by: "objective",
        since: null,
        groups: [
          {
            key: "empty",
            postTriggered: {
              attempts: 0,
              reportedCostByCurrency: null,
              unknownCostAttempts: 0,
              reportedTokens: null,
              unknownTokenAttempts: 0,
            },
            attempts: 1,
            reportedCostByCurrency: null,
            unknownCostAttempts: 1,
            reportedTokens: null,
            unknownTokenAttempts: 1,
            budget: null,
          },
        ],
      }),
    ).toContain("cost unknown; 1 unknown-cost Attempt(s): no cost reported in 1 | tokens unknown");
    expect(
      formatSpend({
        by: "tag",
        since: null,
        groups: [
          {
            key: "tag-1",
            postTriggered: {
              attempts: 0,
              reportedCostByCurrency: null,
              unknownCostAttempts: 0,
              reportedTokens: null,
              unknownTokenAttempts: 0,
            },
            name: "builder",
            attempts: 3,
            reportedCostByCurrency: null,
            unknownCostAttempts: 3,
            unpricedModels: { "gpt-x": 2 },
            reportedTokens: 90,
            unknownTokenAttempts: 1,
          },
        ],
      }),
    ).toBe(
      "builder | 3 Attempt(s) | cost unpriced; 3 unknown-cost Attempt(s): unpriced: no published price for gpt-x in 2; tokens recorded; no cost reported in 1 (prices: Codex Harness price table, shipped with supertag-ai; upgrade supertag-ai for new prices) | tokens 90; 1 unknown-token Attempt(s)\n",
    );
  });

  it("preserves the reply subtotal in JSON output", async () => {
    const subtotal = {
      attempts: 1,
      reportedCostByCurrency: { USD: 5 },
      unknownCostAttempts: 0,
      reportedTokens: 10,
      unknownTokenAttempts: 0,
    };
    const report = {
      by: "objective",
      since: null,
      groups: [{ ...subtotal, key: "build", postTriggered: subtotal }],
    };
    const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue(report);
    try {
      const result = await runSpendCommand({ url: "http://localhost", token: "test" }, [
        "--output",
        "json",
      ]);
      expect(JSON.parse(result)).toEqual(report);
    } finally {
      request.mockRestore();
    }
  });

  it("requests the filtered API view and prints JSON", async () => {
    const request = vi
      .spyOn(ControlPlaneClient.prototype, "request")
      .mockResolvedValue({ by: "day", since: "2026-10-01T00:00:00.000Z", groups: [] });
    try {
      const result = await runSpendCommand({ url: "http://localhost", token: "test" }, [
        "--by",
        "day",
        "--since",
        "2026-10-01T00:00:00Z",
        "--output",
        "json",
      ]);
      expect(request).toHaveBeenCalledWith(
        "/api/v1/spend?by=day&since=2026-10-01T00%3A00%3A00.000Z",
      );
      expect(JSON.parse(result)).toEqual({
        by: "day",
        since: "2026-10-01T00:00:00.000Z",
        groups: [],
      });
      await expect(
        runSpendCommand({ url: "http://localhost", token: "test" }, ["--since", "invalid"]),
      ).rejects.toThrow("ISO timestamp");
      await expect(
        runSpendCommand({ url: "http://localhost", token: "test" }, [
          "--since",
          "2026-02-30T00:00:00Z",
        ]),
      ).rejects.toThrow("ISO timestamp");
    } finally {
      request.mockRestore();
    }
  });
});
