/**
 * The rail, as a messaging app's thread list, in four sections: **Tags** (the lead pinned on top
 * with `★`, the others by latest activity; each with its name, bold while unread, a short time,
 * and a preview line: `working…` while the Tag works, `N new` for unread replies), **Objectives**
 * (the open ones, with spend against a budget or why one is held), **Waiting on you (N)** (`?` a
 * question, `!` an approval request) and **Teams** (with their member count). Only what fits
 * is mounted, and the list scrolls to keep the selected row in view. Folded, it shows the Tags'
 * initials with `★` for the lead, `•` for unread and `…` for working.
 */
import {
  type Conversation,
  type InboxItem,
  inboxLine,
  inboxMark,
  type Objective,
  objectiveDetail,
  type Tag,
  type TagSummary,
  type Team,
} from "@supertag/client/model";
import { memo, useRef } from "react";
import { clip, initials, shortTime } from "./text";
import { color } from "./ui";

export interface RailRow {
  tag: Tag;
  summary: TagSummary;
  conversation?: Conversation;
}

/** One selectable row of the rail, by a key such as `tag:lead` or `objective:ship-sso`. */
export type RailItem =
  | { key: string; kind: "tag"; row: RailRow; index: number }
  | { key: string; kind: "objective"; objective: Objective }
  | { key: string; kind: "inbox"; item: InboxItem }
  | { key: string; kind: "team"; team: Team };

export const railKey = {
  tag: (tagId: string) => `tag:${tagId}`,
  objective: (objectiveId: string) => `objective:${objectiveId}`,
  inbox: (key: string) => `inbox:${key}`,
  team: (teamId: string) => `team:${teamId}`,
};

/** The rail's rows in order: Tags, then open Objectives, the inbox, and Teams. */
export function railItems(
  rows: readonly RailRow[],
  objectives: readonly Objective[],
  inbox: readonly InboxItem[],
  teams: readonly Team[],
): RailItem[] {
  return [
    ...rows.map((row, index) => ({
      key: railKey.tag(row.tag.tagId),
      kind: "tag" as const,
      row,
      index,
    })),
    ...objectives.map((objective) => ({
      key: railKey.objective(objective.objectiveId),
      kind: "objective" as const,
      objective,
    })),
    ...inbox.map((item) => ({ key: railKey.inbox(item.key), kind: "inbox" as const, item })),
    ...teams.map((team) => ({ key: railKey.team(team.teamId), kind: "team" as const, team })),
  ];
}

type Line =
  | { kind: "header"; text: string }
  | { kind: "item"; item: RailItem; height: number }
  | { kind: "empty"; text: string };

function linesOf(items: readonly RailItem[], inboxCount: number): Line[] {
  const lines: Line[] = [];
  let section: RailItem["kind"] | undefined;
  for (const item of items) {
    if (item.kind !== section) {
      section = item.kind;
      if (item.kind === "objective") lines.push({ kind: "header", text: "Objectives" });
      else if (item.kind === "inbox")
        lines.push({ kind: "header", text: `Waiting on you (${inboxCount})` });
      else if (item.kind === "team") lines.push({ kind: "header", text: "Teams" });
    }
    lines.push({ kind: "item", item, height: item.kind === "tag" ? 2 : 1 });
  }
  if (!items.some((item) => item.kind === "tag")) lines.unshift({ kind: "empty", text: "" });
  return lines;
}

export const Rail = memo(function Rail({
  items,
  selected,
  focused,
  folded,
  width,
  height,
}: {
  items: readonly RailItem[];
  /** The selected row's key. */
  selected: string | undefined;
  focused: boolean;
  folded: boolean;
  width: number;
  /** The rail's height in lines, borders included. */
  height: number;
}) {
  const inner = Math.max(4, width - 2);
  // The selected row is brighter while the list has the keyboard.
  const highlight = focused ? color.selectedFocus : color.selected;
  const shown = folded ? items.filter((item) => item.kind === "tag") : items;
  const inboxCount = shown.filter((item) => item.kind === "inbox").length;
  const lines = folded
    ? shown.map((item) => ({ kind: "item" as const, item, height: 1 }))
    : linesOf(shown, inboxCount);
  // Keep the selected row in view: scroll only as far as it needs.
  const room = Math.max(1, height - 2);
  const top = useRef(0);
  let at = 0;
  let start = -1;
  let end = -1;
  for (const line of lines) {
    const size = line.kind === "item" ? line.height : 1;
    if (line.kind === "item" && line.item.key === selected) {
      start = at;
      end = at + size;
    }
    at += size;
  }
  const total = at;
  if (start >= 0) {
    // A section's header stays with its first row.
    const index = lines.findIndex((line) => line.kind === "item" && line.item.key === selected);
    const header = index > 0 && lines[index - 1]?.kind === "header" ? 1 : 0;
    if (start - header < top.current) top.current = Math.max(0, start - header);
    else if (end > top.current + room) top.current = end - room;
  }
  top.current = Math.max(0, Math.min(top.current, Math.max(0, total - room)));
  const visible: { line: Line; index: number }[] = [];
  at = 0;
  lines.forEach((line, index) => {
    const size = line.kind === "item" ? line.height : 1;
    if (at >= top.current && at + size <= top.current + room) visible.push({ line, index });
    at += size;
  });
  const above = top.current > 0;
  const below = top.current + room < total;
  return (
    <box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={focused ? color.focus : color.border}
      title={folded ? undefined : "Tags"}
      bottomTitle={
        below ? (folded ? "↓" : "↓ more") : above ? (folded ? "↑" : "↑ more") : undefined
      }
    >
      {visible.map(({ line, index }) => {
        if (line.kind === "empty")
          return (
            <text key="empty" fg={color.muted}>
              {folded ? "—" : "No Tags yet"}
            </text>
          );
        if (line.kind === "header")
          return (
            <text key={`h${index}`} fg={color.faint}>
              {clip(line.text, inner)}
            </text>
          );
        const item = line.item;
        const background = item.key === selected ? highlight : undefined;
        if (item.kind === "tag")
          return folded ? (
            <FoldedRow key={item.key} row={item.row} selected={background} />
          ) : (
            <Row
              key={item.key}
              row={item.row}
              index={item.index}
              selected={background}
              width={inner}
            />
          );
        return <OtherRow key={item.key} item={item} selected={background} width={inner} />;
      })}
    </box>
  );
});

const nameOf = (tag: Tag) => tag.name ?? tag.tagId;

function FoldedRow({ row, selected }: { row: RailRow; selected: string | undefined }) {
  const mark = row.tag.lead ? "★" : row.summary.unread ? "•" : row.summary.working ? "…" : " ";
  return (
    <text fg={selected ? color.strong : color.muted} bg={selected}>
      {mark}
      {initials(nameOf(row.tag))}
    </text>
  );
}

function OtherRow({
  item,
  selected,
  width,
}: {
  item: Exclude<RailItem, { kind: "tag" }>;
  /** The selected row's background; none when not selected. */
  selected: string | undefined;
  width: number;
}) {
  let mark = " ";
  let label: string;
  let detail = "";
  if (item.kind === "objective") {
    label = item.objective.outcome || item.objective.objectiveId;
    detail = objectiveDetail(item.objective);
  } else if (item.kind === "inbox") {
    mark = inboxMark(item.item);
    label = inboxLine(item.item);
  } else {
    label = item.team.name;
    detail = String(item.team.memberTagIds.length);
  }
  const room = Math.max(1, width - 3 - (detail ? detail.length + 1 : 0));
  const name = clip(label, room);
  const pad = " ".repeat(Math.max(1, width - 3 - [...name].length - detail.length));
  return (
    <text fg={selected ? color.strong : color.text} bg={selected}>
      <span fg={item.kind === "inbox" ? color.warning : color.faint}>{` ${mark} `}</span>
      {name}
      {pad}
      <span
        fg={
          item.kind === "objective" && detail && !detail.includes(" of ")
            ? color.warning
            : color.muted
        }
      >
        {detail}
      </span>
    </text>
  );
}

function Row({
  row,
  index,
  selected,
  width,
}: {
  row: RailRow;
  index: number;
  selected: string | undefined;
  width: number;
}) {
  const { tag, summary, conversation } = row;
  const time = summary.lastActivityMs ? shortTime(summary.lastActivityMs) : "";
  const key = index < 9 ? `${index + 1}` : " ";
  const mark = tag.lead ? "★" : summary.unread ? "•" : " ";
  const nameWidth = Math.max(1, width - 4 - time.length);
  const name = clip(nameOf(tag), nameWidth);
  const unread = conversation?.unreadCount ?? 0;
  const second = summary.working
    ? "working…"
    : unread > 0
      ? `${unread} new · ${summary.preview ?? ""}`
      : (summary.preview ?? "");
  const pad = " ".repeat(Math.max(1, width - 3 - [...name].length - time.length));
  return (
    <box flexDirection="column" backgroundColor={selected}>
      <text fg={selected ? color.strong : color.text}>
        <span fg={color.faint}>{key}</span>
        {mark}
        {summary.unread ? <strong>{name}</strong> : name}
        {pad}
        <span fg={color.muted}>{time}</span>
      </text>
      <text fg={summary.working ? color.accent : color.muted}>
        {"  "}
        {summary.unread && !summary.working ? (
          <strong>{clip(second, width - 2)}</strong>
        ) : (
          clip(second, width - 2)
        )}
      </text>
    </box>
  );
}
