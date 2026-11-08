import { describe, expect, it } from "vitest";
import {
  orderedTaskFindings,
  parseTaskFinding,
  parseTaskFindings,
  recordTaskFindings,
  storedTaskFindings,
  storedTaskFindingsBySeverity,
  taskFindingLine,
  taskFindingsBySeverity,
} from "./task-findings.js";

describe("Task findings", () => {
  it("records reported findings in order, with Control Plane ids", () => {
    expect(
      recordTaskFindings([
        { severity: "high", summary: "Token leaks into logs.", location: "src/log.ts:12" },
        // A Worker cannot choose the id.
        { id: "F9", severity: "low", summary: "Typo." },
      ]),
    ).toEqual([
      {
        id: "F1",
        severity: "high",
        summary: "Token leaks into logs.",
        location: "src/log.ts:12",
      },
      { id: "F2", severity: "low", summary: "Typo." },
    ]);
    expect(recordTaskFindings(undefined)).toEqual([]);
  });

  it("refuses a finding that names another Task or has an unknown field", () => {
    for (const extra of [{ taskId: "other-task" }, { status: "fixed" }, { objectiveId: "o" }])
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

  it("validates stored identifiers and their uniqueness", () => {
    const base = { id: "F1", severity: "medium", summary: "Slow query." } as const;
    expect(parseTaskFinding(base)).toEqual(base);
    expect(() => parseTaskFinding({ ...base, id: "finding-1" })).toThrow(/id/);
    expect(() => parseTaskFindings([base, base])).toThrow(/unique/);
  });

  it("groups findings by severity and reads stored results", () => {
    const findings = [
      { id: "F1", severity: "low", summary: "Nit." },
      { id: "F2", severity: "high", summary: "Bypass.", location: "a.ts:1" },
      { id: "F3", severity: "high", summary: "Race." },
    ] as const;
    const grouped = taskFindingsBySeverity(findings);
    expect(grouped.high.map((finding) => finding.id)).toEqual(["F2", "F3"]);
    expect(grouped.medium).toEqual([]);
    expect(grouped.low.map((finding) => finding.id)).toEqual(["F1"]);
    expect(orderedTaskFindings(findings).map((finding) => finding.id)).toEqual(["F2", "F3", "F1"]);
    expect(storedTaskFindings({ summary: "Done", findings })).toHaveLength(3);
    expect(storedTaskFindings({ summary: "Done", findings: [] })).toEqual([]);
    expect(storedTaskFindings({ findings: [findings[0], { bad: true }] })).toEqual([
      {
        id: "F1",
        severity: "high",
        summary: "Stored Task findings are invalid; inspect and repair the Task result.",
      },
    ]);
    // A result that is not an object at all cannot be read as "no findings".
    expect(storedTaskFindings("not a result")[0]?.severity).toBe("high");
    expect(storedTaskFindings({ summary: "Done" })).toEqual([]);
    expect(storedTaskFindings(null)).toEqual([]);
    expect(storedTaskFindings(undefined)).toEqual([]);
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
      storedTaskFindingsBySeverity({
        findings: [{ id: "F1", severity: "high", summary: "Bug.", "x\u001b[2J": 1 }],
      }),
    ).toEqual({
      unreadable:
        "Stored Task result findings are invalid: Task finding field x?[2J is not allowed",
    });
    expect(
      storedTaskFindingsBySeverity({
        findings: [{ id: "F1", severity: "high", summary: "Bug." }],
      }),
    ).toEqual({
      high: [{ id: "F1", severity: "high", summary: "Bug." }],
      medium: [],
      low: [],
    });
  });

  it("fails closed on stored findings that do not validate", () => {
    for (const findings of [
      "not a list",
      [{ id: "F1", severity: "critical", summary: "Bug." }],
      [{ id: "F1", severity: "high", summary: "Bug.", taskId: "other" }],
      [{ severity: "high", summary: "Missing id." }],
    ]) {
      expect(storedTaskFindings({ summary: "Done", findings })).toEqual([
        expect.objectContaining({ id: "F1", severity: "high" }),
      ]);
      expect(storedTaskFindingsBySeverity({ summary: "Done", findings })).toEqual({
        unreadable: expect.stringMatching(/^Stored Task result findings are invalid/),
      });
    }
  });
});
