import {
  MAX_TASK_FINDING_TEXT,
  MAX_TASK_FINDINGS,
  parseFixedTaskFindings,
  recordTaskFindings,
  type TaskFinding,
  type TaskFindingReference,
} from "@supertag/core";

/** Asks a harness to report review findings as lines that {@link findingsFromOutput} parses. */
export const FINDINGS_INSTRUCTION =
  'If you reviewed work, report each problem on its own line "Finding: <high|medium|low> | <one-sentence summary> | <file:line or reference>", leaving out the last part when there is no location; do not describe severity in prose instead. If you re-reviewed a fix for findings you reported on an earlier Task, confirm each one you verified fixed on its own line "Fixed finding: <Task id> | <finding id such as F1>".';

export interface OutputFindings {
  readonly findings: readonly TaskFinding[];
  /** Findings on earlier Tasks that `Fixed finding:` lines confirm fixed. */
  readonly fixedFindings: readonly TaskFindingReference[];
  /** Lines that start like a finding but do not follow the finding format. */
  readonly malformed: readonly string[];
}

const FINDING_LINE =
  /^\s*(?:[-*+]\s+)?(?:[*_]{1,2})?finding(?:[*_]{1,2})?\s*:(?:[*_]{1,2})?\s*(.*)$/iu;
/**
 * Any line that names a finding behind a Markdown prefix, such as `1. Finding:`, `> Finding:`,
 * `### Finding:`, or `- [ ] Finding:`. One that {@link FINDING_LINE} does not accept is malformed.
 */
const FINDING_LIKE = /^\s*(?:\d{1,9}[.)]\s*|\[[xX]\]\s*|[^\p{L}\p{N}\s]\s*)*finding[*_]{0,2}\s*:/iu;
/**
 * A CommonMark fence opener: three or more backticks or tildes, with an optional info string,
 * indented at most three spaces, optionally inside block quotes. A line indented four spaces or
 * a tab is an indented code line, not a fence.
 */
const FENCE_OPEN = /^ {0,3}(?:> ?(?: {0,3}))*(`{3,}|~{3,})(.*)$/u;
/** A CommonMark fence closer, indented like {@link FENCE_OPEN}, with nothing after the marker. */
const FENCE_CLOSE = /^ {0,3}(?:> ?(?: {0,3}))*(`{3,}|~{3,})[ \t]*$/u;
/**
 * A re-review's confirmation that a finding on another Task is fixed. It counts only at line start
 * (up to three spaces and an optional list marker), never behind emphasis or another prefix, and
 * never inside a fence, so quoted text cannot close a finding.
 */
const FIXED_FINDING_LINE = /^ {0,3}(?:[-*+] +)?fixed\s+finding\s*:\s*(.*)$/iu;
const SEVERITY = /^(high|medium|low)$/iu;

interface Fence {
  readonly char: string;
  readonly length: number;
}

/**
 * Review findings from a harness's final answer. Each `Finding:` line outside fenced code blocks
 * must have a severity, a summary, and at most one location, separated by `|`. A line that
 * starts like a finding but breaks this format, or puts another Markdown prefix such as `1.`,
 * `>`, or `###` before it, is returned as malformed instead of guessed at, so a misspelled
 * severity never disappears silently. Fences follow CommonMark: a fence opens or closes only on a
 * line indented at most three spaces, and closes only on a line of the same character at least
 * as long as its opener. A fence never hides a finding: block quotes and list items can end a
 * fence early in rendered Markdown, so every finding-like line inside a fence is returned as
 * malformed rather than dropped or parsed. A `Fixed finding: <task id> | <finding id>` line
 * outside fences names a finding on another Task that this re-review confirms fixed; a malformed
 * one is returned as malformed. Every finding starts open; the Control
 * Plane assigns its final id when it records the result.
 */
export function findingsFromOutput(text: string): OutputFindings {
  const reported: { severity: string; summary: string; location?: string }[] = [];
  const fixed: TaskFindingReference[] = [];
  const malformed: string[] = [];
  let fence: Fence | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      else if (FINDING_LIKE.test(line)) malformed.push(line.trim());
      continue;
    }
    const opener = FENCE_OPEN.exec(line);
    if (opener && !(opener[1]?.startsWith("`") && opener[2]?.includes("`"))) {
      const marker = opener[1] as string;
      fence = { char: marker[0] as string, length: marker.length };
      continue;
    }
    const fixedMatch = FIXED_FINDING_LINE.exec(line);
    if (fixedMatch) {
      const parts = (fixedMatch[1] ?? "").split("|").map((part) => part.replace(/`/gu, "").trim());
      const reference = { taskId: parts[0] ?? "", findingId: parts[1] ?? "" };
      try {
        if (parts.length !== 2) throw new Error("Expected a Task id and a finding id");
        parseFixedTaskFindings([reference]);
      } catch {
        malformed.push(line.trim());
        continue;
      }
      if (
        fixed.length >= MAX_TASK_FINDINGS ||
        fixed.some(
          (item) => item.taskId === reference.taskId && item.findingId === reference.findingId,
        )
      ) {
        if (fixed.length >= MAX_TASK_FINDINGS) malformed.push(line.trim());
        continue;
      }
      fixed.push(reference);
      continue;
    }
    const match = FINDING_LINE.exec(line);
    if (!match) {
      if (FINDING_LIKE.test(line)) malformed.push(line.trim());
      continue;
    }
    const parts = (match[1] ?? "").split("|").map((part) => part.replace(/`/gu, "").trim());
    const [severity, summary, location] = parts;
    if (
      parts.length < 2 ||
      parts.length > 3 ||
      !SEVERITY.test(severity ?? "") ||
      !summary ||
      (parts.length === 3 && !location)
    ) {
      malformed.push(line.trim());
      continue;
    }
    const finding = {
      severity: (severity as string).toLowerCase(),
      summary: truncateFindingText(summary as string),
      ...(location ? { location: truncateFindingText(location) } : {}),
    };
    try {
      recordTaskFindings([finding]);
    } catch {
      malformed.push(line.trim());
      continue;
    }
    if (reported.length >= MAX_TASK_FINDINGS) malformed.push(line.trim());
    else reported.push(finding);
  }
  return { findings: recordTaskFindings(reported), fixedFindings: fixed, malformed };
}

function truncateFindingText(value: string): string {
  return value.length > MAX_TASK_FINDING_TEXT
    ? `${value.slice(0, MAX_TASK_FINDING_TEXT - 1)}…`
    : value;
}

function closesFence(line: string, fence: Fence): boolean {
  const closer = FENCE_CLOSE.exec(line)?.[1];
  return closer !== undefined && closer[0] === fence.char && closer.length >= fence.length;
}
