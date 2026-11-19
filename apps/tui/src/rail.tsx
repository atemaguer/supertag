/**
 * The Tag list, as a messaging app's thread list: the lead pinned on top (★), the others by
 * latest activity. Each row has the name (bold while unread), a short time, and a preview line:
 * `working…` while the Tag works, `N new` for unread replies. Folded, it shows initials with
 * `★` for the lead, `•` for unread and `…` for working.
 */
import type { Conversation, Tag, TagSummary } from "@supertag/client/model";
import { memo } from "react";
import { clip, initials, shortTime } from "./text";
import { color } from "./ui";

export interface RailRow {
  tag: Tag;
  summary: TagSummary;
  conversation?: Conversation;
}

export const Rail = memo(function Rail({
  rows,
  selected,
  focused,
  folded,
  width,
}: {
  rows: readonly RailRow[];
  selected: string | undefined;
  focused: boolean;
  folded: boolean;
  width: number;
}) {
  const inner = Math.max(4, width - 2);
  return (
    <box
      width={width}
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={focused ? color.focus : color.border}
      title={folded ? undefined : "Tags"}
    >
      {rows.length === 0 ? <text fg={color.muted}>{folded ? "—" : "No Tags yet"}</text> : null}
      {rows.map((row, index) =>
        folded ? (
          <FoldedRow key={row.tag.tagId} row={row} selected={row.tag.tagId === selected} />
        ) : (
          <Row
            key={row.tag.tagId}
            row={row}
            index={index}
            selected={row.tag.tagId === selected}
            width={inner}
          />
        ),
      )}
    </box>
  );
});

const nameOf = (tag: Tag) => tag.name ?? tag.tagId;

function FoldedRow({ row, selected }: { row: RailRow; selected: boolean }) {
  const mark = row.tag.lead ? "★" : row.summary.unread ? "•" : row.summary.working ? "…" : " ";
  return (
    <text fg={selected ? color.strong : color.muted} bg={selected ? color.selected : undefined}>
      {mark}
      {initials(nameOf(row.tag))}
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
  selected: boolean;
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
    <box flexDirection="column" backgroundColor={selected ? color.selected : undefined}>
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
