import { PanelLeft, PanelLeftClose, Plus, Search, Star, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import type { Tag } from "../control-plane";
import { TagAvatar } from "./tag-avatar";
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

/**
 * What the Tag list shows about a Tag beyond its name. The cached Tag list fills these in; until
 * then a row shows just the name.
 */
export interface TagSummary {
  /** The first line of the last message in the Tag's conversation. */
  preview?: string;
  /** When the conversation last changed, in milliseconds since the epoch. */
  lastActivityMs?: number;
  /** Whether the conversation has messages this person has not seen. */
  unread?: boolean;
  /** Whether the Tag is working on a Task in this conversation. */
  working?: boolean;
}

/** The lead Tag first, then the others by last activity, newest first, keeping the given order. */
export function orderTags(tags: Tag[], summaries: Record<string, TagSummary> = {}) {
  const lead = tags.find((entry) => entry.lead);
  const others = tags
    .filter((entry) => entry !== lead)
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (summaries[b.entry.tagId]?.lastActivityMs ?? 0) -
          (summaries[a.entry.tagId]?.lastActivityMs ?? 0) || a.index - b.index,
    )
    .map(({ entry }) => entry);
  return { lead, others };
}

const tagName = (tag: Tag) => tag.name ?? tag.tagId;

export function Sidebar({
  mode,
  tags,
  tag,
  connected,
  summaries = {},
  selector,
  onSelectTag,
  onNewTag,
  newTagRefusal,
}: {
  mode: SidebarMode;
  tags: Tag[];
  tag?: Tag;
  connected: boolean;
  summaries?: Record<string, TagSummary>;
  selector: ReactNode;
  onSelectTag?(tagId: string): void;
  onNewTag?(): void;
  newTagRefusal?: string;
}) {
  const [search, setSearch] = useState<string>();
  const searchField = useRef<HTMLInputElement>(null);
  const expanded = mode === "expanded";
  const { lead, others } = orderTags(tags, summaries);
  const query = search?.trim().toLowerCase();
  const shown =
    expanded && query
      ? others.filter((entry) => `${tagName(entry)} ${entry.tagId}`.toLowerCase().includes(query))
      : others;
  useEffect(() => {
    if (search !== undefined) searchField.current?.focus();
  }, [search]);
  useEffect(() => {
    if (!expanded) setSearch(undefined);
  }, [expanded]);

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

  return (
    <nav id="sidebar" className="sidebar" data-mode={mode} aria-label="Tags">
      <div className="sidebar-top" data-tauri-drag-region>
        {expanded && (
          <div className="sidebar-top-actions">
            {tags.length > 1 && (
              <Button
                variant="ghost"
                className="sidebar-button"
                aria-label="Search Tags"
                title="Search Tags"
                aria-pressed={search !== undefined}
                onClick={() => setSearch(search === undefined ? "" : undefined)}
              >
                <Search size={16} aria-hidden />
              </Button>
            )}
            {newTag}
          </div>
        )}
      </div>
      <div className="sidebar-lead">
        {lead ? (
          <Button
            variant="ghost"
            className="lead-tag"
            aria-label={`${tagName(lead)}, lead Tag`}
            title={tagName(lead)}
            aria-current={tag?.tagId === lead.tagId}
            onClick={() => onSelectTag?.(lead.tagId)}
          >
            <span className="lead-avatar">
              <TagAvatar tagId={lead.tagId} large />
              <span className="lead-badge" aria-hidden>
                <Star size={10} fill="currentColor" strokeWidth={0} />
              </span>
            </span>
            {expanded && <span className="lead-name">{tagName(lead)}</span>}
          </Button>
        ) : (
          <img className="sidebar-mascot" src={mascot} alt="SuperTag" data-tauri-drag-region />
        )}
      </div>
      <div className="sidebar-divider" aria-hidden />
      {search !== undefined && (
        <div className="sidebar-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchField}
            type="text"
            aria-label="Search Tags"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch(undefined);
            }}
          />
          <Button
            variant="ghost"
            className="icon-button"
            aria-label="Close search"
            onClick={() => setSearch(undefined)}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      )}
      <div className="sidebar-tags">
        {tags.length === 0 && (
          <p className="visually-hidden">
            {connected ? "No Tags available" : "Connect to see your Tags"}
          </p>
        )}
        {query && shown.length === 0 && <p className="sidebar-empty">No matching Tags</p>}
        {shown.map((entry) => (
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
        {!expanded && newTag}
        {selector}
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
  const status = summary?.working ? "working" : summary?.unread ? "unread" : undefined;
  return (
    <Button
      variant="ghost"
      className="tag-row"
      aria-label={name}
      aria-description={
        summary?.working ? "Working" : summary?.unread ? "Unread messages" : undefined
      }
      title={expanded ? undefined : name}
      aria-current={current}
      data-status={status}
      onClick={onSelect}
    >
      <span className="tag-row-avatar">
        <TagAvatar tagId={tag.tagId} />
        {!expanded && status && <span className="tag-row-badge" aria-hidden />}
      </span>
      {expanded && (
        <span className="tag-row-text">
          <span className="tag-row-name">{name}</span>
          {summary?.working ? (
            <span className="tag-row-preview working-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          ) : (
            summary?.preview && <span className="tag-row-preview">{summary.preview}</span>
          )}
        </span>
      )}
      {expanded && summary?.lastActivityMs !== undefined && (
        <span className="tag-row-time">{relativeTime(summary.lastActivityMs)}</span>
      )}
      {expanded && summary?.unread && <span className="tag-row-unread" aria-hidden />}
    </Button>
  );
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

/** The sidebar toggle, in one place beside the macOS window controls in both modes. */
export function SidebarToggle({ mode }: { mode: SidebarMode }) {
  const mac = onMac();
  const label = `${mode === "expanded" ? "Collapse" : "Expand"} sidebar (${mac ? "⌘B" : "Ctrl+B"})`;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isSidebarShortcut(event, mac)) return;
      event.preventDefault();
      setSidebarMode(sidebarMode() === "expanded" ? "rail" : "expanded");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac]);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="sidebar-toggle"
      aria-label={label}
      title={label}
      aria-expanded={mode === "expanded"}
      aria-controls="sidebar"
      onClick={() => setSidebarMode(mode === "expanded" ? "rail" : "expanded")}
    >
      {mode === "expanded" ? (
        <PanelLeftClose size={17} aria-hidden />
      ) : (
        <PanelLeft size={17} aria-hidden />
      )}
    </Button>
  );
}
