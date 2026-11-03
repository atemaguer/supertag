import { describe, expect, it } from "vitest";
import {
  closeTaskFinding,
  openTaskFindingsBySeverity,
  parseFixedTaskFindings,
  parseTaskFinding,
  parseTaskFindingClosure,
  parseTaskFindings,
  recordTaskFindings,
  storedOpenTaskFindings,
  storedTaskFindings,
  taskFindingLine,
} from "./task-findings.js";

describe("Task findings", () => {
  it("records reported findings in order as open, with Control Plane ids", () => {
    expect(
      recordTaskFindings([
        { severity: "high", summary: "Token leaks into logs.", location: "src/log.ts:12" },
        // A Worker cannot choose the id, close the finding, or give it a reason or closer.
        {
          id: "F9",
          severity: "low",
          summary: "Typo.",
          status: "fixed",
          reason: "Already done",
          fixedBy: "abc123",
          closedBy: { operatorId: "forged" },
          closedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        id: "F1",
        severity: "high",
        summary: "Token leaks into logs.",
        location: "src/log.ts:12",
        status: "open",
      },
      { id: "F2", severity: "low", summary: "Typo.", status: "open" },
    ]);
    expect(recordTaskFindings(undefined)).toEqual([]);
  });

  it("refuses a finding that names another Task or has an unknown field", () => {
    for (const extra of [{ taskId: "other-task" }, { closedByTaskId: "t" }, { objectiveId: "o" }])
      expect(() => recordTaskFindings([{ severity: "high", summary: "Bug.", ...extra }])).toThrow(
        /is not allowed/,
      );
  });

  it("validates severity, text, and count strictly", () => {
    for (const invalid of [
      { severity: "critical", summary: "Bug." },
      { severity: "High", summary: "Bug." },
      { severity: "high", summary: "" },
      { severity: "high", summary: "Line one.\nLine two." },
      { severity: "high", summary: "Escape \u001b[31mred\u001b[0m." },
      { severity: "high", summary: "x".repeat(501) },
      { severity: "high", summary: "Bug.", location: "" },
      { severity: "high", summary: 42 },
      "high: Bug.",
    ])
      expect(() => recordTaskFindings([invalid])).toThrow();
    expect(() => recordTaskFindings({ severity: "high", summary: "Bug." })).toThrow(/array/);
    expect(() =>
      recordTaskFindings(Array.from({ length: 51 }, () => ({ severity: "low", summary: "Nit." }))),
    ).toThrow(/at most 50/);
  });

  it("requires a reason exactly when a stored finding is accepted", () => {
    const base = { id: "F1", severity: "medium", summary: "Slow query." } as const;
    const closed = { closedBy: { tagId: "lead" }, closedAt: "2026-10-04T12:00:00.000Z" } as const;
    expect(
      parseTaskFinding({ ...base, status: "accepted", reason: "Bounded by paging", ...closed }),
    ).toEqual({
      ...base,
      status: "accepted",
      reason: "Bounded by paging",
      ...closed,
    });
    expect(() => parseTaskFinding({ ...base, status: "accepted", ...closed })).toThrow(
      /requires a reason/,
    );
    expect(() => parseTaskFinding({ ...base, status: "open", reason: "No" })).toThrow(
      /Only an accepted/,
    );
    expect(() => parseTaskFinding({ ...base, status: "closed" })).toThrow(/status/);
    expect(() => parseTaskFinding({ ...base, id: "finding-1", status: "open" })).toThrow(/id/);
    expect(() =>
      parseTaskFindings([
        { ...base, status: "open" },
        { ...base, status: "open" },
      ]),
    ).toThrow(/unique/);
  });

  it("groups open findings by severity and reads stored results", () => {
    const findings = [
      { id: "F1", severity: "low", summary: "Nit.", status: "open" },
      { id: "F2", severity: "high", summary: "Bypass.", location: "a.ts:1", status: "open" },
      {
        id: "F3",
        severity: "high",
        summary: "Fixed.",
        status: "fixed",
        fixedBy: "re-review",
        closedBy: { tagId: "reviewer", taskId: "re-review" },
        closedAt: "2026-10-04T12:00:00.000Z",
      },
      {
        id: "F4",
        severity: "medium",
        summary: "Kept.",
        status: "accepted",
        reason: "Known",
        closedBy: { operatorId: "operator" },
        closedAt: "2026-10-04T12:00:00.000Z",
      },
    ] as const;
    const grouped = openTaskFindingsBySeverity(findings);
    expect(grouped.high.map((finding) => finding.id)).toEqual(["F2"]);
    expect(grouped.medium).toEqual([]);
    expect(grouped.low.map((finding) => finding.id)).toEqual(["F1"]);
    expect(storedTaskFindings({ text: "Done", taskResult: { findings } })).toHaveLength(4);
    expect(storedTaskFindings({ summary: "Done", findings })).toEqual([]);
    expect(storedTaskFindings({ findings, taskResult: { findings: [] } })).toEqual([]);
    expect(storedTaskFindings({ taskResult: { findings: [findings[0], { bad: true }] } })).toEqual([
      {
        id: "F1",
        severity: "high",
        summary: "Stored Task findings are invalid; inspect and repair the Task result.",
        status: "open",
      },
    ]);
    expect(storedTaskFindings({ taskResult: null })[0]?.severity).toBe("high");
    expect(storedTaskFindings({ text: "Done" })).toEqual([]);
    expect(storedTaskFindings(null)).toEqual([]);
    expect(taskFindingLine(findings[1])).toBe("F2 [high] Bypass. (a.ts:1)");
  });

  it("refuses bidirectional, zero-width, and line separator characters in every text field", () => {
    const hidden = [
      ...["\u202a", "\u202b", "\u202c", "\u202d", "\u202e"],
      ...["\u2066", "\u2067", "\u2068", "\u2069"],
      ...["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\ufeff"],
      ...["\u2028", "\u2029"],
    ];
    for (const character of hidden) {
      const text = `Looks fine${character} but is not.`;
      for (const finding of [
        { severity: "high", summary: text },
        { severity: "high", summary: "Bug.", location: text },
      ])
        expect(() => recordTaskFindings([finding])).toThrow(/bidirectional, or invisible/);
      expect(() =>
        parseTaskFinding({
          id: "F1",
          severity: "low",
          summary: "Kept.",
          status: "accepted",
          reason: text,
        }),
      ).toThrow(/bidirectional, or invisible/);
    }
    // Ordinary non-ASCII text, including a narrow no-break space, stays allowed.
    expect(recordTaskFindings([{ severity: "low", summary: "Café\u202f€ naïve." }])).toHaveLength(
      1,
    );
  });

  it("refuses every control, format, separator, surrogate, variation selector, and tag character", () => {
    const hidden = [
      0x00,
      0x1b,
      0x7f,
      0x85,
      0x9b, // Cc
      0xad,
      0x61c,
      0x180e,
      0x200d,
      0x2060,
      0x2064,
      0x206a,
      0x206f,
      0xfeff,
      0xfff9, // Cf
      0x2065, // unassigned in the invisible-operator block
      0x2028,
      0x2029, // Zl, Zp
      0xfe00,
      0xfe0f,
      0x180b,
      0xe0100,
      0xe01ef, // variation selectors
      0xe0000,
      0xe0001,
      0xe0041,
      0xe007f, // tag block
      0x034f,
      0x115f,
      0x1160,
      0x17b4,
      0x17b5,
      0x3164,
      0xffa0, // default-ignorable
      0x0378, // unassigned
      0xe000,
      0xf8ff, // private use
    ].map((code) => String.fromCodePoint(code));
    for (const character of [...hidden, "\ud800", "\udfff"]) {
      for (const text of [
        `Looks fine${character} but is not.`,
        `${character}Leading.`,
        `Trailing.${character}`,
      ]) {
        expect(() => recordTaskFindings([{ severity: "high", summary: text }])).toThrow(
          /bidirectional, or invisible/,
        );
        expect(() =>
          recordTaskFindings([{ severity: "high", summary: "Bug.", location: text }]),
        ).toThrow(/bidirectional, or invisible/);
      }
    }
  });

  it("reads corrupt stored findings as unreadable for display", () => {
    expect(
      storedOpenTaskFindings({
        taskResult: {
          findings: [
            { id: "F1", severity: "high", summary: "Bug.", status: "open", "x\u001b[2J": 1 },
          ],
        },
      }),
    ).toEqual({
      unreadable:
        "Stored Task result findings are invalid: Task finding field x?[2J is not allowed",
    });
    expect(
      storedOpenTaskFindings({
        taskResult: { findings: [{ id: "F1", severity: "high", summary: "Bug.", status: "open" }] },
      }),
    ).toEqual({
      high: [{ id: "F1", severity: "high", summary: "Bug.", status: "open" }],
      medium: [],
      low: [],
    });
  });

  it("fails closed on stored findings that do not validate", () => {
    for (const findings of [
      "not a list",
      [{ id: "F1", severity: "critical", summary: "Bug.", status: "open" }],
      [{ id: "F1", severity: "high", summary: "Bug.", status: "open", taskId: "other" }],
      [{ severity: "high", summary: "Missing id and status." }],
    ]) {
      expect(storedTaskFindings({ text: "Done", taskResult: { findings } })).toEqual([
        expect.objectContaining({ id: "F1", severity: "high", status: "open" }),
      ]);
      expect(storedOpenTaskFindings({ text: "Done", taskResult: { findings } })).toEqual({
        unreadable: expect.stringMatching(/^Stored Task result findings are invalid/),
      });
      // Findings outside taskResult are never trusted.
      expect(storedTaskFindings({ summary: "Done", findings })).toEqual([]);
    }
  });

  it("requires fixedBy, closedBy, and closedAt exactly when a finding is closed", () => {
    const base = { id: "F1", severity: "low", summary: "Nit." } as const;
    const closedAt = "2026-10-04T12:00:00.000Z";
    expect(() =>
      parseTaskFinding({ ...base, status: "fixed", closedBy: { tagId: "lead" }, closedAt }),
    ).toThrow(/requires fixedBy/);
    expect(() =>
      parseTaskFinding({
        ...base,
        status: "open",
        closedBy: { tagId: "lead" },
        closedAt,
      }),
    ).toThrow(/open Task finding has no closedBy/);
    expect(() => parseTaskFinding({ ...base, status: "fixed", fixedBy: "abc123" })).toThrow(
      /requires closedBy and closedAt/,
    );
    expect(() => parseTaskFinding({ ...base, status: "open", fixedBy: "abc123" })).toThrow(
      /Only a fixed/,
    );
    for (const closedBy of [{}, { tagId: "a", operatorId: "b" }, { taskId: "t" }, "lead"])
      expect(() =>
        parseTaskFinding({ ...base, status: "fixed", fixedBy: "abc123", closedBy, closedAt }),
      ).toThrow(/closedBy/);
    expect(() =>
      parseTaskFinding({
        ...base,
        status: "fixed",
        fixedBy: "abc123",
        closedBy: { tagId: "lead" },
        closedAt: "yesterday",
      }),
    ).toThrow(/closedAt/);
  });

  it("closes one open finding and refuses missing or closed ones", () => {
    const findings = recordTaskFindings([
      { severity: "medium", summary: "Slow query." },
      { severity: "low", summary: "Nit." },
    ]);
    const at = "2026-10-04T12:00:00.000Z";
    const fixed = closeTaskFinding(
      findings,
      { id: "F1", status: "fixed", fixedBy: "abc123" },
      { tagId: "lead" },
      at,
    );
    expect(fixed[0]).toEqual({
      id: "F1",
      severity: "medium",
      summary: "Slow query.",
      status: "fixed",
      fixedBy: "abc123",
      closedBy: { tagId: "lead" },
      closedAt: at,
    });
    expect(fixed[1]).toEqual(findings[1]);
    expect(() =>
      closeTaskFinding(fixed, { id: "F1", status: "accepted", reason: "No" }, { tagId: "x" }, at),
    ).toThrow(/already closed/);
    expect(() =>
      closeTaskFinding(fixed, { id: "F7", status: "accepted", reason: "No" }, { tagId: "x" }, at),
    ).toThrow(/does not exist/);
  });

  it("parses requested closures and fixed-finding references strictly", () => {
    expect(parseTaskFindingClosure({ id: "F2", status: "fixed", fixedBy: "abc123" })).toEqual({
      id: "F2",
      status: "fixed",
      fixedBy: "abc123",
    });
    expect(parseTaskFindingClosure({ id: "F2", status: "accepted", reason: "Known" })).toEqual({
      id: "F2",
      status: "accepted",
      reason: "Known",
    });
    for (const invalid of [
      { id: "F2", status: "fixed" },
      { id: "F2", status: "accepted" },
      { id: "F2", status: "open" },
      { id: "F2", status: "fixed", fixedBy: "abc", reason: "x" },
      { id: "F2", status: "fixed", fixedBy: "abc", closedBy: { operatorId: "me" } },
      { id: "x", status: "accepted", reason: "Known" },
    ])
      expect(() => parseTaskFindingClosure(invalid)).toThrow();
    expect(parseFixedTaskFindings(undefined)).toEqual([]);
    expect(parseFixedTaskFindings([{ taskId: "review-a", findingId: "F1" }])).toEqual([
      { taskId: "review-a", findingId: "F1" },
    ]);
    for (const invalid of [
      [{ taskId: "review-a" }],
      [{ taskId: "review-a", findingId: "1" }],
      [{ taskId: "review-a", findingId: "F1", status: "fixed" }],
      [
        { taskId: "review-a", findingId: "F1" },
        { taskId: "review-a", findingId: "F1" },
      ],
      { taskId: "review-a", findingId: "F1" },
    ])
      expect(() => parseFixedTaskFindings(invalid)).toThrow();
  });
});
