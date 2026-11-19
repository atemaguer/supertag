/**
 * The terminal UI's screen: the Tag list, the selected Tag's conversation and composer, the
 * status line, and the palette, Gateway chooser, and Keyboard shortcuts over them. Everything
 * of one Gateway lives under one `Workspace`, keyed by its cache scope, so switching Gateways
 * starts from that Gateway's own cache and nothing of one shows on another.
 */
import {
  type Alert,
  alertsFor,
  type Conversation,
  describe,
  hostLine,
  orderTags,
  rowSummary,
  type Tag,
  type TagSummary,
  unreadTotal,
  type WatchUpdate,
} from "@supertag/client/model";
import {
  cachedRoster,
  cacheRoster,
  stored,
  storedRoster,
  storedValue,
  useConversationList,
  useConversationPrefetch,
  useGatewayWatch,
  useWatchRefresh,
} from "@supertag/client/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TuiGateway } from "./connection";
import type { Controller } from "./controller";
import { ConversationPane } from "./conversation";
import { Gateways } from "./gateways";
import { alt, SHORTCUTS } from "./keys";
import type { NotifyLevel } from "./launch";
import { alertLevel } from "./notify";
import { Palette, type PaletteItem } from "./palette";
import { RAIL } from "./preferences";
import { Rail, type RailRow } from "./rail";
import { clip, safe } from "./text";
import {
  color,
  type KeyEvent,
  StyleProvider,
  useBlur,
  useFocus,
  useKeyboard,
  useTerminalDimensions,
} from "./ui";

export interface AppProps {
  controller: Controller;
  onQuit(): void;
  /** Writes one notification; `notify.ts` makes its bytes. */
  onAlert(alert: Alert): void;
  notifyLevel: NotifyLevel;
}

type Overlay = "palette" | "gateways" | "help" | undefined;

export function App(props: AppProps) {
  const { controller } = props;
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [overlay, setOverlay] = useState<Overlay>(
    controller.status.kind === "choosing" ? "gateways" : undefined,
  );
  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") props.onQuit();
  });
  const gateway = controller.gateway;
  const status = controller.status;
  return (
    <StyleProvider>
      <box flexDirection="column" width="100%" height="100%">
        {gateway ? (
          <Workspace
            key={gateway.scope}
            {...props}
            gateway={gateway}
            overlay={overlay}
            setOverlay={setOverlay}
          />
        ) : (
          <Waiting controller={controller} overlay={overlay} setOverlay={setOverlay} />
        )}
        {overlay === "gateways" || (!gateway && status.kind === "choosing") ? (
          <Centered>
            <Gateways
              connections={controller.connections}
              current={controller.entry?.id}
              width={72}
              onOpen={(entry) => {
                setOverlay(undefined);
                void controller.open(entry.id, entry);
              }}
              onClose={() => (gateway ? setOverlay(undefined) : undefined)}
            />
          </Centered>
        ) : null}
        {overlay === "help" ? (
          <Centered>
            <Help onClose={() => setOverlay(undefined)} />
          </Centered>
        ) : null}
      </box>
    </StyleProvider>
  );
}

/** No cached copy of this Gateway yet: say how connecting goes. */
function Waiting({
  controller,
  overlay,
  setOverlay,
}: {
  controller: Controller;
  overlay: Overlay;
  setOverlay(overlay: Overlay): void;
}) {
  useKeyboard((key: KeyEvent) => {
    if (overlay) return;
    if (key.ctrl && key.name === "p") setOverlay("gateways");
  });
  const status = controller.status;
  return (
    <box flexGrow={1} flexDirection="column" padding={1}>
      {status.kind === "connecting" ? (
        <text fg={color.muted}>Connecting to {safe(controller.entry?.name ?? "the Gateway")}…</text>
      ) : status.kind === "failed" ? (
        <>
          <text fg={color.warning}>{safe(status.problem)}</text>
          <text fg={color.muted}>Trying again. Ctrl-P chooses another Gateway.</text>
        </>
      ) : (
        <text fg={color.muted}>Choose a Gateway.</text>
      )}
      <box flexGrow={1} />
      <StatusLine controller={controller} unread={0} />
    </box>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={10}
      flexDirection="column"
      alignItems="center"
    >
      {children}
    </box>
  );
}

function Help({ onClose }: { onClose(): void }) {
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape" || key.name === "return" || key.name === "q") onClose();
  });
  return (
    <box
      width={72}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title="Keyboard shortcuts"
      marginTop={2}
    >
      {SHORTCUTS.map((shortcut) => (
        <text key={shortcut.keys}>
          <span fg={color.accent}>{shortcut.keys.padEnd(28)}</span>
          {shortcut.does}
        </text>
      ))}
      <text fg={color.faint}>Esc close</text>
    </box>
  );
}

const DRAFT_DELAY = 400;
const HOSTS_INTERVAL = 15_000;
const tagChanged = (update: WatchUpdate) => update.kind === "tag";

function Workspace({
  controller,
  gateway,
  overlay,
  setOverlay,
  onQuit,
  onAlert,
  notifyLevel,
}: AppProps & {
  gateway: TuiGateway;
  overlay: Overlay;
  setOverlay(overlay: Overlay): void;
}) {
  const { width } = useTerminalDimensions();
  const connectionId = gateway.connectionId;
  const watch = useGatewayWatch(gateway.watch, connectionId);
  const [tags, setTags] = useState<Tag[]>(() => cachedRoster(gateway)?.tags ?? []);
  const [selected, setSelected] = useState<string | undefined>(
    () => cachedRoster(gateway)?.selectedTag,
  );
  const chosen = useRef(false);
  useEffect(() => {
    void storedRoster(gateway).then((roster) => {
      if (roster?.tags?.length) setTags((prior) => (prior.length ? prior : (roster.tags ?? [])));
      if (roster?.selectedTag && !chosen.current) setSelected(roster.selectedTag);
    });
  }, [gateway]);
  const refreshTags = useCallback(
    async (signal: AbortSignal) => {
      if (!connectionId) return false;
      try {
        const next = await gateway.tags();
        if (signal.aborted) return;
        setTags(next);
        cacheRoster(gateway, { tags: next });
      } catch {
        return false;
      }
    },
    [gateway, connectionId],
  );
  // A new connection makes a new reader, which reads the Tags at once.
  useWatchRefresh(refreshTags, 5_000, watch, tagChanged);

  const { conversations, fresh } = useConversationList(gateway, watch);
  const [own, setOwn] = useState<Record<string, TagSummary>>({});
  const onSummary = useCallback(
    (tagId: string, summary: TagSummary) => setOwn((prior) => ({ ...prior, [tagId]: summary })),
    [],
  );
  const byTag = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.tagId, conversation])),
    [conversations],
  );
  const summaries = useMemo(() => {
    const result: Record<string, TagSummary> = {};
    for (const conversation of conversations) result[conversation.tagId] = rowSummary(conversation);
    for (const [tagId, summary] of Object.entries(own))
      result[tagId] = { ...result[tagId], ...summary, unread: result[tagId]?.unread ?? false };
    return result;
  }, [conversations, own]);
  const rows: RailRow[] = useMemo(() => {
    const { lead, others } = orderTags(tags, summaries);
    return [...(lead ? [lead] : []), ...others].map((tag) => {
      const conversation = byTag.get(tag.tagId);
      return {
        tag,
        summary: summaries[tag.tagId] ?? {},
        ...(conversation ? { conversation } : {}),
      };
    });
  }, [tags, summaries, byTag]);
  const tag = rows.find((row) => row.tag.tagId === selected)?.tag ?? rows[0]?.tag;
  const select = useCallback(
    (tagId: string) => {
      chosen.current = true;
      setSelected(tagId);
      cacheRoster(gateway, { selectedTag: tagId });
    },
    [gateway],
  );
  useConversationPrefetch(
    gateway,
    rows.map((row) => row.tag.tagId),
    tag?.tagId,
    watch,
  );

  // Drafts per Tag, across Tag switches and launches.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    void gateway.readCache("drafts").then((entry) => {
      const value = storedValue(entry);
      if (value && typeof value === "object")
        setDrafts((prior) => ({ ...(value as Record<string, string>), ...prior }));
    });
  }, [gateway]);
  const setDraft = useCallback(
    (tagId: string, text: string) => {
      setDrafts((prior) => {
        const next = { ...prior, [tagId]: text };
        if (!text) delete next[tagId];
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(
          () => void gateway.writeCache("drafts", stored(next)).catch(() => {}),
          DRAFT_DELAY,
        );
        return next;
      });
    },
    [gateway],
  );

  // Notifications: a reply or question in a conversation not in front, or while unfocused.
  const [focused, setFocused] = useState(true);
  useFocus(() => setFocused(true));
  useBlur(() => setFocused(false));
  const known = useRef<Map<string, Conversation> | undefined>(undefined);
  const names = useRef<(tagId: string) => string>(() => "");
  names.current = (tagId) => {
    const named = tags.find((entry) => entry.tagId === tagId);
    return named?.name ?? tagId;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once per read of the list.
  useEffect(() => {
    if (!fresh) return;
    const alerts = alertsFor(known.current, conversations, {
      focused,
      ...(tag ? { openTagId: tag.tagId } : {}),
      level: alertLevel(notifyLevel),
      name: (tagId) => names.current(tagId),
    });
    known.current = new Map(conversations.map((entry) => [entry.tagId, entry]));
    for (const alert of alerts) onAlert(alert);
  }, [conversations, fresh]);

  // Worker Hosts by phase, for an operator; a client device sees none.
  const [hosts, setHosts] = useState<string | undefined>();
  useEffect(() => {
    if (!connectionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const phases = await gateway.hostPhases();
        if (!stopped) setHosts(hostLine(phases));
      } catch {
        if (!stopped) setHosts(undefined);
      }
      if (!stopped) timer = setTimeout(read, HOSTS_INTERVAL);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [gateway, connectionId]);

  const [focus, setFocus] = useState<"composer" | "rail">("composer");
  const [railWidth, setRailWidth] = useState(controller.preferences.railWidth);
  const [folded, setFolded] = useState(controller.preferences.railFolded);
  const step = useCallback(
    (by: number) => {
      const at = rows.findIndex((row) => row.tag.tagId === tag?.tagId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + by))];
      if (next) select(next.tag.tagId);
    },
    [rows, tag, select],
  );
  useKeyboard((key: KeyEvent) => {
    if (overlay) return;
    if (key.ctrl && key.name === "k") setOverlay("palette");
    else if (key.ctrl && key.name === "p") setOverlay("gateways");
    else if (key.ctrl && key.name === "b") {
      setFolded((prior) => {
        controller.savePreferences({ railFolded: !prior });
        return !prior;
      });
    } else if (key.name === "tab" && !key.ctrl)
      setFocus((prior) => (prior === "rail" ? "composer" : "rail"));
    else if (alt(key) && /^[1-9]$/u.test(key.name)) {
      const row = rows[Number(key.name) - 1];
      if (row) select(row.tag.tagId);
    } else if (alt(key) && (key.name === "down" || key.name === "j")) step(1);
    else if (alt(key) && (key.name === "up" || key.name === "k")) step(-1);
    else if (focus === "rail") {
      if (key.name === "down" || key.name === "j") step(1);
      else if (key.name === "up" || key.name === "k") step(-1);
      else if (key.name === "return" || key.name === "enter" || key.name === "escape")
        setFocus("composer");
      else if (key.sequence === "[" || key.sequence === "]") {
        setRailWidth((prior) => {
          const next = Math.max(
            RAIL.min,
            Math.min(RAIL.max, prior + (key.sequence === "]" ? 2 : -2)),
          );
          controller.savePreferences({ railWidth: next });
          return next;
        });
      }
    }
  });

  const paletteItems: PaletteItem[] = useMemo(
    () => [
      ...rows.map((row, index) => ({
        id: `tag:${row.tag.tagId}`,
        label: row.tag.name ?? row.tag.tagId,
        section: "Tags" as const,
        ...(index < 9 ? { hint: `Alt-${index + 1}` } : {}),
        run: () => select(row.tag.tagId),
      })),
      {
        id: "gateways",
        label: "Gateways",
        hint: "Ctrl-P",
        section: "Commands" as const,
        run: () => setOverlay("gateways"),
      },
      {
        id: "fold",
        label: folded ? "Expand the Tag list" : "Fold the Tag list",
        hint: "Ctrl-B",
        section: "Commands" as const,
        run: () =>
          setFolded((prior) => {
            controller.savePreferences({ railFolded: !prior });
            return !prior;
          }),
      },
      {
        id: "help",
        label: "Keyboard shortcuts",
        section: "Commands" as const,
        run: () => setOverlay("help"),
      },
      { id: "quit", label: "Quit", hint: "Ctrl-C", section: "Commands" as const, run: onQuit },
    ],
    [rows, folded, select, setOverlay, controller, onQuit],
  );

  const unread = unreadTotal(conversations, tag?.tagId);
  const shownWidth = folded ? 6 : railWidth;
  return (
    <>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Rail
          rows={rows}
          selected={tag?.tagId}
          focused={focus === "rail" && !overlay}
          folded={folded}
          width={shownWidth}
        />
        {tag ? (
          <ConversationPane
            key={tag.tagId}
            gateway={gateway}
            watch={watch}
            tag={tag}
            draft={drafts[tag.tagId] ?? ""}
            onDraft={(text) => setDraft(tag.tagId, text)}
            focused={focus === "composer" && !overlay}
            onPalette={() => setOverlay("palette")}
            onSummary={onSummary}
          />
        ) : (
          <box flexGrow={1} padding={1}>
            <text fg={color.muted}>
              {gateway.connectionId
                ? "No Tags yet. Create one with supertag tag put."
                : "Loading Tags…"}
            </text>
          </box>
        )}
      </box>
      <StatusLine controller={controller} hosts={hosts} unread={unread} />
      {overlay === "palette" ? (
        <Centered>
          <box marginTop={2}>
            <Palette
              items={paletteItems}
              width={Math.min(72, Math.max(30, width - 4))}
              onClose={() => setOverlay(undefined)}
            />
          </box>
        </Centered>
      ) : null}
    </>
  );
}

/**
 * The status line: the Gateway, how its connection is, its Worker Hosts by phase (operators
 * only), and unread replies outside the conversation in front.
 */
function StatusLine({
  controller,
  hosts,
  unread,
}: {
  controller: Controller;
  hosts?: string | undefined;
  unread: number;
}) {
  const { width } = useTerminalDimensions();
  const status = controller.status;
  const name = controller.entry?.name ?? "No Gateway";
  const state =
    status.kind === "connected"
      ? "connected"
      : status.kind === "connecting"
        ? "connecting…"
        : status.kind === "failed"
          ? `not connected: ${describe(status.problem)}`
          : "choose a Gateway";
  const parts = [
    name,
    state,
    ...(hosts ? [`Worker Hosts: ${hosts}`] : []),
    ...(unread > 0 ? [`${unread} unread`] : []),
    "Ctrl-K commands",
    "Ctrl-P Gateways",
  ];
  return (
    <text fg={status.kind === "failed" ? color.warning : color.muted} flexShrink={0}>
      {clip(parts.join(" · "), Math.max(10, width - 1))}
    </text>
  );
}
