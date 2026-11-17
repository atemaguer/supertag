import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import type { ControlPlane, Conversation, Tag, WatchUpdate } from "../control-plane";
import {
  cachedRoster,
  cacheRoster,
  storedRoster,
  useConversationList,
  useConversationPrefetch,
} from "../lib/conversation-cache";
import { nativeNotifier, silentNotifier, useDesktopNotifications } from "../lib/notifications";
import { describe } from "../lib/polling";
import { useControlPlaneWatch, useWatchRefresh, type WatchFeed } from "../lib/watch";
import { harnessLabel, type TagAdmin } from "../tag-admin";
import { ConversationPane, type Draft } from "./conversation";
import { NewTagDialog } from "./new-tag";
import {
  Sidebar,
  type SidebarMode,
  type TagSummary,
  useSidebarShortcut,
  useSidebarWidth,
} from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import { Button } from "./ui/button";

const rosterInterval = 15_000;

export type SettingsAction = (event: MouseEvent<HTMLButtonElement>) => void;
interface ShellProps {
  tags: Tag[];
  tag?: Tag;
  connected: boolean;
  switching?: boolean;
  /** What the sidebar shows about each Tag beyond its name, by Tag ID. */
  summaries?: Record<string, TagSummary>;
  /** The Control Plane button, round in the rail and wide in the expanded sidebar. */
  selector(mode: SidebarMode): ReactNode;
  error?: string;
  onSelectTag?(tagId: string): void;
  /** Opens the New Tag dialog, when this connection may create Tags. */
  onNewTag?(): void;
  /** Why this connection cannot create Tags. */
  newTagRefusal?: string;
  children?: ReactNode;
}

/**
 * The window: the sidebar of Tags on the left, expanded or as a rail, and the conversation with
 * the selected Tag reaching the top of the window, with the Tag in a floating pill over it. A
 * person has one conversation with each Tag here, so selecting a Tag opens it.
 */
export function WorkspaceShell({
  tags,
  tag,
  connected,
  switching,
  summaries,
  selector,
  error,
  onSelectTag,
  onNewTag,
  newTagRefusal,
  children,
}: ShellProps) {
  useSidebarShortcut();
  const { mode, width, resizing, separator } = useSidebarWidth();
  const provider = tag && harnessLabel(tag.harnessKind);
  return (
    <div
      className="shell"
      data-sidebar={mode}
      data-resizing={resizing || undefined}
      style={{ "--sidebar-current": `${width}px` } as CSSProperties}
    >
      <Sidebar
        mode={mode}
        tags={tags}
        tag={tag}
        connected={connected}
        summaries={summaries}
        selector={selector(mode)}
        onSelectTag={onSelectTag}
        onNewTag={onNewTag}
        newTagRefusal={newTagRefusal}
      />
      {separator}
      <main className="main" aria-label="Conversation" aria-busy={switching}>
        <header className="topstrip" data-tauri-drag-region>
          {tag && (
            <div className="identity-pill">
              <TagAvatar tagId={tag.tagId} />
              <span className="tag-name">{tag.name ?? tag.tagId}</span>
            </div>
          )}
          {provider && <span className="harness">{provider}</span>}
        </header>
        {error && (
          <div className="sync-error" role="status">
            {error}
          </div>
        )}
        <div className="workspace-body" inert={switching}>
          {children}
        </div>
      </main>
    </div>
  );
}

export function EmptyWorkspace({
  connected,
  onNewTag,
  switching,
  onSettings,
  localProblem,
  onLocal,
}: {
  connected?: boolean;
  /** Opens the New Tag dialog, when this connection may create Tags. */
  onNewTag?(): void;
  switching?: boolean;
  onSettings?: SettingsAction;
  /** Why the local Control Plane is unavailable, such as the command that starts it. */
  localProblem?: string;
  /** Connects to the local Control Plane while it runs. */
  onLocal?(): void;
}) {
  return (
    <div className="work-area">
      <div className="empty">
        {switching ? (
          <p role="status">Connecting to Control Plane…</p>
        ) : connected ? (
          <>
            <h2>No Tags available</h2>
            {onNewTag ? (
              <>
                <p>Create a Tag to start a conversation.</p>
                <Button className="primary" onClick={onNewTag}>
                  New Tag
                </Button>
              </>
            ) : (
              <p>Ask an operator to create a Tag for you.</p>
            )}
          </>
        ) : (
          <>
            <img src={mascot} alt="" className="empty-mascot" />
            <h2>Your Tags, in one place</h2>
            <p>Connect to a SuperTag Control Plane to work with your persistent coding agents.</p>
            {localProblem && <p>{localProblem}</p>}
            {onLocal && (
              <Button className="primary" onClick={onLocal}>
                Connect to Local
              </Button>
            )}
            <Button
              variant={onLocal ? "outline" : "default"}
              className={onLocal ? "secondary" : "primary"}
              onClick={onSettings}
            >
              Add Control Plane
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface WorkspaceProps {
  connectionId?: string;
  controlPlane: ControlPlane;
  initialTags: Tag[];
  selector(mode: SidebarMode): ReactNode;
  /** Which Control Plane the drafts are kept for across restarts. */
  draftScope: string;
  /** Creates Tags, when this connection may. */
  tagAdmin?: TagAdmin;
  /** Why this connection cannot create Tags. */
  newTagRefusal?: string;
  switching: boolean;
  connectionError: string;
  onWriteChange(delta: 1 | -1): void;
}

export function Workspace({
  connectionId,
  controlPlane,
  initialTags,
  selector,
  draftScope,
  tagAdmin,
  newTagRefusal,
  switching,
  connectionError,
  onWriteChange,
}: WorkspaceProps) {
  const [tags, setTags] = useState(initialTags);
  const [creatingTag, setCreatingTag] = useState(false);
  // The app opens on the Tag it showed last on this Control Plane.
  const [selectedTag, setSelectedTag] = useState(
    () => cachedRoster(controlPlane)?.selectedTag ?? initialTags[0]?.tagId,
  );
  const chosen = useRef(false);
  useEffect(() => {
    void storedRoster(controlPlane).then((roster) => {
      if (roster?.selectedTag && !chosen.current) setSelectedTag(roster.selectedTag);
    });
  }, [controlPlane]);
  const selectTag = useCallback(
    (tagId: string) => {
      chosen.current = true;
      setSelectedTag(tagId);
      cacheRoster(controlPlane, { selectedTag: tagId });
    },
    [controlPlane],
  );
  const [drafts, updateDraft] = useDrafts(draftScope);
  // What the open conversation's own history says of it, the freshest for its row.
  const [summaries, setSummaries] = useState<Record<string, TagSummary>>({});
  const reportSummary = useCallback(
    (tagId: string, summary: TagSummary) =>
      setSummaries((prior) => ({ ...prior, [tagId]: summary })),
    [],
  );
  const [error, setError] = useState("");
  const watch = useControlPlaneWatch(connectionId);
  // Every conversation's row, from the cached list at once and then the Control Plane, kept
  // current through the watch.
  const { conversations, fresh } = useConversationList(controlPlane, watch);
  const tag = tags.find((entry) => entry.tagId === selectedTag) ?? tags[0];
  const tagName = useCallback(
    (tagId: string) => {
      const named = tags.find((entry) => entry.tagId === tagId);
      return named?.name ?? named?.tagId ?? tagId;
    },
    [tags],
  );
  // A reply or question in a conversation not in view notifies; clicking it opens the Tag.
  useDesktopNotifications({
    conversations,
    fresh,
    openTagId: tag?.tagId,
    name: tagName,
    onOpen: selectTag,
    notifier: connectionId ? nativeNotifier : silentNotifier,
  });
  useConversationPrefetch(
    controlPlane,
    tags.map(({ tagId }) => tagId),
    tag?.tagId,
    watch,
  );

  const refreshTags = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await controlPlane.tags();
        if (!signal.aborted) {
          setTags(result);
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [controlPlane],
  );
  useWatchRefresh(refreshTags, rosterInterval, watch, rosterChanged);

  const shell = {
    tags,
    selector,
    switching,
    connected: true,
    onSelectTag: selectTag,
    summaries: Object.fromEntries(
      conversations.map((conversation) => [
        conversation.tagId,
        {
          ...rowSummary(conversation),
          ...(conversation.tagId === tag?.tagId ? summaries[conversation.tagId] : {}),
          // The open conversation is read as it is shown.
          unread: conversation.tagId !== tag?.tagId && conversation.unreadCount > 0,
        },
      ]),
    ),
    onNewTag: tagAdmin ? () => setCreatingTag(true) : undefined,
    newTagRefusal,
    error: connectionError || error,
  };
  const workspace = tag ? (
    <TagWorkspace
      key={tag.tagId}
      controlPlane={controlPlane}
      watch={watch}
      tag={tag}
      shell={shell}
      draft={drafts[tag.tagId] ?? { text: "" }}
      updateDraft={(update) => updateDraft(tag.tagId, update)}
      onSummary={reportSummary}
      onWriteChange={onWriteChange}
    />
  ) : (
    <WorkspaceShell {...shell}>
      <EmptyWorkspace connected onNewTag={shell.onNewTag} />
    </WorkspaceShell>
  );
  return (
    <>
      {workspace}
      {tagAdmin && (
        <NewTagDialog
          admin={tagAdmin}
          open={creatingTag}
          onOpenChange={setCreatingTag}
          onCreated={(created) => {
            setTags((prior) =>
              prior.some((entry) => entry.tagId === created.tagId) ? prior : [...prior, created],
            );
            selectTag(created.tagId);
          }}
        />
      )}
    </>
  );
}

const DRAFTS_KEY = "supertag.desktop.drafts.";

/**
 * What the operator is writing to each Tag, kept across Tag switches. Unsent text is also kept
 * across restarts, per Control Plane; a message on its way is not.
 */
function useDrafts(scope: string) {
  const key = DRAFTS_KEY + scope;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(saved)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([tagId, text]) => [tagId, { text }]),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    const texts = Object.fromEntries(
      Object.entries(drafts)
        .filter(([, draft]) => draft.text.trim())
        .map(([tagId, draft]) => [tagId, draft.text]),
    );
    try {
      if (Object.keys(texts).length) localStorage.setItem(key, JSON.stringify(texts));
      else localStorage.removeItem(key);
    } catch {
      // Without storage, drafts last until the window closes.
    }
  }, [key, drafts]);
  const update = useCallback(
    (tagId: string, change: (draft: Draft) => Draft) =>
      setDrafts((prior) => ({ ...prior, [tagId]: change(prior[tagId] ?? { text: "" }) })),
    [],
  );
  return [drafts, update] as const;
}

const rosterChanged = (update: WatchUpdate) => update.kind === "tag";

/** What the sidebar shows for a conversation the Control Plane lists. */
export function rowSummary(conversation: Conversation): TagSummary {
  const line = conversation.preview.split("\n")[0]?.trim();
  return {
    ...(line ? { preview: conversation.previewFromTag ? line : `You: ${line}` } : {}),
    ...(conversation.lastActivityAtMs ? { lastActivityMs: conversation.lastActivityAtMs } : {}),
    ...(conversation.unreadCount > 0 ? { unread: true } : {}),
    ...(conversation.working ? { working: true } : {}),
  };
}

function TagWorkspace({
  controlPlane,
  watch,
  tag,
  shell,
  draft,
  updateDraft,
  onSummary,
  onWriteChange,
}: {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
  shell: Omit<ShellProps, "children">;
  draft: Draft;
  updateDraft(update: (draft: Draft) => Draft): void;
  onSummary(tagId: string, summary: TagSummary): void;
  onWriteChange(delta: 1 | -1): void;
}) {
  const tagId = tag.tagId;
  return (
    <WorkspaceShell {...shell} tag={tag}>
      <ConversationPane
        key={tagId}
        controlPlane={controlPlane}
        watch={watch}
        tag={tag}
        draft={draft}
        updateDraft={updateDraft}
        onSummary={(summary) => onSummary(tagId, summary)}
        onWriteChange={onWriteChange}
      />
    </WorkspaceShell>
  );
}
