import "@fontsource-variable/geist";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionDialog } from "./components/connection";
import { GatewaySelector } from "./components/gateway-selector";
import { EmptyWorkspace, Workspace, WorkspaceShell } from "./components/workspace";
import {
  type Gateway,
  type GatewayActivation,
  type GatewayList,
  type GatewayProfile,
  gatewaySession,
  nativeGateway,
  type Tag,
} from "./gateway";
import { describe } from "./lib/polling";
import "./shadcn.css";
import "./style.css";

interface Connection {
  gateway: Gateway;
  tags: Tag[];
  preview: boolean;
  id?: string;
  origin?: string;
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

  const activate = useCallback(({ gateways, connectionId, tags }: GatewayActivation) => {
    setGateways(gateways);
    setConnection({
      gateway: gatewaySession(connectionId),
      tags,
      preview: false,
      id: connectionId,
      origin: gateways.active ?? undefined,
    });
  }, []);

  useEffect(() => {
    if (initialConnection) return;
    let live = true;
    async function restore() {
      try {
        const saved = await nativeGateway.list();
        if (!live) return;
        setGateways(saved);
        if (saved.active) {
          const next = await nativeGateway.select(saved.active);
          if (live) activate(next);
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

  const selector = (
    <GatewaySelector
      active={connection?.origin}
      profiles={gateways.profiles}
      preview={connection?.preview}
      busy={writing}
      switching={switching}
      trigger={trigger}
      onSelect={(origin) => {
        if (origin !== connection?.origin)
          void change(async () => activate(await nativeGateway.select(origin)));
      }}
      onEdit={open}
      onDisconnect={() => void clear()}
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
          switching={switching}
          connectionError={editor ? "" : error}
          onWriteChange={updateWrites}
        />
      ) : (
        <WorkspaceShell
          tags={[]}
          connected={false}
          selector={selector}
          switching={switching}
          error={editor ? "" : error}
        >
          <EmptyWorkspace
            switching={switching}
            onSettings={(event) => open(undefined, event.currentTarget)}
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
  const target = document.getElementById("app");
  if (!target) throw new Error("Desktop root is missing");
  let initialConnection: Connection | undefined;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("preview")) {
    const { previewGateway } = await import("./preview");
    initialConnection = {
      gateway: previewGateway,
      tags: await previewGateway.tags(),
      preview: true,
    };
  }
  createRoot(target).render(<App initialConnection={initialConnection} />);
}

void start();
