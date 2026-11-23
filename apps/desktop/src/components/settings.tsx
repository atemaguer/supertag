/**
 * Settings: one large dialog with a list of pages on the left and the chosen page on the right,
 * opened by the gear at the foot of the sidebar, ⌘, (Ctrl+, outside macOS), the app menu and the
 * command palette. A page is a title, one line saying what it is, and cards of rows: a label, a
 * line of help, and a control at the right. A page that only shows what is configured elsewhere
 * says so, and how to change it. `DESIGN.md` describes the pattern.
 */
import {
  type Gateway,
  type GatewayList,
  type GatewayRelease,
  harnessLabel,
  hostLine,
  LOCAL_GATEWAY,
  type NotificationLevel,
  type Tag,
  type TagAdmin,
} from "@supertag/client/model";
import {
  Bell,
  Info,
  Keyboard,
  type LucideIcon,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Waypoints,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { RELEASES_URL, type UpdateStatus } from "../../electron/update-state";
import { type SendKey, sendKeyWords, useSendKey } from "../lib/preferences";
import { keyboardShortcuts } from "./command-palette";
import { openExternal } from "./external-link";
import { onMac, type SidebarMode, setSidebarMode, useSidebarMode } from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { type Updates, updateView } from "./update";
import { APP_VERSION, releaseDiffers } from "./version";

const DOCS_URL = "https://github.com/atemaguer/supertag/tree/main/docs";
const doc = (path: string) => `https://github.com/atemaguer/supertag/blob/main/docs/${path}`;

/** The pages, by the ID a link to one names. */
export const SETTINGS_PAGES = [
  "general",
  "notifications",
  "shortcuts",
  "updates",
  "about",
  "gateways",
  "tags",
  "hosts",
  "permissions",
] as const;
export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

/** What this device notifies about; the setting is kept on this device only. */
export const NOTIFICATION_CHOICES: readonly [NotificationLevel, string][] = [
  ["all", "All messages"],
  ["questions", "Questions only"],
  ["off", "Off"],
];

/** Whether a key press opens Settings: ⌘, on macOS, Ctrl+, elsewhere. */
export function isSettingsShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  mac: boolean,
) {
  if (event.key !== "," || event.altKey || event.shiftKey || event.isComposing) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * The page with something waiting to be seen, which the gear marks with a dot and opens: an
 * update offered, under way or failed, or a Gateway on another release than the app.
 */
export function pendingPage(
  status: UpdateStatus,
  app: string,
  gateway?: GatewayRelease,
): SettingsPageId | undefined {
  const view = updateView(status);
  if (view.button || view.banner) return "updates";
  return releaseDiffers(app, gateway) ? "about" : undefined;
}

/** What the Updates page says for a status; `checked` once a check was asked for here. */
export function updateLine(status: UpdateStatus, checked: boolean): string {
  switch (status.state) {
    case "off":
      return "Updates are off in this build.";
    case "idle":
      return checked ? "SuperTag is up to date." : "No update is waiting.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading SuperTag ${status.version} · ${status.percent}%`;
    case "preparing":
      return `Preparing SuperTag ${status.version}…`;
    case "ready":
      return `SuperTag ${status.version} is ready.`;
    case "installing":
      return `Installing SuperTag ${status.version}…`;
    case "available":
      return `SuperTag ${status.version} is available.`;
    case "error":
      return updateView(status).banner?.title ?? "Couldn't check for updates";
  }
}

/** The gear at the foot of the sidebar; a dot on it says something in Settings waits. */
export function SettingsButton({
  pending,
  button,
  onOpen,
}: {
  pending: boolean;
  button?: RefObject<HTMLButtonElement | null>;
  onOpen(): void;
}) {
  return (
    <Button
      variant="ghost"
      ref={button}
      className="sidebar-button settings-button"
      aria-label="Settings"
      aria-description={pending ? "Something in Settings needs a look" : undefined}
      aria-haspopup="dialog"
      title="Settings"
      data-pending={pending || undefined}
      onClick={onOpen}
    >
      <Settings size={16} aria-hidden />
    </Button>
  );
}

/** One row of a card: what it is, a line of help, and its control or value at the right. */
interface Row {
  key: string;
  label: string;
  help?: string;
  /** Before the label, such as a Tag's avatar. */
  lead?: ReactNode;
  /** After the label, such as "Lead" or "Connected". */
  chip?: string;
  control?: ReactNode;
}
interface Card {
  title?: string;
  rows: Row[];
  /** Under the rows: a button that adds to them. */
  action?: ReactNode;
}
interface Page {
  id: SettingsPageId;
  group: "App" | "SuperTag";
  title: string;
  description: string;
  icon: LucideIcon;
  /** For a page that only shows: how what it shows is changed, and where that is documented. */
  readOnly?: { how: string; docs: string };
  /** In place of cards: still loading, or why there is nothing to show. */
  status?: string;
  cards: Card[];
  /** Under the cards. */
  footer?: ReactNode;
}

/** The connection Settings describes; none while disconnected. */
export interface SettingsConnection {
  gateway: Gateway;
  /** The saved origin, or `local`; none for the preview. */
  origin?: string;
  release?: GatewayRelease;
  tags: Tag[];
  /** Present when this connection may see the Worker Hosts' offer. */
  tagAdmin?: TagAdmin;
}

export interface SettingsProps {
  /** The page shown; none while Settings is closed. */
  page?: SettingsPageId;
  onPage(page: SettingsPageId | undefined): void;
  app?: string;
  connection?: SettingsConnection;
  gateways: GatewayList;
  /** Switching or saving a Gateway is under way. */
  busy?: boolean;
  onSelectGateway(origin: string): void;
  /** Opens the Gateway form: for a saved Gateway, or to add one. */
  onEditGateway(profile?: { name: string; origin: string }): void;
  onDisconnect(): void;
  updates: Updates;
  notifications: NotificationLevel;
  onNotifications(level: NotificationLevel): void;
  /** Shows a Tag's conversation with its details panel open. */
  onOpenTag?(tagId: string): void;
  /** Where the focus goes when the dialog closes: the gear. */
  returnFocus?: RefObject<HTMLElement | null>;
}

/** One choice out of a few, as buttons side by side. */
function Segmented<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly (readonly [T, string])[];
  onChange(value: T): void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {choices.map(([choice, text]) => (
        // biome-ignore lint/a11y/useSemanticElements: a row of buttons, not form radios
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={choice === value}
          onClick={() => onChange(choice)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Reads `read` once each time Settings opens on a connection; `undefined` until it answers. */
function useRead<T>(key: unknown, read: (() => Promise<T>) | undefined) {
  const [state, setState] = useState<{ value?: T; failed?: boolean }>({});
  const reader = useRef(read);
  reader.current = read;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says when to read again.
  useEffect(() => {
    setState({});
    if (!reader.current) return;
    let current = true;
    reader.current().then(
      (value) => current && setState({ value }),
      () => current && setState({ failed: true }),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return state;
}

const SEND_CHOICES: readonly (readonly [SendKey, string])[] = [
  ["enter", "Enter"],
  ["mod-enter", onMac() ? "⌘Enter" : "Ctrl+Enter"],
];
const SIDEBAR_CHOICES: readonly (readonly [SidebarMode, string])[] = [
  ["expanded", "Expanded"],
  ["rail", "Rail"],
];

export function SettingsDialog({
  page,
  onPage,
  app = APP_VERSION,
  connection,
  gateways,
  busy,
  onSelectGateway,
  onEditGateway,
  onDisconnect,
  updates,
  notifications,
  onNotifications,
  onOpenTag,
  returnFocus,
}: SettingsProps) {
  const id = useId();
  const open = page !== undefined;
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(false);
  const [sendKey, setSendKey] = useSendKey();
  const sidebar = useSidebarMode();
  const gateway = connection?.gateway;
  // Read when Settings opens: the Tags as they are now, and what the Worker Hosts offer.
  const readKey = open ? gateway : undefined;
  const tags = useRead(readKey, gateway && open ? () => gateway.tags() : undefined);
  const hosts = useRead(readKey, gateway?.hostPhases && open ? gateway.hostPhases : undefined);
  const admin = connection?.tagAdmin;
  const offer = useRead(readKey, admin && open ? () => admin.options() : undefined);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const mac = onMac();
  const { status, button } = updates;
  const working = ["checking", "downloading", "preparing", "installing"].includes(status.state);
  const differs = releaseDiffers(app, connection?.release);
  const shownTags = tags.value ?? connection?.tags ?? [];
  const local = gateways.local;
  const saved = [
    ...(connection?.origin === LOCAL_GATEWAY || local?.origin
      ? [{ name: "Local", origin: LOCAL_GATEWAY, address: local?.origin ?? "This machine" }]
      : []),
    ...gateways.profiles.map((profile) => ({ ...profile, address: profile.origin })),
  ];
  const activeName =
    saved.find((entry) => entry.origin === connection?.origin)?.name ??
    (connection ? "Preview workspace" : undefined);
  const releaseText = connection?.release
    ? `${connection.release.build}${connection.release.protocol > 0 ? ` · Protocol ${connection.release.protocol}` : ""}`
    : undefined;
  const link = (text: string, href: string) => (
    <Button variant="outline" className="secondary" onClick={() => openExternal(href)}>
      {text}
    </Button>
  );
  const value = (text: string) => <span className="settings-value">{text}</span>;
  const keys = sendKeyWords(sendKey, mac);

  const pages: Page[] = [
    {
      id: "general",
      group: "App",
      title: "General",
      description: "How this window behaves on this device.",
      icon: SlidersHorizontal,
      cards: [
        {
          rows: [
            {
              key: "send",
              label: "Send messages with",
              help: `${keys.send} sends; ${keys.line} starts a new line.`,
              control: (
                <Segmented
                  label="Send messages with"
                  value={sendKey}
                  choices={SEND_CHOICES}
                  onChange={setSendKey}
                />
              ),
            },
            {
              key: "sidebar",
              label: "Sidebar",
              help: `Show each Tag in a row, or fold the sidebar into a rail of avatars. ${mac ? "⌘B" : "Ctrl+B"} switches.`,
              control: (
                <Segmented
                  label="Sidebar"
                  value={sidebar}
                  choices={SIDEBAR_CHOICES}
                  onChange={setSidebarMode}
                />
              ),
            },
          ],
        },
      ],
    },
    {
      id: "notifications",
      group: "App",
      title: "Notifications",
      description: "What this device tells you about while you look elsewhere.",
      icon: Bell,
      cards: [
        {
          rows: [
            {
              key: "level",
              label: "Notify me about",
              help: "A Tag's replies and questions, only its questions, or nothing. Kept on this device.",
              control: (
                <Segmented
                  label="Notify me about"
                  value={notifications}
                  choices={NOTIFICATION_CHOICES}
                  onChange={onNotifications}
                />
              ),
            },
          ],
        },
      ],
    },
    {
      id: "shortcuts",
      group: "App",
      title: "Keyboard shortcuts",
      description: "Every key the app answers to.",
      icon: Keyboard,
      cards: [
        {
          rows: keyboardShortcuts(mac, sendKey).map(([key, does]) => ({
            key: does,
            label: does,
            control: <kbd>{key}</kbd>,
          })),
        },
      ],
    },
    {
      id: "updates",
      group: "App",
      title: "Updates",
      description: "New releases of the desktop app.",
      icon: RefreshCw,
      cards: [
        {
          rows: [
            {
              key: "status",
              label: updateLine(status, checked),
              help:
                status.state === "off"
                  ? "A development or unsigned build does not update itself."
                  : "On a Mac, a new release downloads in the background and installs when you restart or quit. On Linux, you download it from its release page.",
              control: (
                <span className="settings-buttons">
                  {button && button.kind !== "progress" && (
                    <Button
                      className="primary"
                      disabled={updates.installing || button.busy}
                      onClick={updates.install}
                    >
                      {button.kind === "install" ? "Restart to update" : button.label}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="secondary"
                    disabled={status.state === "off" || working}
                    onClick={() => {
                      setChecked(true);
                      updates.check();
                    }}
                  >
                    Check for updates
                  </Button>
                </span>
              ),
            },
          ],
        },
      ],
      footer: updates.error && (
        <p className="field-error" role="alert">
          {updates.error}
        </p>
      ),
    },
    {
      id: "about",
      group: "App",
      title: "About",
      description: "The releases this window and its Gateway run.",
      icon: Info,
      cards: [
        {
          rows: [
            { key: "app", label: "SuperTag", help: "This app's release.", control: value(app) },
            {
              key: "gateway",
              label: "Gateway",
              help: differs
                ? "This Gateway runs another release than the app. Update whichever is older so they match."
                : "The Gateway this window is connected to, and the protocol version they agreed.",
              ...(differs ? { chip: "Another release" } : {}),
              control: value(
                activeName
                  ? [activeName, releaseText].filter(Boolean).join(" · ")
                  : "Not connected",
              ),
            },
          ],
        },
        {
          rows: [
            {
              key: "docs",
              label: "Documentation",
              help: "Guides, concepts and the reference, on GitHub.",
              control: link("Open", DOCS_URL),
            },
            {
              key: "notes",
              label: "Release notes",
              help: "What changed in each release.",
              control: link("Open", RELEASES_URL),
            },
          ],
        },
      ],
    },
    {
      id: "gateways",
      group: "SuperTag",
      title: "Gateways",
      description: "The Gateways this app knows, and the one it is connected to.",
      icon: Server,
      ...(saved.length === 0 && !connection
        ? { status: local?.problem ?? "No Gateway is saved yet." }
        : {}),
      cards: [
        {
          rows: [
            ...(connection && !connection.origin
              ? [
                  {
                    key: "preview",
                    label: "Preview workspace",
                    help: "Sample Tags, with no Gateway behind them.",
                    chip: "Connected",
                    control: (
                      <Button variant="outline" className="secondary" onClick={onDisconnect}>
                        Disconnect
                      </Button>
                    ),
                  },
                ]
              : []),
            ...saved.map((entry) => {
              const active = entry.origin === connection?.origin;
              const profile = gateways.profiles.find((saved) => saved.origin === entry.origin);
              return {
                key: entry.origin,
                label: entry.name,
                help: [entry.address, active && releaseText && `Release ${releaseText}`]
                  .filter(Boolean)
                  .join(" · "),
                ...(active ? { chip: "Connected" } : {}),
                control: (
                  <span className="settings-buttons">
                    {profile && (
                      <Button
                        variant="outline"
                        className="secondary"
                        aria-label={`Edit ${entry.name}`}
                        disabled={busy}
                        onClick={() => {
                          onPage(undefined);
                          onEditGateway(profile);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="secondary"
                      aria-label={`${active ? "Disconnect from" : "Connect to"} ${entry.name}`}
                      disabled={busy}
                      onClick={() => (active ? onDisconnect() : onSelectGateway(entry.origin))}
                    >
                      {active ? "Disconnect" : "Connect"}
                    </Button>
                  </span>
                ),
              };
            }),
          ],
          action: (
            <Button
              variant="outline"
              className="secondary"
              disabled={busy}
              onClick={() => {
                onPage(undefined);
                onEditGateway();
              }}
            >
              Add Gateway
            </Button>
          ),
        },
      ],
    },
    {
      id: "tags",
      group: "SuperTag",
      title: "Tags",
      description: "The Tags on this Gateway. Open one to see its instructions and activity.",
      icon: Tags,
      readOnly: {
        how: "Create a Tag with + in the sidebar. Change one in its manifest, with supertag apply.",
        docs: doc("guides/talk-to-a-tag.md"),
      },
      ...(connection
        ? shownTags.length === 0
          ? { status: "This Gateway has no Tags yet." }
          : {}
        : { status: "Connect to a Gateway to see its Tags." }),
      cards: [
        {
          rows: shownTags.map((tag) => ({
            key: tag.tagId,
            label: tag.name ?? tag.tagId,
            lead: <TagAvatar tag={tag} size="sm" />,
            ...(tag.lead ? { chip: "Lead" } : {}),
            help: [
              harnessLabel(tag.harnessKind) ?? tag.harnessKind,
              tag.workspace &&
                `Workspace ${tag.workspace.id}${tag.workspace.ref ? ` (${tag.workspace.ref})` : ""}`,
            ]
              .filter(Boolean)
              .join(" · "),
            control: onOpenTag && (
              <Button
                variant="outline"
                className="secondary"
                aria-label={`Open ${tag.name ?? tag.tagId}`}
                onClick={() => {
                  onPage(undefined);
                  onOpenTag(tag.tagId);
                }}
              >
                Open
              </Button>
            ),
          })),
        },
      ],
    },
    ...(gateway?.hostPhases || connection?.tagAdmin
      ? [
          {
            id: "hosts" as const,
            group: "SuperTag" as const,
            title: "Worker Hosts",
            description: "The machines that run this Gateway's Tags, and what they offer.",
            icon: Waypoints,
            readOnly: {
              how: "Add a Worker Host by enrolling a machine with the CLI.",
              docs: doc("guides/workers.md"),
            },
            cards: [
              {
                rows: [
                  ...(gateway?.hostPhases
                    ? [
                        {
                          key: "hosts",
                          label: "Hosts",
                          help: "How many Worker Hosts are in each state.",
                          control: value(
                            hosts.value
                              ? hostLine(hosts.value)
                              : hosts.failed
                                ? "Could not be read"
                                : "Loading…",
                          ),
                        },
                      ]
                    : []),
                  ...(connection?.tagAdmin
                    ? [
                        {
                          key: "harnesses",
                          label: "Harnesses",
                          help: "The harnesses a connected Worker Host runs.",
                          control: value(
                            offer.value
                              ? offer.value.harnesses
                                  .map((kind) => harnessLabel(kind) ?? kind)
                                  .join(", ") || "None"
                              : offer.failed
                                ? "Could not be read"
                                : "Loading…",
                          ),
                        },
                        {
                          key: "workspaces",
                          label: "Workspaces",
                          help: "The Workspaces a connected Worker Host has.",
                          control: value(
                            offer.value
                              ? offer.value.workspaces.join(", ") || "None"
                              : offer.failed
                                ? "Could not be read"
                                : "Loading…",
                          ),
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
        ]
      : []),
    {
      id: "permissions",
      group: "SuperTag",
      title: "Permissions",
      description: "What each Tag is allowed to do.",
      icon: ShieldCheck,
      readOnly: {
        how: "A Tag's allowed actions come from the Permission Sets its manifest names. Change them with supertag apply.",
        docs: doc("reference/resource-model.md"),
      },
      ...(connection
        ? shownTags.length === 0
          ? { status: "This Gateway has no Tags yet." }
          : {}
        : { status: "Connect to a Gateway to see its Tags' permissions." }),
      cards: shownTags.map((tag) => ({
        title: tag.name ?? tag.tagId,
        rows: tag.allowedActions.length
          ? tag.allowedActions.map((action) => ({ key: action, label: action }))
          : [{ key: "none", label: "No allowed actions" }],
      })),
    },
  ];

  const shown = pages.find((entry) => entry.id === page) ?? pages[0];
  const words = query.trim().toLocaleLowerCase();
  const matches = (entry: Page, card: Card, row: Row) =>
    [entry.title, card.title, row.label, row.help, row.chip]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(words);
  // While searching, every page's matching rows show together, each under its page's name.
  const found = words
    ? pages
        .map((entry) => ({
          ...entry,
          cards: entry.cards
            .map((card) => ({
              ...card,
              rows: card.rows.filter((row) => matches(entry, card, row)),
            }))
            .filter((card) => card.rows.length > 0),
        }))
        .filter((entry) => entry.cards.length > 0)
    : [];

  function move(event: ReactKeyboardEvent<HTMLButtonElement>, at: number) {
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % pages.length
        : event.key === "ArrowUp"
          ? (at + pages.length - 1) % pages.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? pages.length - 1
              : undefined;
    const next = to === undefined ? undefined : pages[to];
    if (!next) return;
    event.preventDefault();
    setQuery("");
    onPage(next.id);
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
  }

  const cards = (entry: Page) =>
    entry.cards.map((card, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a page's cards keep their order.
      <section key={index} className="settings-card" aria-label={card.title}>
        {card.title && <h4>{card.title}</h4>}
        {card.rows.map((row) => (
          <div key={row.key} className="settings-row">
            {row.lead}
            <div className="settings-row-text">
              <span className="settings-row-label">
                {row.label}
                {row.chip && <span className="settings-chip">{row.chip}</span>}
              </span>
              {row.help && <span className="settings-row-help">{row.help}</span>}
            </div>
            {row.control}
          </div>
        ))}
        {card.action && <div className="settings-row settings-card-action">{card.action}</div>}
      </section>
    ));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onPage(undefined)}>
      <DialogContent
        className="settings-dialog"
        // The dialog itself takes the focus, so Enter changes nothing by accident.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.current) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogTitle className="visually-hidden">Settings</DialogTitle>
        <DialogDescription className="visually-hidden">
          This app, this device, and the Gateway it is connected to.
        </DialogDescription>
        <div className="settings-nav">
          <label className="settings-search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {/* A narrow window shows the pages as one select in place of the list. */}
          <select
            className="settings-page-select"
            aria-label="Settings page"
            value={shown?.id}
            onChange={(event) => {
              setQuery("");
              onPage(event.target.value as SettingsPageId);
            }}
          >
            {pages.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
          <div className="settings-tabs" role="tablist" aria-orientation="vertical">
            {(["App", "SuperTag"] as const).map((group) => (
              <div key={group} className="settings-group" role="presentation">
                <span className="settings-group-label" aria-hidden>
                  {group}
                </span>
                {pages.map(
                  (entry, index) =>
                    entry.group === group && (
                      <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        id={`${id}-tab-${entry.id}`}
                        aria-controls={`${id}-panel`}
                        aria-selected={!words && entry.id === shown?.id}
                        tabIndex={entry.id === shown?.id ? 0 : -1}
                        data-dimmed={
                          (words && !found.some((hit) => hit.id === entry.id)) || undefined
                        }
                        onClick={() => {
                          setQuery("");
                          onPage(entry.id);
                        }}
                        onKeyDown={(event) => move(event, index)}
                      >
                        <entry.icon size={15} aria-hidden />
                        {entry.title}
                      </button>
                    ),
                )}
              </div>
            ))}
          </div>
        </div>
        <div
          className="settings-page"
          role="tabpanel"
          id={`${id}-panel`}
          aria-label={words ? "Search results" : shown?.title}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard reaches the page to scroll it.
          tabIndex={0}
        >
          {words ? (
            <>
              <h2>Search</h2>
              <p className="settings-description" role="status">
                {found.length
                  ? `Settings matching "${query.trim()}".`
                  : `Nothing matches "${query.trim()}".`}
              </p>
              {found.map((entry) => (
                <div key={entry.id} className="settings-found">
                  <h3>{entry.title}</h3>
                  {cards(entry)}
                </div>
              ))}
            </>
          ) : (
            shown && (
              <>
                <h2>{shown.title}</h2>
                <p className="settings-description">{shown.description}</p>
                {shown.readOnly && (
                  <p className="settings-readonly">
                    <span className="settings-chip">Read-only</span>
                    <span>{shown.readOnly.how}</span>
                    <Button
                      variant="link"
                      className="settings-link"
                      onClick={() => shown.readOnly && openExternal(shown.readOnly.docs)}
                    >
                      Documentation
                    </Button>
                  </p>
                )}
                {shown.status ? (
                  <p className="settings-status" role="status">
                    {shown.status}
                  </p>
                ) : (
                  cards(shown)
                )}
                {shown.id === "gateways" && shown.status && shown.cards[0]?.action}
                {shown.footer}
              </>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
