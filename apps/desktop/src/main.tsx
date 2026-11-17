import "@fontsource-variable/geist";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionDialog } from "./components/connection";
import { GatewaySelector, gatewayActions } from "./components/gateway-selector";
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

function App({ initialConnection }: { initialConnection?: Connection }) {
  const [connection, setConnection] = useState(initialConnection);
  const [gateways, setGateways] = useState<GatewayList>({ profiles: [] });
  const [editor, setEditor] = useState<{ profile?: GatewayProfile }>();
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(!initialConnection);
  const [writing, setWriting] = useState(false);
  const pendingSwitch = useRef(!initialConnection);
  const pendingWrites = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [notifications, setNotifications] = useNotificationLevel();

  const activate = useCallback(
    ({ gateways, origin, connectionId, tags, principal }: GatewayActivation) => {
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
        const saved = await nativeGateway.list();
        if (!live) return;
        setGateways(saved);
        // The last saved Gateway used wins; with none, the local one when it runs.
        const next = saved.active
          ? await nativeGateway.select(saved.active)
          : saved.local?.origin
            ? await nativeGateway.connectLocal()
            : undefined;
        if (live && next) activate(next);
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
          <EmptyWorkspace
            switching={switching}
            onSettings={(event) => open(undefined, event.currentTarget)}
            localProblem={gateways.local?.problem}
            onLocal={
              gateways.local?.origin
                ? () => void change(async () => activate(await nativeGateway.connectLocal()))
                : undefined
            }
          />
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
