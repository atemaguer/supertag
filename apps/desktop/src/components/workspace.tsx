import { type MouseEvent, type ReactNode, useCallback, useState } from "react";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import type { ControlPlane, Tag, WatchUpdate } from "../control-plane";
import { shownConversation, useConversationPrefetch } from "../lib/conversation-cache";
import { describe } from "../lib/polling";
import { useControlPlaneWatch, useWatchRefresh, type WatchFeed } from "../lib/watch";
import { harnessLabel, type TagAdmin } from "../tag-admin";
import { ConversationPane, type Draft } from "./conversation";
import { NewTagDialog } from "./new-tag";
import {
  Sidebar,
  type SidebarMode,
  SidebarToggle,
  type TagSummary,
  useSidebarMode,
} from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import { Button } from "./ui/button";

const rosterInterval = 15_000;
const conversationInterval = 2_500;

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
  const mode = useSidebarMode();
  const provider = tag && harnessLabel(tag.harnessKind);
  return (
    <div className="shell" data-sidebar={mode}>
      <div className="window-controls">
        <SidebarToggle mode={mode} />
      </div>
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
  tagAdmin,
  newTagRefusal,
  switching,
  connectionError,
  onWriteChange,
}: WorkspaceProps) {
  const [tags, setTags] = useState(initialTags);
  const [creatingTag, setCreatingTag] = useState(false);
  const [selectedTag, setSelectedTag] = useState(initialTags[0]?.tagId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const watch = useControlPlaneWatch(connectionId);
  const tag = tags.find((entry) => entry.tagId === selectedTag) ?? tags[0];
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
    onSelectTag: setSelectedTag,
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
      drafts={drafts}
      setDraft={(key, draft) => setDrafts((prior) => ({ ...prior, [key]: draft }))}
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
            setSelectedTag(created.tagId);
          }}
        />
      )}
    </>
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
  const tagId = tag.tagId;
  // A Tag shown before opens its conversation at once, while its list revalidates.
  const [conversation, setConversation] = useState(() => shownConversation(controlPlane, tagId));
  const [error, setError] = useState("");
  const refreshThreads = useCallback(
    async (signal: AbortSignal) => {
      try {
        const entries = await controlPlane.conversations(tagId);
        if (!signal.aborted) {
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
    <WorkspaceShell {...shell} tag={tag} error={shell.error || error}>
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
