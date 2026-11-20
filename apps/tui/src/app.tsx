/**
 * The terminal UI's screen: the rail (Tags, Objectives, the inbox, Teams), the selected row's
 * pane (a Tag's conversation and composer, an Objective, an inbox item, a Team), the status
 * line, and the panels over them: the palette, Gateways, Keyboard shortcuts, New Tag, the new
 * Objective form, Work Sessions, and the selected Tag's Memory, Schedules, Network and Activity.
 * Everything of one Gateway lives under one `Workspace`, keyed by its cache scope, so switching
 * Gateways starts from that Gateway's own cache and nothing of one shows on another.
 */
import {
  type Alert,
  alertsFor,
  type Conversation,
  describe,
  hostLine,
  objectiveHomeLine,
  objectiveOpen,
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
  send as queue,
  stored,
  storedRoster,
  storedValue,
  useConversationList,
  useConversationPrefetch,
  useCoordination,
  useGatewayWatch,
  useWatchRefresh,
} from "@supertag/client/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TuiGateway } from "./connection";
import { type Controller, LOCAL_STATES } from "./controller";
import { ConversationPane } from "./conversation";
import { Gateways } from "./gateways";
import { InboxView } from "./inbox";
import { alt, SHORTCUTS } from "./keys";
import type { NotifyLevel } from "./launch";
import { LocalPanel } from "./local";
import { NewTagForm } from "./newtag";
import { alertLevel } from "./notify";
import { ObjectiveForm, ObjectiveView } from "./objective";
import { GOAL_ITEM, Palette, type PaletteItem } from "./palette";
import { PANEL_TITLES, PANELS, type PanelKind } from "./panels";
import { RAIL } from "./preferences";
import { Rail, type RailItem, type RailRow, railItems, railKey } from "./rail";
import { TeamView } from "./team";
import { clip, safe } from "./text";
import {
  color,
  type KeyEvent,
  StyleProvider,
  textBeforeCursor,
  useBlur,
  useFocus,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "./ui";
import { WorkSessions } from "./work";

export interface AppProps {
  controller: Controller;
  onQuit(): void;
  /** Writes one notification; `notify.ts` makes its bytes. */
  onAlert(alert: Alert): void;
  notifyLevel: NotifyLevel;
}

type Overlay =
  | "palette"
  | "local"
  | "gateways"
  | "help"
  | "newTag"
  | "goal"
  | "work"
  | PanelKind
  | undefined;

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
  // Starting, restarting or setting up the local services: their panel takes the keys.
  const local = LOCAL_STATES.has(status.kind) && overlay !== "gateways";
  const shown: Overlay = local ? "local" : overlay;
  return (
    <StyleProvider>
      <box flexDirection="column" width="100%" height="100%">
        {gateway ? (
          <Workspace
            key={gateway.scope}
            {...props}
            gateway={gateway}
            overlay={shown}
            setOverlay={setOverlay}
          />
        ) : (
          <Waiting controller={controller} overlay={shown} setOverlay={setOverlay} />
        )}
        {local ? (
          <Centered>
            <LocalPanel
              controller={controller}
              width={72}
              onChoose={() => setOverlay("gateways")}
            />
          </Centered>
        ) : null}
        {overlay === "gateways" || (!gateway && status.kind === "choosing") ? (
          <Centered>
            <Gateways
              connections={controller.connections}
              current={controller.entry?.id}
              width={72}
              onOpen={(entry) => {
                setOverlay(undefined);
                void controller.open(entry.id, entry, { start: entry.kind === "local" });
              }}
              onClose={() =>
                gateway || LOCAL_STATES.has(status.kind) ? setOverlay(undefined) : undefined
              }
              onForgot={(entry) => controller.forgot(entry.id)}
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
    <>
      <box flexGrow={1} flexDirection="column" padding={1}>
        {status.kind === "connecting" ? (
          <text fg={color.muted}>
            Connecting to {safe(controller.entry?.name ?? "the Gateway")}…
          </text>
        ) : status.kind === "failed" ? (
          <>
            <text fg={color.warning}>{safe(status.problem)}</text>
            <text fg={color.muted}>Trying again. Ctrl-P chooses another Gateway.</text>
          </>
        ) : status.kind === "choosing" ? (
          <text fg={color.muted}>Choose a Gateway.</text>
        ) : null}
      </box>
      <StatusLine controller={controller} unread={0} />
    </>
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
  /** The rail row in front when it is not a Tag: an Objective, an inbox item, or a Team. */
  const [view, setView] = useState<string | undefined>();
  const select = useCallback(
    (tagId: string) => {
      chosen.current = true;
      setSelected(tagId);
      setView(undefined);
      cacheRoster(gateway, { selectedTag: tagId });
    },
    [gateway],
  );

  // Objectives, the inbox, Teams.
  const coordination = useCoordination(gateway, watch, connectionId !== undefined);
  const openObjectives = useMemo(
    () => coordination.objectives.filter(objectiveOpen),
    [coordination.objectives],
  );
  const items = useMemo(
    () => railItems(rows, openObjectives, coordination.inbox, coordination.teams),
    [rows, openObjectives, coordination.inbox, coordination.teams],
  );
  // What a row showed stays in front after it leaves the rail, as an answered question does.
  const shownItem = useRef<RailItem | undefined>(undefined);
  const viewItem = view
    ? (items.find((item) => item.key === view) ?? shownItem.current)
    : undefined;
  if (viewItem?.key === view) shownItem.current = viewItem;
  const railSelected = viewItem ? viewItem.key : tag ? railKey.tag(tag.tagId) : undefined;
  const choose = useCallback(
    (item: RailItem) => {
      if (item.kind === "tag") select(item.row.tag.tagId);
      else setView(item.key);
    },
    [select],
  );
  const tagName = useCallback(
    (tagId: string) => tags.find((entry) => entry.tagId === tagId)?.name ?? tagId,
    [tags],
  );
  const objectivesById = useMemo(
    () => new Map(coordination.objectives.map((entry) => [entry.objectiveId, entry])),
    [coordination.objectives],
  );
  const homeLine = useCallback(
    (objectiveId: string) => {
      const found = objectivesById.get(objectiveId);
      return found ? objectiveHomeLine(found) : undefined;
    },
    [objectivesById],
  );
  /** The Sessions each Tag's conversation ran in, whose Work Sessions ↑ lists. */
  const [sessionsOf, setSessionsOf] = useState<Record<string, string[]>>({});
  const onSessions = useCallback(
    (tagId: string, ids: string[]) => setSessionsOf((prior) => ({ ...prior, [tagId]: ids })),
    [],
  );
  /** The palette was opened by `/` on an empty message, so `/goal` typed there counts. */
  const [slash, setSlash] = useState(false);
  const principal =
    controller.status.kind === "connected" ? controller.status.principal : undefined;
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

  // The Watch says when the Gateway stops answering, and when it answers again.
  const [lost, setLost] = useState(false);
  useEffect(() => {
    setLost(false);
    if (!watch) return;
    const unsubscribe = watch.subscribe((update) => {
      if (update.kind === "lost") setLost(true);
      else if (update.kind === "ready" || update.kind === "resync") setLost(false);
    });
    return () => {
      unsubscribe();
    };
  }, [watch]);

  const [focus, setFocus] = useState<"composer" | "rail">("composer");
  const [railWidth, setRailWidth] = useState(controller.preferences.railWidth);
  const [folded, setFolded] = useState(controller.preferences.railFolded);
  /** Moves the rail's cursor over every row: Tags, Objectives, the inbox, Teams. */
  const lastAt = useRef(0);
  const move = useCallback(
    (by: number) => {
      const shown = folded ? items.filter((item) => item.kind === "tag") : items;
      let at = shown.findIndex((item) => item.key === railSelected);
      // The row in front left the rail (an answered question): move from where it was.
      if (at < 0) at = lastAt.current - (by > 0 ? 1 : 0);
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + by))];
      if (next) choose(next);
    },
    [items, folded, railSelected, choose],
  );
  const selectedAt = items.findIndex((item) => item.key === railSelected);
  if (selectedAt >= 0) lastAt.current = selectedAt;
  const step = useCallback(
    (by: number) => {
      const at = rows.findIndex((row) => row.tag.tagId === tag?.tagId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + by))];
      if (next) select(next.tag.tagId);
    },
    [rows, tag, select],
  );
  const renderer = useRenderer();
  useKeyboard((key: KeyEvent) => {
    // ← and → with nothing held: Ctrl, Alt and Shift with them move and select by words.
    const plain = !key.ctrl && !key.meta && !key.option && !key.shift;
    if (overlay) {
      // Work Sessions and the Tag panels have no text: ← closes them, back to the list.
      if (plain && key.name === "left" && (overlay === "work" || overlay in PANELS)) {
        setOverlay(undefined);
        setFocus("rail");
      }
      return;
    }
    if (key.ctrl && key.name === "k") {
      setSlash(false);
      setOverlay("palette");
    } else if (key.ctrl && key.name === "p") setOverlay("gateways");
    else if (key.ctrl && key.name === "n") setOverlay("newTag");
    else if (key.ctrl && key.name === "b") {
      setFolded((prior) => {
        controller.savePreferences({ railFolded: !prior });
        return !prior;
      });
    } else if (key.name === "tab" && !key.ctrl)
      setFocus((prior) => (prior === "rail" ? "composer" : "rail"));
    else if ((alt(key) || key.ctrl) && /^[1-9]$/u.test(key.name)) {
      const row = rows[Number(key.name) - 1];
      if (row) select(row.tag.tagId);
    } else if (alt(key) && (key.name === "down" || key.name === "j")) step(1);
    else if (alt(key) && (key.name === "up" || key.name === "k")) step(-1);
    else if (focus === "rail") {
      if (key.name === "down" || key.name === "j") move(1);
      else if (key.name === "up" || key.name === "k") move(-1);
      else if (
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "escape" ||
        (plain && key.name === "right")
      )
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
    } else if (plain && key.name === "left" && !textBeforeCursor(renderer)) {
      // The pane's field is empty, or its cursor is at the start: back to the list, whose
      // selection stays on the row in front. Text before the cursor: the field moves it.
      key.preventDefault();
      setFocus("rail");
    }
  });

  const paletteItems: PaletteItem[] = useMemo(
    () => [
      ...rows.map((row, index) => ({
        id: `tag:${row.tag.tagId}`,
        label: row.tag.name ?? row.tag.tagId,
        keywords: `${row.tag.tagId} ${row.summary.preview ?? ""}`,
        section: "Tags" as const,
        ...(index < 9 ? { hint: `Alt-${index + 1}` } : {}),
        run: () => select(row.tag.tagId),
      })),
      {
        id: "new-tag",
        label: "New Tag",
        hint: "Ctrl-N",
        section: "Commands" as const,
        run: () => setOverlay("newTag"),
      },
      ...(tag
        ? [
            {
              id: GOAL_ITEM,
              label: "/goal · Create Objective",
              section: "Commands" as const,
              run: () => setOverlay("goal"),
            },
            {
              id: "work",
              label: "Work Sessions",
              hint: "↑",
              section: "Commands" as const,
              run: () => setOverlay("work"),
            },
            ...(["activity", "memory", "network", "schedules"] as const).map((kind) => ({
              id: kind,
              label: PANEL_TITLES[kind],
              section: "Commands" as const,
              run: () => setOverlay(kind),
            })),
          ]
        : []),
      {
        id: "inbox",
        label: "Open inbox",
        section: "Commands" as const,
        run: () => {
          const first = coordination.inbox[0];
          if (first) {
            setView(railKey.inbox(first.key));
            setFocus("composer");
          }
        },
      },
      {
        id: "gateways",
        label: "Gateways · add or switch",
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
    [rows, tag, folded, select, setOverlay, controller, onQuit, coordination.inbox],
  );

  const unread = unreadTotal(conversations, tag?.tagId);
  // A narrow terminal keeps most of its width for the conversation.
  const shownWidth = folded ? 6 : Math.min(railWidth, Math.max(RAIL.min, Math.floor(width * 0.4)));
  const { height } = useTerminalDimensions();
  const paneFocused = focus === "composer" && !overlay;
  const panelWidth = Math.min(100, Math.max(40, width - 4));
  const closeOverlay = () => setOverlay(undefined);
  let pane: React.ReactNode;
  if (viewItem?.kind === "objective") {
    pane = (
      <ObjectiveView
        key={viewItem.key}
        gateway={gateway}
        watch={watch}
        objective={viewItem.objective}
        focused={paneFocused}
        tagName={tagName}
        onChanged={coordination.refresh}
      />
    );
  } else if (viewItem?.kind === "inbox") {
    pane = (
      <InboxView
        key={viewItem.key}
        gateway={gateway}
        item={viewItem.item}
        focused={paneFocused}
        tagName={tagName}
        onDone={coordination.refresh}
      />
    );
  } else if (viewItem?.kind === "team") {
    pane = (
      <TeamView
        key={viewItem.key}
        gateway={gateway}
        watch={watch}
        team={viewItem.team}
        tagName={tagName}
      />
    );
  } else if (tag) {
    pane = (
      <ConversationPane
        key={tag.tagId}
        gateway={gateway}
        watch={watch}
        tag={tag}
        draft={drafts[tag.tagId] ?? ""}
        onDraft={(text) => setDraft(tag.tagId, text)}
        focused={paneFocused}
        onPalette={() => {
          setSlash(true);
          setOverlay("palette");
        }}
        onSummary={onSummary}
        onWork={() => setOverlay("work")}
        onSessions={onSessions}
        onGoal={() => setOverlay("goal")}
        homeLine={homeLine}
        offline={controller.status.kind === "failed"}
      />
    );
  } else {
    pane = (
      <box flexGrow={1} padding={1}>
        <text fg={color.muted}>
          {gateway.connectionId
            ? gateway.local
              ? "No Tags yet. Set SuperTag up with supertag init, or Ctrl-N creates one."
              : "No Tags yet. Ctrl-N creates one, or supertag tag put."
            : "Loading Tags…"}
        </text>
      </box>
    );
  }
  const Panel = overlay && overlay in PANELS ? PANELS[overlay as PanelKind] : undefined;
  const failed =
    controller.status.kind === "failed"
      ? `${safe(controller.status.problem)} Showing what this device kept; trying again. Ctrl-P chooses another Gateway.`
      : undefined;
  // The lines it wraps to, with room for breaking at words.
  const bannerLines = failed ? Math.ceil([...failed].length / Math.max(1, width - 12)) : 0;
  return (
    <>
      {failed ? (
        <text fg={color.warning} flexShrink={0}>
          {failed}
        </text>
      ) : null}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Rail
          items={items}
          selected={railSelected}
          focused={focus === "rail" && !overlay}
          folded={folded}
          width={shownWidth}
          height={Math.max(3, height - 1 - bannerLines)}
        />
        {pane}
      </box>
      <StatusLine controller={controller} hosts={hosts} unread={unread} lost={lost} brief />
      {overlay === "palette" ? (
        <Centered>
          <box marginTop={2}>
            <Palette
              items={paletteItems}
              width={Math.min(72, Math.max(30, width - 4))}
              slash={slash}
              onGoal={(outcome) => {
                if (tag) void queue(gateway, tag.tagId, `/goal ${outcome}`);
              }}
              onClose={closeOverlay}
            />
          </box>
        </Centered>
      ) : null}
      {overlay === "newTag" ? (
        <Centered>
          <NewTagForm
            gateway={gateway}
            principal={principal}
            width={Math.min(84, Math.max(40, width - 4))}
            onClose={closeOverlay}
            onCreated={(created) => {
              setOverlay(undefined);
              setTags((prior) =>
                prior.some((entry) => entry.tagId === created.tagId) ? prior : [...prior, created],
              );
              select(created.tagId);
            }}
          />
        </Centered>
      ) : null}
      {overlay === "goal" && tag ? (
        <Centered>
          <ObjectiveForm
            gateway={gateway}
            owner={tag.tagId}
            ownerName={tag.name ?? tag.tagId}
            width={Math.min(84, Math.max(40, width - 4))}
            onClose={closeOverlay}
            onShow={(objectiveId) => {
              coordination.refresh();
              setView(railKey.objective(objectiveId));
            }}
          />
        </Centered>
      ) : null}
      {overlay === "work" && tag ? (
        <Centered>
          <WorkSessions
            gateway={gateway}
            watch={watch}
            tagId={tag.tagId}
            sessionIds={sessionsOf[tag.tagId] ?? []}
            width={panelWidth}
            height={Math.max(8, height - 3)}
            onClose={closeOverlay}
          />
        </Centered>
      ) : null}
      {Panel && tag ? (
        <Centered>
          <Panel
            gateway={gateway}
            watch={watch}
            tagId={tag.tagId}
            tagName={tag.name ?? tag.tagId}
            width={panelWidth}
            height={Math.max(8, height - 4)}
            onClose={closeOverlay}
          />
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
  lost = false,
  brief = false,
}: {
  controller: Controller;
  hosts?: string | undefined;
  unread: number;
  /** The Gateway stopped answering the connection's Watch; it is being reopened. */
  lost?: boolean;
  /** Why connecting failed shows above, so this says only that it did. */
  brief?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const status = controller.status;
  const name = controller.entry?.name ?? "No Gateway";
  const reconnecting = status.kind === "connected" && lost;
  const state =
    status.kind === "connected"
      ? lost
        ? "not answering, reconnecting…"
        : "connected"
      : status.kind === "connecting"
        ? "connecting…"
        : status.kind === "failed"
          ? brief
            ? "not connected"
            : `not connected: ${describe(status.problem)}`
          : status.kind === "starting"
            ? "starting SuperTag…"
            : status.kind === "restarting"
              ? "restarting SuperTag…"
              : status.kind === "startFailed"
                ? "did not start"
                : status.kind === "notSetUp"
                  ? "not set up"
                  : status.kind === "upgrade"
                    ? `runs ${status.running}, an older release`
                    : "choose a Gateway";
  const parts = [
    name,
    state,
    ...(hosts && !reconnecting ? [`Worker Hosts: ${hosts}`] : []),
    ...(unread > 0 ? [`${unread} unread`] : []),
    "Ctrl-K commands",
    "Ctrl-P Gateways",
  ];
  return (
    <text
      fg={status.kind === "failed" || reconnecting ? color.warning : color.muted}
      flexShrink={0}
    >
      {clip(parts.join(" · "), Math.max(10, width - 1))}
    </text>
  );
}
