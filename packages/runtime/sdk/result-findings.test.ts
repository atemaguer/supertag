import { expect, it } from "vitest";
import {
  defaultTaskResult,
  FINDINGS_INSTRUCTION,
  findingsFromOutput,
  terminalTaskResult,
} from "./src/index.js";

const review = [
  "Reviewed the export change.",
  "",
  "Finding: high | The export skips tenant scoping. | packages/export/src/query.ts:42",
  "- Finding: medium | Retries are unbounded.",
  "* finding: LOW | `README` misspells ledger. | docs/README.md:3",
  "```text",
  "Finding: high | Quoted example, not a finding. | x.ts:1",
  "```",
  "Change: Scope exports by tenant",
].join("\n");

it("parses Finding lines from a harness answer as findings", () => {
  expect(findingsFromOutput(review)).toEqual({
    findings: [
      {
        id: "F1",
        severity: "high",
        summary: "The export skips tenant scoping.",
        location: "packages/export/src/query.ts:42",
      },
      { id: "F2", severity: "medium", summary: "Retries are unbounded." },
      {
        id: "F3",
        severity: "low",
        summary: "README misspells ledger.",
        location: "docs/README.md:3",
      },
    ],
    malformed: ["Finding: high | Quoted example, not a finding. | x.ts:1"],
  });
});

it("reports malformed finding lines instead of guessing", () => {
  const output = [
    "Finding: critical | Unknown severity.",
    "Finding: high",
    "Finding: high | Summary. | a.ts:1 | extra",
    "Finding: high | Summary. |",
    `Finding: low | ${"x".repeat(501)}`,
    "Findings are below.",
    "No finding: here.",
  ].join("\n");
  const parsed = findingsFromOutput(output);
  expect(parsed.findings).toMatchObject([{ summary: `${"x".repeat(499)}…` }]);
  expect(parsed.malformed).toHaveLength(4);
  expect(defaultTaskResult(output)).toMatchObject({
    findings: parsed.findings,
    unresolved: parsed.malformed.map((line) => `Malformed finding line: ${line}`),
  });
});

it("follows CommonMark fences and reports the finding lines they quote", () => {
  const output = [
    "````markdown",
    "```text",
    "Finding: high | Quoted inside a quoted fence. | x.ts:1",
    "```",
    "Finding: high | Still quoted: the inner fence did not close the outer one. | x.ts:2",
    "````",
    "~~~",
    "```",
    "Finding: high | A backtick line does not close a tilde fence. | x.ts:3",
    "~~~~",
    "Finding: medium | Reported after the fences close. | y.ts:4",
  ].join("\n");
  expect(findingsFromOutput(output)).toEqual({
    findings: [
      {
        id: "F1",
        severity: "medium",
        summary: "Reported after the fences close.",
        location: "y.ts:4",
      },
    ],
    malformed: [
      "Finding: high | Quoted inside a quoted fence. | x.ts:1",
      "Finding: high | Still quoted: the inner fence did not close the outer one. | x.ts:2",
      "Finding: high | A backtick line does not close a tilde fence. | x.ts:3",
    ],
  });
});

it("reports finding lines after fences in block quotes and list items", () => {
  for (const output of [
    ["> ```", "Finding: high | Visible. | a.ts:1", "```"],
    ["- ```", "  code", "  ```", "Finding: high | Visible. | a.ts:1", "```"],
  ]) {
    const parsed = findingsFromOutput(output.join("\n"));
    expect(parsed.findings.length + parsed.malformed.length).toBe(1);
  }
});

it("reports finding lines inside a fence that never closes instead of dropping them", () => {
  const output = [
    "Finding: low | Before the fence.",
    "````",
    "Some code",
    "```",
    "Finding: high | Hidden by a mismatched fence. | a.ts:1",
    "- Finding: medium | Also hidden.",
  ].join("\n");
  const parsed = findingsFromOutput(output);
  expect(parsed.findings.map((finding) => finding.summary)).toEqual(["Before the fence."]);
  expect(parsed.malformed).toEqual([
    "Finding: high | Hidden by a mismatched fence. | a.ts:1",
    "- Finding: medium | Also hidden.",
  ]);
  expect(defaultTaskResult(output).unresolved).toEqual(
    parsed.malformed.map((line) => `Malformed finding line: ${line}`),
  );
});

it("reports finding lines behind other Markdown prefixes as malformed", () => {
  const prefixed = [
    "1. Finding: high | Numbered. | a.ts:1",
    "> Finding: high | Quoted. | a.ts:2",
    "### Finding: high | Heading. | a.ts:3",
    "- [ ] Finding: high | Task list. | a.ts:4",
    "- [x] **Finding:** high | Checked task list. | a.ts:5",
  ];
  const parsed = findingsFromOutput(
    [...prefixed, "- Finding: low | A plain bullet is a finding."].join("\n"),
  );
  expect(parsed.findings.map((finding) => finding.summary)).toEqual([
    "A plain bullet is a finding.",
  ]);
  expect(parsed.malformed).toEqual(prefixed);
});

it("parses long punctuation lines quickly", () => {
  const started = performance.now();
  findingsFromOutput(`${"[ ]".repeat(5000)}x\n${"- ".repeat(5000)}x\n${"1.".repeat(5000)}`);
  expect(performance.now() - started).toBeLessThan(1000);
});

it("keeps at most 50 findings and reports the rest", () => {
  const output = Array.from({ length: 52 }, (_, i) => `Finding: low | Nit ${i}.`).join("\n");
  const parsed = findingsFromOutput(output);
  expect(parsed.findings).toHaveLength(50);
  expect(parsed.malformed).toEqual(["Finding: low | Nit 50.", "Finding: low | Nit 51."]);
});

it("builds a terminal result whose findings come from the final answer", () => {
  const identity = { taskId: "task", attemptId: "attempt", at: "2026-10-04T00:00:00.000Z" };
  const result = terminalTaskResult([
    { ...identity, type: "output.message", message: { text: review } },
    { ...identity, type: "execution.completed" },
  ] as never);
  expect(result.summary).toBe(review);
  expect(result.findings.map((finding) => `${finding.id} ${finding.severity}`)).toEqual([
    "F1 high",
    "F2 medium",
    "F3 low",
  ]);
  expect(defaultTaskResult("Done.").findings).toEqual([]);
});

it("asks reviewers for one finding per line", () => {
  expect(FINDINGS_INSTRUCTION).toContain(
    '"Finding: <high|medium|low> | <one-sentence summary> | <file:line or reference>"',
  );
});

it("treats a fence-like line indented four or more spaces as code, not a fence", () => {
  const parsed = findingsFromOutput(
    [
      "    ```",
      "Finding: high | Not hidden by an indented fence-like line. | a.ts:1",
      "\t~~~",
      "Finding: medium | Not hidden by a tab-indented fence-like line. | a.ts:2",
      "   ```",
      "Finding: low | Quoted inside a fence indented three spaces.",
      "    ```",
      "Finding: low | Still quoted: an indented line does not close the fence.",
      "   ```",
      "Finding: low | Reported after the fence closes.",
    ].join("\n"),
  );
  expect(parsed.findings.map((finding) => finding.summary)).toEqual([
    "Not hidden by an indented fence-like line.",
    "Not hidden by a tab-indented fence-like line.",
    "Reported after the fence closes.",
  ]);
  expect(parsed.malformed).toEqual([
    "Finding: low | Quoted inside a fence indented three spaces.",
    "Finding: low | Still quoted: an indented line does not close the fence.",
  ]);
});
