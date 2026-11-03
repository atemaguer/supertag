import type { TaskAssignmentStatus } from "./task-assignment.js";

/** One numbered item of an Objective statement, such as `3. Fix the inbox count.` */
export interface ObjectiveStatementItem {
  /** The item's number as written, such as "3". */
  readonly item: string;
  /** The item's first sentence, bounded for display. */
  readonly title: string;
}

/** Where a statement item stands, judged from the Tasks that serve it. */
export type ObjectiveItemState = "not started" | "in progress" | "in review" | "done";

export interface ObjectiveItemProgress {
  readonly item: string;
  /** Null when a Task names an item the statement does not list. */
  readonly title: string | null;
  readonly state: ObjectiveItemState;
  readonly tasks: readonly { readonly taskId: string; readonly status: TaskAssignmentStatus }[];
}

/** At most this many items per Task. */
export const MAX_TASK_ITEMS = 50;

const ITEM_LINE = /^ {0,3}(\d{1,3})[.)][ \t]+(\S.*)$/u;
const ITEM_LABEL = /^[1-9]\d{0,2}$/u;
const TITLE_LENGTH = 80;

/**
 * The numbered items of an Objective statement: lines that begin with `1.` or `1)` and at most
 * three spaces of indentation. The first occurrence of a number wins.
 */
export function parseObjectiveStatementItems(outcome: string): ObjectiveStatementItem[] {
  const items: ObjectiveStatementItem[] = [];
  const seen = new Set<string>();
  for (const line of outcome.split(/\r?\n|\r/u)) {
    const match = ITEM_LINE.exec(line);
    if (!match) continue;
    const item = String(Number(match[1]));
    if (item === "0" || seen.has(item)) continue;
    seen.add(item);
    items.push({ item, title: itemTitle(match[2] ?? "") });
  }
  return items;
}

function itemTitle(text: string): string {
  const trimmed = text.trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(trimmed)?.[1] ?? trimmed;
  return sentence.length > TITLE_LENGTH ? `${sentence.slice(0, TITLE_LENGTH - 1)}…` : sentence;
}

/**
 * Validates and normalizes the items a Task serves: unique item numbers, in numeric order.
 * Throws a message suitable for a 400 response.
 */
export function normalizeTaskItems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TASK_ITEMS)
    throw new Error(`items must be an array of at most ${MAX_TASK_ITEMS} statement item numbers`);
  for (const item of value)
    if (typeof item !== "string" || !ITEM_LABEL.test(item))
      throw new Error('items must be statement item numbers such as "1" or "3"');
  return [...new Set(value as string[])].sort((a, b) => Number(a) - Number(b));
}

const OPEN = new Set<TaskAssignmentStatus>(["queued", "running", "waiting"]);

/**
 * Each statement item with the Tasks that serve it and an overall state. Open work makes an item
 * in progress; otherwise a submitted result puts it in review, and an accepted one makes it done.
 * An item whose Tasks all failed, were rejected, or were cancelled is not started. Items that
 * Tasks name but the statement does not list come last, so a stale mapping stays visible.
 */
export function objectiveItemProgress(
  outcome: string,
  tasks: readonly {
    readonly taskId: string;
    readonly status: TaskAssignmentStatus;
    readonly items?: readonly string[];
  }[],
): ObjectiveItemProgress[] {
  const statement = parseObjectiveStatementItems(outcome);
  const listed = new Set(statement.map((entry) => entry.item));
  const extra = [
    ...new Set(tasks.flatMap((task) => task.items ?? []).filter((item) => !listed.has(item))),
  ].sort((a, b) => Number(a) - Number(b));
  return [
    ...statement.map((entry) => ({ item: entry.item, title: entry.title as string | null })),
    ...extra.map((item) => ({ item, title: null })),
  ].map(({ item, title }) => {
    const serving = tasks
      .filter((task) => task.items?.includes(item))
      .map((task) => ({ taskId: task.taskId, status: task.status }));
    return { item, title, state: itemState(serving), tasks: serving };
  });
}

function itemState(
  tasks: readonly { readonly status: TaskAssignmentStatus }[],
): ObjectiveItemState {
  if (tasks.some((task) => OPEN.has(task.status))) return "in progress";
  if (tasks.some((task) => task.status === "submitted")) return "in review";
  if (tasks.some((task) => task.status === "accepted")) return "done";
  return "not started";
}
