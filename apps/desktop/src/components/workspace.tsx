import { Check, ChevronDown, PanelLeft, PanelLeftClose, Plus } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import type { ControlPlane, Tag, WatchUpdate } from "../control-plane";
import { describe } from "../lib/polling";
import { useControlPlaneWatch, useWatchRefresh, type WatchFeed } from "../lib/watch";
import { ConversationPane, type Draft } from "./conversation";
import { TagAvatar } from "./tag-avatar";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";

const rosterInterval = 15_000;
const conversationInterval = 2_500;
function label(name: string) {
  const words = name.replace(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function harness(kind: string) {
  return { codex: "Codex", claude_code: "Claude Code", openai_agents: "OpenAI Agents" }[kind];
}

const SIDEBAR_KEY = "supertag.desktop.sidebar";
const sidebarListeners = new Set<() => void>();

/** Whether the sidebar is open: the one saved preference, open unless collapsed. */
export function sidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

/** Opens or collapses the sidebar in every shell, and remembers it across restarts. */
export function setSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "open" : "collapsed");
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

const mac = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");

/**
 * Whether a key press toggles the sidebar: ⌘B on macOS, Ctrl+B elsewhere. The composer is plain
 * text, so the shortcut has nothing to make bold there and applies everywhere in the window.
 */
export function isSidebarShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  onMac: boolean,
) {
  if (event.key.toLowerCase() !== "b" || event.altKey || event.shiftKey || event.isComposing)
    return false;
  return onMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Where the Control Plane selector shows: in the rail, or beside the toggle when it is collapsed. */
export type SelectorPlacement = "rail" | "top";

export type SettingsAction = (event: MouseEvent<HTMLButtonElement>) => void;
interface ShellProps {
  tags: Tag[];
  tag?: Tag;
  conversation?: string;
  names?: string[];
  connected: boolean;
  switching?: boolean;
  selector(placement: SelectorPlacement): ReactNode;
  error?: string;
  onSelectTag?(tagId: string): void;
  onSelectConversation?(name: string): void;
  children?: ReactNode;
}

/**
 * The window: a full-height rail of Tags on the left, and the conversation reaching the top of
 * the window, with the Tag and conversation in a floating pill over it.
 */
export function WorkspaceShell({
  tags,
  tag,
  conversation,
  names,
  connected,
  switching,
  selector,
  error,
  onSelectTag,
  onSelectConversation,
  children,
}: ShellProps) {
  const [creating, setCreating] = useState(false);
  const open = useSyncExternalStore(subscribeSidebar, sidebarOpen, () => true);
  const onMac = mac();
  const toggle = `${open ? "Hide" : "Show"} sidebar (${onMac ? "⌘B" : "Ctrl+B"})`;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isSidebarShortcut(event, onMac)) return;
      event.preventDefault();
      setSidebarOpen(!sidebarOpen());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMac]);
  const provider = tag && harness(tag.harnessKind);
  const threadNames =
    conversation && !names?.includes(conversation)
      ? [conversation, ...(names ?? [])]
      : (names ?? []);

  return (
    <div className="shell" data-sidebar={open ? "open" : "collapsed"}>
      {/* The toggle stays in one place, beside the macOS window controls, in both states. */}
      <div className="window-controls">
        <Button
          variant="ghost"
          size="icon"
          className="sidebar-toggle"
          aria-label={toggle}
          title={toggle}
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setSidebarOpen(!open)}
        >
          {open ? <PanelLeftClose size={17} aria-hidden /> : <PanelLeft size={17} aria-hidden />}
        </Button>
        {!open && selector("top")}
      </div>
      <nav id="sidebar" className="rail" aria-label="Tags" inert={!open}>
        <div className="rail-top" data-tauri-drag-region>
          <img
            className="rail-mascot"
            src={mascot}
            alt="SuperTag"
            width={36}
            height={36}
            data-tauri-drag-region
          />
        </div>
        <div className="rail-divider" aria-hidden />
        <div className="rail-tags">
          {tags.length === 0 && (
            <p className="visually-hidden">
              {connected ? "No Tags available" : "Connect to see your Tags"}
            </p>
          )}
          {tags.map((entry) => {
            const name = entry.name ?? entry.tagId;
            return (
              <Button
                key={entry.tagId}
                variant="ghost"
                className="rail-tag"
                aria-label={name}
                title={name}
                aria-current={tag?.tagId === entry.tagId}
                onClick={() => onSelectTag?.(entry.tagId)}
              >
                <TagAvatar tagId={entry.tagId} />
              </Button>
            );
          })}
        </div>
        <div className="rail-bottom">
          {tag && (
            <Button
              variant="ghost"
              className="rail-action"
              aria-label="New conversation"
              title="New conversation"
              onClick={() => setCreating(true)}
            >
              <Plus size={18} aria-hidden />
            </Button>
          )}
          {open && selector("rail")}
        </div>
      </nav>
      <main className="main" aria-label="Conversation" aria-busy={switching}>
        <header className="topstrip" data-tauri-drag-region>
          {tag && conversation && (
            <ConversationSwitcher
              tag={tag}
              conversation={conversation}
              names={threadNames}
              tags={open ? undefined : tags}
              onSelectTag={(tagId) => onSelectTag?.(tagId)}
              onSelect={(name) => onSelectConversation?.(name)}
              onCreate={() => setCreating(true)}
            />
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
      <NewConversation
        open={creating}
        onOpenChange={setCreating}
        onChoose={(name) => onSelectConversation?.(name)}
      />
    </div>
  );
}

/**
 * The floating pill naming the Tag and conversation, which switches between conversations, and
 * between Tags while the sidebar is collapsed.
 */
function ConversationSwitcher({
  tag,
  conversation,
  names,
  tags,
  onSelectTag,
  onSelect,
  onCreate,
}: {
  tag: Tag;
  conversation: string;
  names: string[];
  /** The Tags to switch between, when the sidebar does not show them. */
  tags?: Tag[];
  onSelectTag(tagId: string): void;
  onSelect(name: string): void;
  onCreate(): void;
}) {
  const name = tag.name ?? tag.tagId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="identity-pill"
          aria-label={`${name}, ${label(conversation)}. Switch conversation`}
        >
          <TagAvatar tagId={tag.tagId} />
          <span className="tag-name">{name}</span>
          <span className="thread-title" title={conversation}>
            {label(conversation)}
          </span>
          <ChevronDown size={14} className="identity-arrow" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="conversation-menu" align="center" sideOffset={6}>
        {tags && (
          <>
            <div className="menu-label">Tags</div>
            <DropdownMenuRadioGroup value={tag.tagId} onValueChange={onSelectTag}>
              {tags.map((entry) => (
                <DropdownMenuRadioItem
                  key={entry.tagId}
                  className="control-plane-choice menu-tag"
                  value={entry.tagId}
                >
                  <TagAvatar tagId={entry.tagId} />
                  <span className="row-title">{entry.name ?? entry.tagId}</span>
                  <span className="control-plane-indicator menu-tag-check" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator className="control-plane-separator" />
            <div className="menu-label">Conversations</div>
          </>
        )}
        <DropdownMenuRadioGroup value={conversation} onValueChange={onSelect}>
          {names.map((entry) => (
            <DropdownMenuRadioItem
              key={entry}
              className="control-plane-choice"
              value={entry}
              title={entry}
            >
              <span className="control-plane-indicator" aria-hidden>
                <DropdownMenuItemIndicator>
                  <Check size={14} />
                </DropdownMenuItemIndicator>
              </span>
              <span className="row-title">{label(entry)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator className="control-plane-separator" />
        <DropdownMenuItem className="control-plane-action" onSelect={onCreate}>
          <Plus size={15} aria-hidden /> New conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewConversation({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onChoose(name: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace-dialog">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>
            Use letters, numbers, dots, underscores, or hyphens.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            if (typeof name !== "string") return;
            onChoose(name);
            onOpenChange(false);
          }}
        >
          <label htmlFor="thread-name">Conversation name</label>
          <Input
            id="thread-name"
            name="name"
            maxLength={64}
            pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]*"}
            placeholder="release-review"
            autoComplete="off"
            required
          />
          <DialogFooter className="dialog-actions">
            <Button className="primary" type="submit">
              Open conversation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EmptyWorkspace({
  connected,
  switching,
  onSettings,
  localProblem,
  onLocal,
}: {
  connected?: boolean;
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
            <p>Configure a Tag in this workspace to start a conversation.</p>
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
  selector(placement: SelectorPlacement): ReactNode;
  switching: boolean;
  connectionError: string;
  onWriteChange(delta: 1 | -1): void;
}

export function Workspace({
  connectionId,
  controlPlane,
  initialTags,
  selector,
  switching,
  connectionError,
  onWriteChange,
}: WorkspaceProps) {
  const [tags, setTags] = useState(initialTags);
  const [selectedTag, setSelectedTag] = useState(initialTags[0]?.tagId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const watch = useControlPlaneWatch(connectionId);
  const tag = tags.find((entry) => entry.tagId === selectedTag) ?? tags[0];

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
    onSelectTag: setSelectedTag,
    error: connectionError || error,
  };
  return tag ? (
    <TagWorkspace
      key={tag.tagId}
      controlPlane={controlPlane}
      watch={watch}
      tag={tag}
      shell={shell}
      drafts={drafts}
      setDraft={(key, draft) => setDrafts((prior) => ({ ...prior, [key]: draft }))}
      onWriteChange={onWriteChange}
    />
  ) : (
    <WorkspaceShell {...shell}>
      <EmptyWorkspace connected />
    </WorkspaceShell>
  );
}

const rosterChanged = (update: WatchUpdate) => update.kind === "tag";

function TagWorkspace({
  controlPlane,
  watch,
  tag,
  shell,
  drafts,
  setDraft,
  onWriteChange,
}: {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
  shell: Omit<ShellProps, "children">;
  drafts: Record<string, Draft>;
  setDraft(key: string, draft: Draft): void;
  onWriteChange(delta: 1 | -1): void;
}) {
  const [conversation, setConversation] = useState<string>();
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tagId = tag.tagId;
  const refreshThreads = useCallback(
    async (signal: AbortSignal) => {
      try {
        const entries = await controlPlane.conversations(tagId);
        if (!signal.aborted) {
          setNames(entries.map(({ name }) => name));
          setConversation((prior) => prior ?? entries[0]?.name ?? "default");
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [controlPlane, tagId],
  );
  const threadsChanged = useCallback(
    (update: WatchUpdate) => update.kind === "conversation" && update.tagId === tagId,
    [tagId],
  );
  useWatchRefresh(refreshThreads, conversationInterval, watch, threadsChanged);

  const key = JSON.stringify([tagId, conversation]);
  return (
    <WorkspaceShell
      {...shell}
      tag={tag}
      names={names}
      conversation={conversation}
      error={shell.error || error}
      onSelectConversation={setConversation}
    >
      {conversation ? (
        <ConversationPane
          key={key}
          controlPlane={controlPlane}
          watch={watch}
          tag={tag}
          name={conversation}
          draft={drafts[key] ?? { text: "" }}
          setDraft={(draft) => setDraft(key, draft)}
          onWriteChange={onWriteChange}
        />
      ) : (
        <div className="work-area">
          <div className="empty" role="status">
            Loading conversations…
          </div>
        </div>
      )}
    </WorkspaceShell>
  );
}
