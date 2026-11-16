import "@fontsource-variable/geist";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionDialog } from "./components/connection";
import { ControlPlaneSelector } from "./components/control-plane-selector";
import { EmptyWorkspace, Workspace, WorkspaceShell } from "./components/workspace";
import {
  type ControlPlane,
  type ControlPlaneActivation,
  type ControlPlaneList,
  type ControlPlaneProfile,
  controlPlaneSession,
  LOCAL_CONTROL_PLANE,
  nativeControlPlane,
  type Tag,
} from "./control-plane";
import { describe } from "./lib/polling";
import "./shadcn.css";
import "./style.css";

interface Connection {
  controlPlane: ControlPlane;
  tags: Tag[];
  preview: boolean;
  id?: string;
  origin?: string;
  principal?: string;
}

function App({ initialConnection }: { initialConnection?: Connection }) {
  const [connection, setConnection] = useState(initialConnection);
  const [controlPlanes, setControlPlanes] = useState<ControlPlaneList>({ profiles: [] });
  const [editor, setEditor] = useState<{ profile?: ControlPlaneProfile }>();
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(!initialConnection);
  const [writing, setWriting] = useState(false);
  const pendingSwitch = useRef(!initialConnection);
  const pendingWrites = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const activate = useCallback(
    ({ controlPlanes, origin, connectionId, tags, principal }: ControlPlaneActivation) => {
      setControlPlanes(controlPlanes);
      setConnection({
        controlPlane: controlPlaneSession(connectionId),
        tags,
        preview: false,
        id: connectionId,
        origin,
        principal,
      });
    },
    [],
  );

  useEffect(() => {
    if (initialConnection) return;
    let live = true;
    async function restore() {
      try {
        const saved = await nativeControlPlane.list();
        if (!live) return;
        setControlPlanes(saved);
        // The last saved Control Plane used wins; with none, the local one when it runs.
        const next = saved.active
          ? await nativeControlPlane.select(saved.active)
          : saved.local?.origin
            ? await nativeControlPlane.connectLocal()
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

  function open(profile?: ControlPlaneProfile, button = trigger.current) {
    if (pendingSwitch.current || pendingWrites.current > 0) return;
    opener.current = button;
    setError("");
    setEditor({ profile });
  }

  function clear(forget?: string) {
    return change(async () => {
      if (connection?.preview && !forget) {
        setConnection(undefined);
        setControlPlanes(await nativeControlPlane.list());
        return;
      }
      setControlPlanes(await nativeControlPlane.clear(forget));
      if (!forget || forget === connection?.origin) setConnection(undefined);
      setEditor(undefined);
    });
  }

  const selector = (
    <ControlPlaneSelector
      active={connection?.origin}
      principal={connection?.principal}
      profiles={controlPlanes.profiles}
      local={controlPlanes.local}
      preview={connection?.preview}
      busy={writing}
      switching={switching}
      trigger={trigger}
      onSelect={(origin) => {
        if (origin === connection?.origin) return;
        void change(async () =>
          activate(
            await (origin === LOCAL_CONTROL_PLANE
              ? nativeControlPlane.connectLocal()
              : nativeControlPlane.select(origin)),
          ),
        );
      }}
      onEdit={open}
      onDisconnect={() => void clear()}
      onOpen={() => {
        if (pendingSwitch.current || connection?.preview) return;
        // A local Control Plane started or stopped since the list was read shows as it is now.
        nativeControlPlane.list().then(setControlPlanes, () => {});
      }}
    />
  );

  return (
    <>
      {connection ? (
        <Workspace
          key={connection.id ?? "preview"}
          connectionId={connection.id}
          controlPlane={connection.controlPlane}
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
            localProblem={controlPlanes.local?.problem}
            onLocal={
              controlPlanes.local?.origin
                ? () => void change(async () => activate(await nativeControlPlane.connectLocal()))
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
              activate(await nativeControlPlane.save(address, name, token));
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
    const { previewControlPlane } = await import("./preview");
    initialConnection = {
      controlPlane: previewControlPlane,
      tags: await previewControlPlane.tags(),
      preview: true,
    };
  }
  createRoot(target).render(<App initialConnection={initialConnection} />);
}

void start();
