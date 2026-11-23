import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist";
import {
  cacheScope,
  describe,
  type Gateway,
  type GatewayActivation,
  type GatewayList,
  type GatewayProfile,
  type GatewayRelease,
  LOCAL_GATEWAY,
  type LocalUpgrade,
  type RestartStep,
  type Tag,
  type TagAdmin,
  tagAdminRefusal,
} from "@supertag/client/model";
import { PlatformProvider } from "@supertag/client/react";
import { Keyboard, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { commandKeyLabel } from "./components/command-palette";
import { ConnectionDialog } from "./components/connection";
import { GatewaySelector, gatewayActions } from "./components/gateway-selector";
import { LocalUpgradeOffer } from "./components/local-upgrade";
import { Onboarding } from "./components/onboarding";
import {
  isSettingsShortcut,
  pendingPage,
  SettingsButton,
  SettingsDialog,
  type SettingsPageId,
} from "./components/settings";
import { onMac, type SidebarMode } from "./components/sidebar";
import {
  nativeUpdates,
  UpdateBanner,
  UpdateButton,
  type UpdateSource,
  useUpdates,
} from "./components/update";
import { APP_VERSION } from "./components/version";
import { EmptyWorkspace, Workspace, WorkspaceShell } from "./components/workspace";
import { desktop } from "./desktop";
import { gatewaySession, nativeGateway, nativeSetup, type SetupCheck } from "./gateway";
import { useNotificationLevel } from "./lib/notifications";
import { windowPlatform } from "./lib/platform";
import { startup } from "./startup";
import { tagAdminSession } from "./tag-admin";
import "./shadcn.css";
import "./style.css";

interface Connection {
  gateway: Gateway;
  tags: Tag[];
  preview: boolean;
  id?: string;
  origin?: string;
  principal?: string;
  /** The Gateway's release, which the sidebar names when it differs from the app's. */
  release?: GatewayRelease;
  /** Creates Tags, when this connection's principal may. */
  tagAdmin?: TagAdmin;
}

/** How often a window connected to the local Gateway checks that it still runs where it did. */
const LOCAL_CHECK_MS = 3_000;

const noGateways: GatewayList = { profiles: [] };

function App({
  initialConnection,
  initialGateways = noGateways,
  updateSource = nativeUpdates,
}: {
  initialConnection?: Connection;
  /** The saved Gateways the preview shows in the Gateway menu. */
  initialGateways?: GatewayList;
  updateSource?: UpdateSource;
}) {
  const [connection, setConnection] = useState(initialConnection);
  const updates = useUpdates(updateSource);
  const [gateways, setGateways] = useState<GatewayList>(initialGateways);
  const [editor, setEditor] = useState<{ profile?: GatewayProfile }>();
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(!initialConnection);
  // A later launch whose local services were stopped starts them before connecting.
  const [starting, setStarting] = useState(false);
  const [writing, setWriting] = useState(false);
  const pendingSwitch = useRef(!initialConnection);
  const pendingWrites = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [notifications, setNotifications] = useNotificationLevel();
  // Settings shows one page; none while it is closed. It reopens on the page it was left on.
  const [settings, setSettings] = useState<SettingsPageId>();
  const lastPage = useRef<SettingsPageId>("general");
  const [inspect, setInspect] = useState<{ tagId: string; at: number }>();
  const gear = useRef<HTMLButtonElement>(null);
  const showSettings = useCallback((page?: SettingsPageId) => {
    if (page) lastPage.current = page;
    setSettings(page);
  }, []);
  // What waits in Settings: the gear's dot, and the page the gear opens while it shows.
  const pending = pendingPage(updates.status, APP_VERSION, connection?.release);
  const waiting = useRef(pending);
  waiting.current = pending;
  const openSettings = useCallback(
    (page?: SettingsPageId) => showSettings(page ?? waiting.current ?? lastPage.current),
    [showSettings],
  );
  // Settings opens from its gear, from the app menu, and with ⌘, (Ctrl+, outside macOS).
  useEffect(() => {
    const mac = onMac();
    function onKey(event: KeyboardEvent) {
      if (!isSettingsShortcut(event, mac)) return;
      event.preventDefault();
      openSettings();
    }
    window.addEventListener("keydown", onKey);
    const stop = desktop().onOpenSettings?.(() => openSettings());
    return () => {
      window.removeEventListener("keydown", onKey);
      stop?.();
    };
  }, [openSettings]);
  // "Check for Updates…" in the app menu shows its answer on the Updates page.
  const checking = updates.status.state === "checking" && updates.status.manual;
  useEffect(() => {
    if (checking) showSettings("updates");
  }, [checking, showSettings]);
  /** First launch, with no SuperTag set up here: the setup screen, from the first check. */
  const [setup, setSetup] = useState<{ check: SetupCheck }>();
  /** The address of the local Gateway this window connected to, while it is connected to it. */
  const localAddress = useRef<string | undefined>(undefined);
  /** The older release the local Gateway runs, when connecting to it was refused for that. */
  const [upgrade, setUpgrade] = useState<LocalUpgrade>();
  /** The step a restart of the local services with the app's CLI is on, while it runs. */
  const [restartStep, setRestartStep] = useState<RestartStep>();
  const [restartError, setRestartError] = useState("");

  /** Connects to the local Gateway. When it refuses, finds out whether it runs an older
   * release the app can restart with its own, so the window can offer that. */
  const connectLocal = useCallback(async () => {
    try {
      const activation = await nativeGateway.connectLocal();
      setUpgrade(undefined);
      return activation;
    } catch (error) {
      setUpgrade((await nativeGateway.localUpgrade().catch(() => null)) ?? undefined);
      throw error;
    }
  }, []);

  const activate = useCallback(
    ({ gateways, origin, connectionId, tags, principal, release }: GatewayActivation) => {
      localAddress.current = origin === LOCAL_GATEWAY ? gateways.local?.origin : undefined;
      setGateways(gateways);
      setConnection({
        gateway: gatewaySession(connectionId, cacheScope(origin, principal), principal),
        tags,
        preview: false,
        id: connectionId,
        origin,
        principal,
        release,
        tagAdmin: tagAdminRefusal(principal)
          ? undefined
          : tagAdminSession(connectionId, origin === LOCAL_GATEWAY),
      });
    },
    [],
  );

  useEffect(() => {
    if (initialConnection) return;
    let live = true;
    async function restore() {
      try {
        const first = await startup(
          {
            list: nativeGateway.list,
            localStartNeeded: nativeGateway.localStartNeeded,
            updatePending: nativeGateway.updatePending,
            startLocal: nativeGateway.startLocal,
            select: nativeGateway.select,
            connectLocal,
            check: () => nativeSetup.check(),
          },
          { gateways: setGateways, starting: setStarting, live: () => live },
        );
        if (!live) return;
        if (first.activation) activate(first.activation);
        else if (first.setup) setSetup({ check: first.setup });
      } catch (error) {
        if (live) setError(describe(error));
      } finally {
        if (live) {
          pendingSwitch.current = false;
          setSwitching(false);
        }
      }
    }
    void restore();
    return () => {
      live = false;
    };
  }, [activate, connectLocal, initialConnection]);

  // `supertag up` starts the local Gateway on a new address each time, so a window connected to
  // it follows it: it checks the state directory every few seconds, shows when the Gateway is
  // stopped, and reconnects to the one running now.
  const connectedOrigin = connection?.origin;
  useEffect(() => {
    if (connectedOrigin !== LOCAL_GATEWAY) return;
    const timer = setInterval(() => {
      if (pendingSwitch.current || pendingWrites.current > 0) return;
      nativeGateway.list().then(
        (list) => {
          setGateways(list);
          const running = list.local?.origin;
          if (!running || running === localAddress.current || pendingSwitch.current) return;
          // As `change` does, but quietly: a failed attempt is tried again on the next check.
          pendingSwitch.current = true;
          setSwitching(true);
          nativeGateway
            .connectLocal()
            .then(activate, () => {})
            .finally(() => {
              pendingSwitch.current = false;
              setSwitching(false);
            });
        },
        () => {},
      );
    }, LOCAL_CHECK_MS);
    return () => clearInterval(timer);
  }, [connectedOrigin, activate]);

  const updateWrites = useCallback((delta: 1 | -1) => {
    pendingWrites.current += delta;
    setWriting(pendingWrites.current > 0);
  }, []);

  async function change(run: () => Promise<void>) {
    if (pendingSwitch.current || pendingWrites.current > 0) return;
    pendingSwitch.current = true;
    setSwitching(true);
    setError("");
    try {
      await run();
    } catch (error) {
      setError(describe(error));
    } finally {
      pendingSwitch.current = false;
      setSwitching(false);
    }
  }

  /** Restarts the local services with the app's own CLI, then connects to them. */
  async function restartLocal() {
    if (pendingSwitch.current || pendingWrites.current > 0) return;
    pendingSwitch.current = true;
    setError("");
    setRestartError("");
    try {
      await nativeGateway.restartLocal(setRestartStep);
    } catch (error) {
      setRestartError(describe(error));
      pendingSwitch.current = false;
      setRestartStep(undefined);
      return;
    }
    setRestartStep(undefined);
    setSwitching(true);
    try {
      const list = await nativeGateway.list();
      setGateways(list);
      activate(await connectLocal());
    } catch (error) {
      setError(describe(error));
    } finally {
      pendingSwitch.current = false;
      setSwitching(false);
    }
  }

  function open(profile?: GatewayProfile, button = trigger.current) {
    if (pendingSwitch.current || pendingWrites.current > 0) return;
    opener.current = button;
    setError("");
    setEditor({ profile });
  }

  function clear(forget?: string) {
    return change(async () => {
      if (connection?.preview && !forget) {
        setConnection(undefined);
        setGateways(await nativeGateway.list());
        return;
      }
      setGateways(await nativeGateway.clear(forget));
      if (!forget || forget === connection?.origin) setConnection(undefined);
      setEditor(undefined);
    });
  }

  const menu = {
    active: connection?.origin,
    profiles: gateways.profiles,
    local: gateways.local,
    preview: connection?.preview,
    busy: writing,
    switching,
    onSelect: (origin: string) => {
      if (origin === connection?.origin) return;
      void change(async () =>
        activate(await (origin === LOCAL_GATEWAY ? connectLocal() : nativeGateway.select(origin))),
      );
    },
    onEdit: (profile?: GatewayProfile) => open(profile),
    onDisconnect: () => void clear(),
  };
  // The command palette offers what the Gateway menu and Settings do.
  const actions = [
    ...gatewayActions({
      ...menu,
      notifications,
      onNotifications: setNotifications,
    }),
    {
      id: "settings",
      label: "Settings",
      caption: "this app, this device, Gateways",
      icon: <SettingsIcon aria-hidden />,
      shortcut: commandKeyLabel(","),
      keywords: "preferences about version update",
      run: () => openSettings(),
    },
    {
      id: "keyboard-shortcuts",
      label: "Keyboard shortcuts",
      caption: "every key the app answers to",
      icon: <Keyboard aria-hidden />,
      keywords: "keys help",
      run: () => openSettings("shortcuts"),
    },
  ];
  const selector = (mode: SidebarMode) => (
    <GatewaySelector
      {...menu}
      wide={mode === "expanded"}
      principal={connection?.principal}
      onManage={() => openSettings("gateways")}
      trigger={trigger}
      onOpen={() => {
        if (pendingSwitch.current || connection?.preview) return;
        // A local Gateway started or stopped since the list was read shows as it is now.
        nativeGateway.list().then(setGateways, () => {});
      }}
    />
  );
  const sidebarFooter = (mode: SidebarMode) => (
    <>
      <UpdateButton updates={updates} wide={mode === "expanded"} />
      <SettingsButton button={gear} pending={pending !== undefined} onOpen={() => openSettings()} />
    </>
  );

  return (
    <>
      {connection ? (
        <Workspace
          key={connection.id ?? "preview"}
          connectionId={connection.id}
          gateway={connection.gateway}
          initialTags={connection.tags}
          selector={selector}
          sidebarFooter={sidebarFooter}
          draftScope={connection.origin ?? "preview"}
          tagAdmin={connection.tagAdmin}
          newTagRefusal={tagAdminRefusal(connection.principal)}
          actions={actions}
          switching={switching}
          connectionError={editor ? "" : error}
          onWriteChange={updateWrites}
          inspect={inspect}
        />
      ) : (
        <WorkspaceShell
          tags={[]}
          connected={false}
          selector={selector}
          sidebarFooter={sidebarFooter}
          actions={actions}
          switching={switching}
          // The restart offer says why the local Gateway was refused.
          error={editor || upgrade ? "" : error}
        >
          {setup ? (
            <div className="work-area">
              <Onboarding
                api={nativeSetup}
                initial={setup.check}
                onReady={() =>
                  void change(async () => {
                    activate(await connectLocal());
                    setSetup(undefined);
                  })
                }
              />
            </div>
          ) : (
            <EmptyWorkspace
              switching={switching}
              starting={starting}
              onSettings={(event) => open(undefined, event.currentTarget)}
              localProblem={gateways.local?.problem}
              onLocal={
                gateways.local?.origin
                  ? () => void change(async () => activate(await connectLocal()))
                  : undefined
              }
              localUpgrade={
                upgrade && (
                  <LocalUpgradeOffer
                    upgrade={upgrade}
                    step={restartStep}
                    error={restartError}
                    onRestart={() => void restartLocal()}
                  />
                )
              }
            />
          )}
        </WorkspaceShell>
      )}
      {editor && (
        <ConnectionDialog
          profile={editor.profile}
          busy={switching}
          error={error}
          opener={opener}
          onClose={() => {
            setEditor(undefined);
            setError("");
          }}
          onSave={(address, name, token) =>
            void change(async () => {
              activate(await nativeGateway.save(address, name, token));
              setEditor(undefined);
            })
          }
          onForget={(origin) => void clear(origin)}
        />
      )}
      <SettingsDialog
        page={settings}
        onPage={showSettings}
        connection={connection}
        gateways={gateways}
        busy={switching || writing}
        onSelectGateway={menu.onSelect}
        onEditGateway={(profile) => open(profile, gear.current)}
        onDisconnect={menu.onDisconnect}
        updates={updates}
        notifications={notifications}
        onNotifications={setNotifications}
        onOpenTag={(tagId) => setInspect({ tagId, at: Date.now() })}
        returnFocus={gear}
      />
      <UpdateBanner updates={updates} />
    </>
  );
}

async function start() {
  // On macOS the title bar overlays the window (electron/main.ts), so the rail leaves room for
  // the window controls. Other platforms keep their native title bar.
  if (navigator.userAgent.includes("Macintosh"))
    document.documentElement.dataset.titlebar = "overlay";
  const target = document.getElementById("app");
  if (!target) throw new Error("Desktop root is missing");
  let initialConnection: Connection | undefined;
  let updateSource: UpdateSource | undefined;
  let initialGateways: GatewayList | undefined;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("preview")) {
    const {
      previewGateway,
      previewGateways,
      previewRelease,
      previewTagAdmin,
      previewUpdates,
      withManyTags,
      withoutLead,
    } = await import("./preview");
    // `?preview&update=ready` shows an update in that state: downloading, ready, installing,
    // available (Linux), error (a download's), install-error, or check-error.
    updateSource = previewUpdates(new URLSearchParams(location.search).get("update"));
    // `?preview&nolead` shows a Gateway without a lead Tag.
    if (new URLSearchParams(location.search).has("nolead")) withoutLead();
    // `?preview&many` shows a long sidebar: more Tags, long names and previews, every row state.
    if (new URLSearchParams(location.search).has("many")) withManyTags();
    initialConnection = {
      gateway: previewGateway,
      tags: await previewGateway.tags(),
      preview: true,
      // `?preview&gateway=0.3.3` shows a Gateway of another release.
      release: previewRelease(new URLSearchParams(location.search).get("gateway")),
      tagAdmin: previewTagAdmin,
    };
    // `?preview&gateways` shows two saved Gateways with their addresses, the first one selected.
    if (new URLSearchParams(location.search).has("gateways")) {
      initialGateways = previewGateways;
      initialConnection.origin = previewGateways.profiles[0]?.origin;
    }
  }
  createRoot(target).render(
    <PlatformProvider value={windowPlatform}>
      <App
        initialConnection={initialConnection}
        initialGateways={initialGateways}
        updateSource={updateSource}
      />
    </PlatformProvider>,
  );
}

void start();
