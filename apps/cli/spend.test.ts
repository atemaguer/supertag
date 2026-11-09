import { create, toJson } from "@bufbuild/protobuf";
import type { SpendReport } from "@supertag/core";
import { SpendReportSchema } from "@supertag/operator-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeOperatorRpc } from "../../tests/support/fake-operator-rpc.js";
import { spendReportMessage } from "./src/organization-protos.js";
import { formatSpend, runSpendCommand } from "./src/spend.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
          },
        ],
      }),
    ).toContain(
      "cost $13.80; 1 unknown-cost Attempt(s): no cost reported in 1 | tokens 40; 1 unknown-token Attempt(s) | budget $1.00",
    );
    expect(
      formatSpend({
        by: "objective",
        since: null,
        groups: [
          {
            key: "empty",
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

  it("preserves the group usage in JSON output, field order included", async () => {
    const report: SpendReport = {
      by: "objective",
      since: null,
      groups: [
        {
          key: "build",
          attempts: 2,
          reportedCostByCurrency: { USD: 5 },
          unknownCostAttempts: 1,
          unpricedTokens: 30,
          reportedTokens: 40,
          unknownTokenAttempts: 0,
          budget: { limitMinor: 2500, currency: "USD" },
          estimatedCostAttempts: 1,
          unpricedModels: { "gpt-x": 1 },
        },
        {
          key: "unassigned",
          attempts: 1,
          reportedCostByCurrency: null,
          unknownCostAttempts: 1,
          unpricedTokens: 0,
          reportedTokens: null,
          unknownTokenAttempts: 1,
          budget: null,
        },
      ],
    };
    const rpc = fakeOperatorRpc({
      "OrganizationService/GetSpend": () =>
        toJson(SpendReportSchema, create(SpendReportSchema, spendReportMessage(report))),
    });
    const result = await runSpendCommand({ url: "http://localhost", token: "test" }, [
      "--output",
      "json",
    ]);
    expect(result).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(rpc.called("OrganizationService/GetSpend")[0]?.body).toEqual({
      by: "SPEND_GROUPING_OBJECTIVE",
    });
  });

  it("requests the filtered report and prints JSON", async () => {
    const rpc = fakeOperatorRpc({
      "OrganizationService/GetSpend": () => ({
        by: "SPEND_GROUPING_DAY",
        since: "2026-10-01T00:00:00Z",
      }),
    });
    const result = await runSpendCommand({ url: "http://localhost", token: "test" }, [
      "--by",
      "day",
      "--since",
      "2026-10-01T00:00:00Z",
      "--output",
      "json",
    ]);
    expect(rpc.called("OrganizationService/GetSpend")[0]?.body).toEqual({
      by: "SPEND_GROUPING_DAY",
      since: "2026-10-01T00:00:00Z",
    });
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
  });
});
