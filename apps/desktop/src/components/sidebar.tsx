import { orderTags, type Tag, type TagSummary } from "@supertag/client/model";
import { Pin, Plus, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clamp, KEY_STEP, ResizeHandle, useStoredWidth } from "./resize";
import { Button } from "./ui/button";

/** The sidebar is expanded, with a row per Tag, or a rail of Tag avatars. */
export type SidebarMode = "expanded" | "rail";

const SIDEBAR_KEY = "supertag.desktop.sidebar";
const sidebarListeners = new Set<() => void>();

/** The saved sidebar mode: expanded unless the rail was chosen. */
export function sidebarMode(): SidebarMode {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "rail" ? "rail" : "expanded";
  } catch {
    return "expanded";
  }
}

/** Sets the sidebar mode in every shell, and remembers it across restarts. */
export function setSidebarMode(mode: SidebarMode) {
  try {
    localStorage.setItem(SIDEBAR_KEY, mode);
  } catch {
    // Without storage the choice lasts until the window closes.
  }
  for (const listener of sidebarListeners) listener();
}

function subscribeSidebar(listener: () => void) {
  sidebarListeners.add(listener);
  return () => {
    sidebarListeners.delete(listener);
  };
}

export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribeSidebar, sidebarMode, () => "expanded");
}

export const onMac = () =>
  typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");

/**
 * Whether a key press toggles the sidebar: ⌘B on macOS, Ctrl+B elsewhere. The composer is plain
 * text, so the shortcut has nothing to make bold there and applies everywhere in the window.
 */
export function isSidebarShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  mac: boolean,
) {
  if (event.key.toLowerCase() !== "b" || event.altKey || event.shiftKey || event.isComposing)
    return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether the platform's command key is held alone: ⌘ on macOS, Ctrl elsewhere. */
function commandKey(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  mac: boolean,
) {
  if (event.altKey || event.shiftKey || event.isComposing) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * What a Tag shortcut does: open the nth Tag, the previous or next one, New Tag, or the command
 * palette.
 */
export type TagShortcut =
  | { kind: "nth"; index: number }
  | { kind: "step"; by: 1 | -1 }
  | { kind: "new" }
  | { kind: "palette" };

/**
 * The messaging-app shortcuts: ⌘1…⌘9 open the nth Tag (the lead is ⌘1), ⌘↑ and ⌘↓ the previous and
 * next, ⌘N New Tag, and ⌘K the command palette; Ctrl in place of ⌘ outside macOS. ⌘↑ and ⌘↓ move
 * the cursor in a field with text, so they are left to it there.
 */
export function tagShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "target"
  >,
  mac: boolean,
): TagShortcut | undefined {
  if (!commandKey(event, mac)) return undefined;
  if (/^[1-9]$/.test(event.key)) return { kind: "nth", index: Number(event.key) - 1 };
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const target = event.target as { value?: unknown } | null;
    if (typeof target?.value === "string" && target.value) return undefined;
    return { kind: "step", by: event.key === "ArrowUp" ? -1 : 1 };
  }
  if (event.key.toLowerCase() === "n") return { kind: "new" };
  if (event.key.toLowerCase() === "k") return { kind: "palette" };
  return undefined;
}

const tagName = (tag: Tag) => tag.name ?? tag.tagId;

export function Sidebar({
  mode,
  tags,
  tag,
  connected,
  summaries = {},
  selector,
  footer,
  onSelectTag,
  onNewTag,
  newTagRefusal,
  onSearch,
}: {
  mode: SidebarMode;
  tags: Tag[];
  tag?: Tag;
  connected: boolean;
  summaries?: Record<string, TagSummary>;
  selector: ReactNode;
  footer?: ReactNode;
  onSelectTag?(tagId: string): void;
  onNewTag?(): void;
  newTagRefusal?: string;
  /** Opens the command palette, or closes it when it is open. */
  onSearch?(): void;
}) {
  const expanded = mode === "expanded";
  const { lead, others } = orderTags(tags, summaries);
  const ordered = [...(lead ? [lead] : []), ...others];
  const shortcuts = useRef({ ordered, tag, onSelectTag, onNewTag, onSearch });
  shortcuts.current = { ordered, tag, onSelectTag, onNewTag, onSearch };
  useEffect(() => {
    const mac = onMac();
    function onKey(event: KeyboardEvent) {
      const shortcut = tagShortcut(event, mac);
      if (!shortcut) return;
      const { ordered, tag, onSelectTag, onNewTag, onSearch } = shortcuts.current;
      if (shortcut.kind === "nth") {
        const target = ordered[shortcut.index];
        if (!target) return;
        onSelectTag?.(target.tagId);
      } else if (shortcut.kind === "step") {
        const at = ordered.findIndex((entry) => entry.tagId === tag?.tagId);
        const target = ordered[Math.min(Math.max(at + shortcut.by, 0), ordered.length - 1)];
        if (!target || target.tagId === tag?.tagId) return;
        onSelectTag?.(target.tagId);
      } else if (shortcut.kind === "new") {
        if (!onNewTag) return;
        onNewTag();
      } else {
        if (!onSearch) return;
        onSearch();
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const newTag = (onNewTag || newTagRefusal) && (
    <Button
      variant="ghost"
      className="sidebar-button"
      aria-label="New Tag"
      aria-description={newTagRefusal}
      aria-disabled={!onNewTag}
      title={newTagRefusal ?? "New Tag"}
      onClick={() => onNewTag?.()}
    >
      <Plus size={17} aria-hidden />
    </Button>
  );
  const search = onSearch && (
    <Button
      variant="ghost"
      className="sidebar-button"
      aria-label="Search"
      aria-keyshortcuts={onMac() ? "Meta+K" : "Control+K"}
      title="Search Tags, conversations, settings"
      onClick={onSearch}
    >
      <Search size={16} aria-hidden />
    </Button>
  );

  return (
    <nav id="sidebar" className="sidebar" data-mode={mode} aria-label="Tags">
      <div className="sidebar-top drag-region" />
      <div className="sidebar-gateway">{selector}</div>
      {expanded && (
        <div className="sidebar-heading">
          <h2>Tags</h2>
          <div className="sidebar-top-actions">
            {search}
            {newTag}
          </div>
        </div>
      )}
      <div className="sidebar-tags">
        {tags.length === 0 && (
          <p className={expanded ? "sidebar-empty" : "visually-hidden"}>
            {connected ? "No Tags available" : "Connect to see your Tags"}
          </p>
        )}
        {lead && (
          <TagRow
            key={lead.tagId}
            tag={lead}
            summary={summaries[lead.tagId]}
            expanded={expanded}
            current={tag?.tagId === lead.tagId}
            onSelect={() => onSelectTag?.(lead.tagId)}
          />
        )}
        {expanded && lead && others.length > 0 && (
          <h3 className="sidebar-conversations">Conversations</h3>
        )}
        {others.map((entry) => (
          <TagRow
            key={entry.tagId}
            tag={entry}
            summary={summaries[entry.tagId]}
            expanded={expanded}
            current={tag?.tagId === entry.tagId}
            onSelect={() => onSelectTag?.(entry.tagId)}
          />
        ))}
      </div>
      <div className="sidebar-bottom">
        {!expanded && search}
        {!expanded && newTag}
        {footer}
      </div>
    </nav>
  );
}

function TagRow({
  tag,
  summary,
  expanded,
  current,
  onSelect,
}: {
  tag: Tag;
  summary?: TagSummary;
  expanded: boolean;
  current: boolean;
  onSelect(): void;
}) {
  const name = tagName(tag);
  const status = tagStatus(summary);
  const state = stateWord(summary);
  const words = name
    .trim()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  const [first = tag.tagId, second] = words;
  const initials = (
    second ? [...first].slice(0, 1).concat([...second].slice(0, 1)) : [...first].slice(0, 2)
  )
    .join("")
    .toLocaleUpperCase();
  const label = [name, tag.lead && "lead Tag", state].filter(Boolean).join(", ");
  return (
    <Button
      variant="ghost"
      className="tag-row"
      // The state is part of the name, so it is announced with it: "moss, Working".
      aria-label={label}
      aria-description={summary?.unread ? "Unread messages" : undefined}
      title={tag.lead ? label : state ? `${name}: ${state}` : name}
      aria-current={current}
      data-lead={tag.lead || undefined}
      data-status={status}
      onClick={onSelect}
    >
      <span className="tag-row-avatar" aria-hidden>
        <span className="tag-monogram">{initials}</span>
        {!expanded && tag.lead && <Pin className="lead-badge" size={12} />}
        {!expanded && status && <span className="tag-row-badge" />}
      </span>
      {expanded && (
        <span className="tag-row-text">
          <span className="tag-row-title">
            <span className="tag-row-name">{name}</span>
            {tag.lead && <Pin className="lead-badge" size={13} aria-hidden />}
            {summary?.unread && <span className="tag-row-unread" aria-hidden />}
          </span>
          {(state || summary?.preview || summary?.lastActivityMs !== undefined) && (
            <span className="tag-row-detail">
              {state ? (
                <span className="tag-state" data-state={status} aria-hidden>
                  {state}
                </span>
              ) : (
                <span className="tag-row-preview">{summary?.preview}</span>
              )}
              {summary?.lastActivityMs !== undefined && (
                <span className="tag-row-time">{relativeTime(summary.lastActivityMs)}</span>
              )}
            </span>
          )}
        </span>
      )}
    </Button>
  );
}

/**
 * A row's state, from what the Gateway lists for its conversation: an unanswered question
 * first, because it waits on the person, then a queued or running Task, then unread replies.
 */
export function tagStatus(summary?: TagSummary): "asking" | "working" | "unread" | undefined {
  if (summary?.asking) return "asking";
  if (summary?.working) return "working";
  return summary?.unread ? "unread" : undefined;
}

/** The word below a Tag's name for its state, when the state has one. */
export function stateWord(summary?: TagSummary): string | undefined {
  const status = tagStatus(summary);
  return status === "asking" ? "Needs you" : status === "working" ? "Working" : undefined;
}

/** A short time for a list row: the time today, "Yesterday", the weekday this week, else a date. */
export function relativeTime(at: number, now = Date.now()): string {
  const then = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (at >= today.getTime())
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at >= today.getTime() - day) return "Yesterday";
  if (at >= today.getTime() - 6 * day)
    return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The expanded sidebar's width: its default, its range, and where a drag snaps to the rail. */
export const SIDEBAR_WIDTH = { rail: 84, min: 220, max: 360, snap: 150, initial: 256 };
const SIDEBAR_WIDTH_KEY = "supertag.desktop.sidebar-width";

/** ⌘B, or Ctrl+B outside macOS, folds the sidebar into the rail or expands it again. */
export function useSidebarShortcut() {
  useEffect(() => {
    const mac = onMac();
    function onKey(event: KeyboardEvent) {
      if (!isSidebarShortcut(event, mac)) return;
      event.preventDefault();
      setSidebarMode(sidebarMode() === "expanded" ? "rail" : "expanded");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * The sidebar's width as it is shown: the saved expanded width, the rail, or, while its separator
 * is dragged, the width under the pointer.
 */
export function useSidebarWidth() {
  const mode = useSidebarMode();
  const [width, setWidth] = useStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH.initial);
  const [live, setLive] = useState<number>();
  const expandedWidth = clamp(width, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
  const shownMode: SidebarMode =
    live === undefined ? mode : live < SIDEBAR_WIDTH.snap ? "rail" : "expanded";
  const shown =
    shownMode === "rail"
      ? SIDEBAR_WIDTH.rail
      : clamp(live ?? expandedWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
  return {
    mode: shownMode,
    width: shown,
    resizing: live !== undefined,
    separator: (
      <ResizeHandle
        label="Resize sidebar"
        className="sidebar-resize"
        value={shown}
        min={SIDEBAR_WIDTH.rail}
        max={SIDEBAR_WIDTH.max}
        grows={1}
        onResize={(raw, done) => {
          if (!done) {
            setLive(raw);
            return;
          }
          // On release it settles into the rail or an expanded width, never in between.
          setLive(undefined);
          if (raw < SIDEBAR_WIDTH.snap) setSidebarMode("rail");
          else {
            setWidth(clamp(raw, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max));
            setSidebarMode("expanded");
          }
        }}
        onStep={(direction) => {
          if (mode === "rail") {
            if (direction > 0) setSidebarMode("expanded");
            return;
          }
          const next = expandedWidth + direction * KEY_STEP;
          if (next < SIDEBAR_WIDTH.min) setSidebarMode("rail");
          else setWidth(clamp(next, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max));
        }}
        onDoubleClick={() => setSidebarMode(mode === "rail" ? "expanded" : "rail")}
        onEnter={() => setSidebarMode(mode === "rail" ? "expanded" : "rail")}
      />
    ),
  };
}
