import type { Gateway, Tag, WatchUpdate } from "@supertag/client/model";
import {
  describe,
  harnessLabel,
  orderTags,
  rowSummary,
  type TagAdmin,
  type TagSummary,
} from "@supertag/client/model";
import {
  cachedMessageTexts,
  cachedRoster,
  cacheRoster,
  storedRoster,
  useConversationList,
  useConversationPrefetch,
  useGatewayWatch,
  useWatchRefresh,
  type WatchFeed,
} from "@supertag/client/react";
import { Keyboard, NotebookText, Plus } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import { nativeGateway } from "../gateway";
import { nativeNotifier, silentNotifier, useDesktopNotifications } from "../lib/notifications";
import {
  CommandPalette,
  commandKeyLabel,
  KeyboardShortcutsDialog,
  type PaletteAction,
} from "./command-palette";
import { ConversationPane, type Draft } from "./conversation";
import { NewTagDialog } from "./new-tag";
import { Sidebar, type SidebarMode, useSidebarShortcut, useSidebarWidth } from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import type { InspectorTab } from "./tag-details";
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
  /** The Gateway button, round in the rail and wide in the expanded sidebar. */
  selector(mode: SidebarMode): ReactNode;
  error?: string;
  onSelectTag?(tagId: string): void;
  /** Opens the New Tag dialog, when this connection may create Tags. */
  onNewTag?(): void;
  /** Why this connection cannot create Tags. */
  newTagRefusal?: string;
  /** The Gateway and connection settings the command palette offers. */
  actions?: readonly PaletteAction[];
  /** The text of each cached message of a Tag's conversation, newest first, for search. */
  messageTexts?(tagId: string): readonly string[];
  /** Shows the Tag details panel, or hides it, from the Tag's name at the top; `open` sets it. */
  onTagDetails?(open?: boolean, tab?: InspectorTab): void;
  detailsOpen?: boolean;
  memoryAvailable?: boolean;
  /** A split conversation places the title strip inside its transcript column. */
  children?: ReactNode | ((header: ReactNode) => ReactNode);
}

const noSummaries: Record<string, TagSummary> = {};
const noActions: readonly PaletteAction[] = [];

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
  actions = noActions,
  messageTexts,
  onTagDetails,
  detailsOpen,
  memoryAvailable = true,
  children,
}: ShellProps) {
  useSidebarShortcut();
  const { mode, width, resizing, separator } = useSidebarWidth();
  const provider = tag && harnessLabel(tag.harnessKind);
  const [searching, setSearching] = useState(false);
  const [listingShortcuts, setListingShortcuts] = useState(false);
  const shownSummaries = summaries ?? noSummaries;
  const { lead, others } = orderTags(tags, shownSummaries);
  const ordered = [...(lead ? [lead] : []), ...others];
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      ...(onNewTag || newTagRefusal
        ? [
            {
              id: "new-tag",
              label: "New Tag",
              caption: newTagRefusal ?? "a name, a harness and a Workspace",
              icon: <Plus aria-hidden />,
              shortcut: commandKeyLabel("N"),
              keywords: "create",
              disabled: !onNewTag,
              run: () => onNewTag?.(),
            },
          ]
        : []),
      {
        id: "keyboard-shortcuts",
        label: "Keyboard shortcuts",
        caption: "every key the app answers to",
        icon: <Keyboard aria-hidden />,
        keywords: "keys help",
        run: () => setListingShortcuts(true),
      },
      ...(tag && memoryAvailable && onTagDetails
        ? [
            {
              id: "tag-details",
              label: "Memory",
              caption: `what ${tag.name ?? tag.tagId} remembers · delete a memory`,
              icon: <NotebookText aria-hidden />,
              keywords: "memory remember forget tag details",
              run: () => onTagDetails(true, "memory"),
            },
          ]
        : []),
      ...actions,
    ],
    [onNewTag, newTagRefusal, actions, tag, onTagDetails, memoryAvailable],
  );
  const header = (
    <header className="topstrip drag-region">
      {tag &&
        (onTagDetails ? (
          <button
            type="button"
            className="identity-pill"
            aria-expanded={Boolean(detailsOpen)}
            aria-controls="tag-details"
            title={detailsOpen ? "Hide Tag details" : "Show Tag details and memory"}
            onClick={() => onTagDetails()}
          >
            <TagAvatar tagId={tag.tagId} />
            <span className="tag-name">{tag.name ?? tag.tagId}</span>
          </button>
        ) : (
          <div className="identity-pill">
            <TagAvatar tagId={tag.tagId} />
            <span className="tag-name">{tag.name ?? tag.tagId}</span>
          </div>
        ))}
      {provider && <span className="harness">{provider}</span>}
    </header>
  );
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
        onSearch={() => setSearching((open) => !open)}
      />
      {separator}
      <main className="main" aria-label="Conversation" aria-busy={switching}>
        {typeof children !== "function" && header}
        {error && (
          <div className="sync-error" role="status">
            {error}
          </div>
        )}
        <div className="workspace-body" inert={switching}>
          {typeof children === "function" ? children(header) : children}
        </div>
      </main>
      <CommandPalette
        open={searching}
        onOpenChange={setSearching}
        tags={ordered}
        summaries={shownSummaries}
        actions={paletteActions}
        messageTexts={messageTexts}
        onSelectTag={onSelectTag}
      />
      <KeyboardShortcutsDialog open={listingShortcuts} onOpenChange={setListingShortcuts} />
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
  starting,
  localUpgrade,
}: {
  connected?: boolean;
  /** The local Gateway runs an older release: the offer to restart it with the app's. */
  localUpgrade?: ReactNode;
  /** The app is starting this machine's stopped SuperTag services before it connects. */
  starting?: boolean;
  /** Opens the New Tag dialog, when this connection may create Tags. */
  onNewTag?(): void;
  switching?: boolean;
  onSettings?: SettingsAction;
  /** Why the local Gateway is unavailable, such as the command that starts it. */
  localProblem?: string;
  /** Connects to the local Gateway while it runs. */
  onLocal?(): void;
}) {
  return (
    <div className="work-area">
      <div className="empty">
        {starting ? (
          <p role="status">Starting SuperTag…</p>
        ) : switching ? (
          <p role="status">Connecting to Gateway…</p>
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
            <p>Connect to a SuperTag Gateway to work with your persistent coding agents.</p>
            {localProblem && <p>{localProblem}</p>}
            {localUpgrade}
            {onLocal && !localUpgrade && (
              <Button className="primary" onClick={onLocal}>
                Connect to Local
              </Button>
            )}
            <Button
              variant={onLocal || localUpgrade ? "outline" : "default"}
              className={onLocal || localUpgrade ? "secondary" : "primary"}
              onClick={onSettings}
            >
              Add Gateway
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface WorkspaceProps {
  connectionId?: string;
  gateway: Gateway;
  initialTags: Tag[];
  selector(mode: SidebarMode): ReactNode;
  /** Which Gateway the drafts are kept for across restarts. */
  draftScope: string;
  /** Creates Tags, when this connection may. */
  tagAdmin?: TagAdmin;
  /** Why this connection cannot create Tags. */
  newTagRefusal?: string;
  /** The Gateway and connection settings the command palette offers. */
  actions?: readonly PaletteAction[];
  switching: boolean;
  connectionError: string;
  onWriteChange(delta: 1 | -1): void;
}

export function Workspace({
  connectionId,
  gateway,
  initialTags,
  selector,
  draftScope,
  tagAdmin,
  newTagRefusal,
  actions,
  switching,
  connectionError,
  onWriteChange,
}: WorkspaceProps) {
  const [tags, setTags] = useState(initialTags);
  const [creatingTag, setCreatingTag] = useState(false);
  // The app opens on the Tag it showed last on this Gateway.
  const [selectedTag, setSelectedTag] = useState(
    () => cachedRoster(gateway)?.selectedTag ?? initialTags[0]?.tagId,
  );
  const chosen = useRef(false);
  useEffect(() => {
    void storedRoster(gateway).then((roster) => {
      if (roster?.selectedTag && !chosen.current) setSelectedTag(roster.selectedTag);
    });
  }, [gateway]);
  const selectTag = useCallback(
    (tagId: string) => {
      chosen.current = true;
      setSelectedTag(tagId);
      cacheRoster(gateway, { selectedTag: tagId });
    },
    [gateway],
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
  const watch = useGatewayWatch(nativeGateway.watch, connectionId);
  // Every conversation's row, from the cached list at once and then the Gateway, kept
  // current through the watch.
  const { conversations, fresh } = useConversationList(gateway, watch);
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
    gateway,
    tags.map(({ tagId }) => tagId),
    tag?.tagId,
    watch,
  );

  const refreshTags = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await gateway.tags();
        if (!signal.aborted) {
          setTags(result);
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [gateway],
  );
  useWatchRefresh(refreshTags, rosterInterval, watch, rosterChanged);
  // Search reads the conversations the app keeps cached, without asking the Gateway.
  const messageTexts = useCallback(
    (tagId: string) => cachedMessageTexts(gateway, tagId),
    [gateway],
  );

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
    actions,
    messageTexts,
    error: connectionError || error,
  };
  const workspace = tag ? (
    <TagWorkspace
      key={tag.tagId}
      gateway={gateway}
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
 * across restarts, per Gateway; a message on its way is not.
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

function TagWorkspace({
  gateway,
  watch,
  tag,
  shell,
  draft,
  updateDraft,
  onSummary,
  onWriteChange,
}: {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
  shell: Omit<ShellProps, "children">;
  draft: Draft;
  updateDraft(update: (draft: Draft) => Draft): void;
  onSummary(tagId: string, summary: TagSummary): void;
  onWriteChange(delta: 1 | -1): void;
}) {
  const tagId = tag.tagId;
  const [details, setDetails] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("overview");
  const toggleDetails = useCallback((open?: boolean, requestedTab: InspectorTab = "overview") => {
    setTab(requestedTab);
    setDetails((prior) => open ?? !prior);
  }, []);
  return (
    <WorkspaceShell
      {...shell}
      tag={tag}
      detailsOpen={details}
      onTagDetails={toggleDetails}
      memoryAvailable={Boolean(gateway.harnessMemory)}
    >
      {(header) => (
        <ConversationPane
          header={header}
          key={tagId}
          gateway={gateway}
          watch={watch}
          tag={tag}
          draft={draft}
          updateDraft={updateDraft}
          onSummary={(summary) => onSummary(tagId, summary)}
          onWriteChange={onWriteChange}
          details={details}
          inspectorTab={tab}
          onInspectorTabChange={setTab}
          onCloseDetails={() => setDetails(false)}
        />
      )}
    </WorkspaceShell>
  );
}
