import "@fontsource-variable/geist";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionDialog } from "./components/connection";
import { GatewaySelector, gatewayActions } from "./components/gateway-selector";
import { Onboarding } from "./components/onboarding";
import type { SidebarMode } from "./components/sidebar";
import { EmptyWorkspace, Workspace, WorkspaceShell } from "./components/workspace";
import {
  cacheScope,
  type Gateway,
  type GatewayActivation,
  type GatewayList,
  type GatewayProfile,
  gatewaySession,
  LOCAL_GATEWAY,
  nativeGateway,
  nativeSetup,
  type SetupCheck,
  type Tag,
} from "./gateway";
import { useNotificationLevel } from "./lib/notifications";
import { describe } from "./lib/polling";
import { type TagAdmin, tagAdminRefusal, tagAdminSession } from "./tag-admin";
import "./shadcn.css";
import "./style.css";

interface Connection {
  gateway: Gateway;
  tags: Tag[];
  preview: boolean;
  id?: string;
  origin?: string;
  principal?: string;
  /** Creates Tags, when this connection's principal may. */
  tagAdmin?: TagAdmin;
}

/** How often a window connected to the local Gateway checks that it still runs where it did. */
const LOCAL_CHECK_MS = 3_000;

function App({ initialConnection }: { initialConnection?: Connection }) {
  const [connection, setConnection] = useState(initialConnection);
  const [gateways, setGateways] = useState<GatewayList>({ profiles: [] });
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
  /** First launch, with no SuperTag set up here: the setup screen, from the first check. */
  const [setup, setSetup] = useState<{ check: SetupCheck }>();
  /** The address of the local Gateway this window connected to, while it is connected to it. */
  const localAddress = useRef<string | undefined>(undefined);

  const activate = useCallback(
    ({ gateways, origin, connectionId, tags, principal }: GatewayActivation) => {
      localAddress.current = origin === LOCAL_GATEWAY ? gateways.local?.origin : undefined;
      setGateways(gateways);
      setConnection({
        gateway: gatewaySession(connectionId, cacheScope(origin, principal)),
        tags,
        preview: false,
        id: connectionId,
        origin,
        principal,
        tagAdmin: tagAdminRefusal(principal) ? undefined : tagAdminSession(connectionId),
      });
    },
    [],
  );

  useEffect(() => {
    if (initialConnection) return;
    let live = true;
    async function restore() {
      try {
        let saved = await nativeGateway.list();
        if (!live) return;
        setGateways(saved);
        // SuperTag set up on this machine, its services stopped: start them, then connect.
        if (!saved.active && !saved.local?.origin && (await nativeGateway.localStartNeeded())) {
          setStarting(true);
          try {
            await nativeGateway.startLocal();
          } finally {
            if (live) setStarting(false);
          }
          saved = await nativeGateway.list();
          if (!live) return;
          setGateways(saved);
        }
        // The last saved Gateway used wins; with none, the local one when it runs.
        const next = saved.active
          ? await nativeGateway.select(saved.active)
          : saved.local?.origin
            ? await nativeGateway.connectLocal()
            : undefined;
        if (live && next) activate(next);
        // No Gateway at all, and no SuperTag set up here to start: set it up.
        if (live && !next && saved.profiles.length === 0) {
          const check = await nativeSetup.check();
          if (live && !check.state?.configured) setSetup({ check });
        }
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
  }, [activate, initialConnection]);

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
        activate(
          await (origin === LOCAL_GATEWAY
            ? nativeGateway.connectLocal()
            : nativeGateway.select(origin)),
        ),
      );
    },
    onEdit: (profile?: GatewayProfile) => open(profile),
    onDisconnect: () => void clear(),
  };
  // The command palette offers what the Gateway menu does.
  const actions = gatewayActions({
    ...menu,
    notifications,
    onNotifications: setNotifications,
  });

  const selector = (mode: SidebarMode) => (
    <GatewaySelector
      {...menu}
      wide={mode === "expanded"}
      principal={connection?.principal}
      trigger={trigger}
      onOpen={() => {
        if (pendingSwitch.current || connection?.preview) return;
        // A local Gateway started or stopped since the list was read shows as it is now.
        nativeGateway.list().then(setGateways, () => {});
      }}
    />
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
          draftScope={connection.origin ?? "preview"}
          tagAdmin={connection.tagAdmin}
          newTagRefusal={tagAdminRefusal(connection.principal)}
          actions={actions}
          switching={switching}
          connectionError={editor ? "" : error}
          onWriteChange={updateWrites}
        />
      ) : (
        <WorkspaceShell
          tags={[]}
          connected={false}
          selector={selector}
          actions={actions}
          switching={switching}
          error={editor ? "" : error}
        >
          {setup ? (
            <div className="work-area">
              <Onboarding
                api={nativeSetup}
                initial={setup.check}
                onReady={() =>
                  void change(async () => {
                    activate(await nativeGateway.connectLocal());
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
                  ? () => void change(async () => activate(await nativeGateway.connectLocal()))
                  : undefined
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
    </>
  );
}

async function start() {
  // On macOS the title bar overlays the window (tauri.conf.json), so the rail leaves room for the
  // window controls. Other platforms keep their native title bar.
  if (navigator.userAgent.includes("Macintosh"))
    document.documentElement.dataset.titlebar = "overlay";
  const target = document.getElementById("app");
  if (!target) throw new Error("Desktop root is missing");
  let initialConnection: Connection | undefined;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("preview")) {
    const { previewGateway, previewTagAdmin, withoutLead } = await import("./preview");
    // `?preview&nolead` shows a Gateway without a lead Tag.
    if (new URLSearchParams(location.search).has("nolead")) withoutLead();
    initialConnection = {
      gateway: previewGateway,
      tags: await previewGateway.tags(),
      preview: true,
      tagAdmin: previewTagAdmin,
    };
  }
  createRoot(target).render(<App initialConnection={initialConnection} />);
}

void start();
