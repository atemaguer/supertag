import { ChevronRight, Menu, MessageSquare, Plus } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import mascot from "../../../../assets/images/supertag-mascot-round.png";
import type { Gateway, Tag } from "../gateway";
import { describe, usePolling } from "../lib/polling";
import { ConversationPane, type Draft } from "./conversation";
import { TagAvatar } from "./tag-avatar";

const rosterInterval = 15_000;
const conversationInterval = 2_500;
function label(name: string) {
  const words = name.replace(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function harness(kind: string) {
  return { codex: "Codex", claude_code: "Claude Code", openai_agents: "OpenAI Agents" }[kind];
}

export type SettingsAction = (event: MouseEvent<HTMLButtonElement>) => void;
interface ShellProps {
  tags: Tag[];
  tag?: Tag;
  conversation?: string;
  names?: string[];
  connected: boolean;
  preview?: boolean;
  busy: boolean;
  error?: string;
  onSelectTag?(tagId: string): void;
  onSelectConversation?(name: string): void;
  onSettings: SettingsAction;
  children: ReactNode;
}

export function WorkspaceShell({
  tags,
  tag,
  conversation,
  names,
  connected,
  preview,
  busy,
  error,
  onSelectTag,
  onSelectConversation,
  onSettings,
  children,
}: ShellProps) {
  const [railOpen, setRailOpen] = useState(false);
  const provider = tag && harness(tag.harnessKind);
  const connectionLabel = preview
    ? "Preview workspace"
    : connected
      ? "Gateway connected"
      : "Gateway disconnected";
  const threadNames =
    conversation && !names?.includes(conversation)
      ? [conversation, ...(names ?? [])]
      : (names ?? []);

  function chooseConversation(name: string) {
    onSelectConversation?.(name);
    setRailOpen(false);
  }

  return (
    <div className={railOpen ? "workspace-shell" : "workspace-shell rail-closed"}>
      <div className="shell">
        <aside className="rail" aria-label="Workspace">
          <div className="brand">
            <img src={mascot} alt="" width={31} height={31} />
            <strong>SuperTag</strong>
          </div>
          <div className="rail-content">
            <nav aria-label="Tags">
              <div className="rail-heading">
                <h2>Tags</h2>
              </div>
              <div className="rail-list">
                {tags.length === 0 && (
                  <p className="rail-empty">
                    {connected ? "No Tags available" : "Connect to see your Tags"}
                  </p>
                )}
                {tags.map((entry) => (
                  <Button
                    key={entry.tagId}
                    variant="ghost"
                    className="rail-row tag-row"
                    aria-current={tag?.tagId === entry.tagId}
                    onClick={() => {
                      onSelectTag?.(entry.tagId);
                      setRailOpen(false);
                    }}
                  >
                    <TagAvatar tagId={entry.tagId} />
                    <span className="row-title">{entry.tagId}</span>
                  </Button>
                ))}
              </div>
            </nav>
            {tag && (
              <nav aria-label="Conversations">
                <div className="rail-heading">
                  <h2>Conversations</h2>
                  <NewConversation onChoose={chooseConversation} />
                </div>
                <div className="rail-list">
                  {threadNames.map((name) => (
                    <Button
                      key={name}
                      variant="ghost"
                      className="rail-row thread-row"
                      title={name}
                      aria-current={conversation === name}
                      onClick={() => chooseConversation(name)}
                    >
                      <MessageSquare size={13} aria-hidden />
                      <span className="row-title">{label(name)}</span>
                    </Button>
                  ))}
                </div>
              </nav>
            )}
          </div>
          <Button
            variant="outline"
            className="connection"
            data-connected={connected}
            title={preview ? "Exit preview" : "Gateway settings"}
            onClick={onSettings}
            disabled={busy}
          >
            <span className="connection-dot" aria-hidden />
            <span>{connectionLabel}</span>
            <ChevronRight className="connection-arrow" size={15} aria-hidden />
          </Button>
        </aside>
        <main className="main" aria-label="Conversation">
          <header className="topbar">
            <Button
              variant="ghost"
              size="icon"
              className="icon-button mobile-toggle"
              aria-label="Toggle workspace"
              aria-expanded={railOpen}
              onClick={() => setRailOpen(!railOpen)}
            >
              <Menu size={17} aria-hidden />
            </Button>
            <div id="identity">
              {tag ? (
                <>
                  <TagAvatar tagId={tag.tagId} />
                  <div className="identity-heading">
                    <strong className="tag-name">{tag.tagId}</strong>
                    {conversation && (
                      <h1 className="thread-title" title={conversation}>
                        {label(conversation)}
                      </h1>
                    )}
                  </div>
                  {provider && <span className="harness">{provider}</span>}
                </>
              ) : (
                <h1 className="workspace-title">Workspace</h1>
              )}
            </div>
          </header>
          {error && (
            <div className="sync-error" role="status">
              {error}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

function NewConversation({ onChoose }: { onChoose(name: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button"
          aria-label="New conversation"
          title="New conversation"
        >
          <Plus size={16} aria-hidden />
        </Button>
      </DialogTrigger>
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
            setOpen(false);
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
  onSettings,
}: {
  connected: boolean;
  onSettings: SettingsAction;
}) {
  return (
    <div className="work-area">
      <div className="empty">
        {connected ? (
          <>
            <h2>No Tags available</h2>
            <p>Configure a Tag in this workspace to start a conversation.</p>
          </>
        ) : (
          <>
            <img src={mascot} alt="" className="empty-mascot" />
            <h2>Your Tags, in one place</h2>
            <p>Connect to a SuperTag Gateway to work with your persistent coding agents.</p>
            <Button className="primary" onClick={onSettings}>
              Connect Gateway
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface WorkspaceProps {
  gateway: Gateway;
  initialTags: Tag[];
  preview: boolean;
  busy: boolean;
  onSettings: SettingsAction;
  onWriteChange(delta: 1 | -1): void;
}

export function Workspace({
  gateway,
  initialTags,
  preview,
  busy,
  onSettings,
  onWriteChange,
}: WorkspaceProps) {
  const [tags, setTags] = useState(initialTags);
  const [selectedTag, setSelectedTag] = useState(initialTags[0]?.tagId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const tag = tags.find((entry) => entry.tagId === selectedTag) ?? tags[0];

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
      }
    },
    [gateway],
  );
  usePolling(refreshTags, rosterInterval);

  const shell = {
    tags,
    preview,
    busy,
    onSettings,
    connected: true,
    onSelectTag: setSelectedTag,
    error,
  };
  return tag ? (
    <TagWorkspace
      key={tag.tagId}
      gateway={gateway}
      tag={tag}
      shell={shell}
      drafts={drafts}
      setDraft={(key, draft) => setDrafts((prior) => ({ ...prior, [key]: draft }))}
      onWriteChange={onWriteChange}
    />
  ) : (
    <WorkspaceShell {...shell}>
      <EmptyWorkspace connected onSettings={onSettings} />
    </WorkspaceShell>
  );
}

function TagWorkspace({
  gateway,
  tag,
  shell,
  drafts,
  setDraft,
  onWriteChange,
}: {
  gateway: Gateway;
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
        const entries = await gateway.conversations(tagId);
        if (!signal.aborted) {
          setNames(entries.map(({ name }) => name));
          setConversation((prior) => prior ?? entries[0]?.name ?? "default");
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
      }
    },
    [gateway, tagId],
  );
  usePolling(refreshThreads, conversationInterval);

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
          gateway={gateway}
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
