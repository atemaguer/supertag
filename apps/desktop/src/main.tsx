import "@fontsource-variable/geist";
import { type MouseEvent, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionDialog } from "./components/connection";
import { EmptyWorkspace, Workspace, WorkspaceShell } from "./components/workspace";
import { type Gateway, nativeGateway, type Tag } from "./gateway";
import "./shadcn.css";
import "./style.css";

interface Connection {
  gateway: Gateway;
  tags: Tag[];
  preview: boolean;
  id?: string;
}

function App({ initialConnection }: { initialConnection?: Connection }) {
  const [connection, setConnection] = useState(initialConnection);
  const [settings, setSettings] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingWrites = useRef(0);
  const opener = useRef<HTMLButtonElement>(null);

  const updateWrites = useCallback((delta: 1 | -1) => {
    pendingWrites.current += delta;
    setBusy(pendingWrites.current > 0);
  }, []);

  function openSettings(event: MouseEvent<HTMLButtonElement>) {
    if (pendingWrites.current > 0) return;
    opener.current = event.currentTarget;
    if (connection?.preview) setConnection(undefined);
    setSettings(true);
  }

  return (
    <>
      {connection ? (
        <Workspace
          key={connection.id ?? "preview"}
          connectionId={connection.id}
          gateway={connection.gateway}
          initialTags={connection.tags}
          preview={connection.preview}
          busy={busy}
          onSettings={openSettings}
          onWriteChange={updateWrites}
        />
      ) : (
        <WorkspaceShell tags={[]} connected={false} busy={false} onSettings={openSettings}>
          <EmptyWorkspace connected={false} onSettings={openSettings} />
        </WorkspaceShell>
      )}
      <ConnectionDialog
        open={settings}
        address={address}
        connected={Boolean(connection)}
        opener={opener}
        onClose={() => setSettings(false)}
        onReset={() => setConnection(undefined)}
        onConnect={(nextAddress, tags, id) => {
          setAddress(nextAddress);
          setConnection({ gateway: nativeGateway, tags, preview: false, id });
          setSettings(false);
        }}
      />
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
