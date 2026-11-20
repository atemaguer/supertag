/**
 * The Gateway chooser (Ctrl-P): Local, as `supertag up` runs it (its token is read at every
 * connect and never saved), and the Gateways saved with `supertag connect` or in the desktop
 * app. Enter switches, which ends every call and stream of the current one; `a` adds one; `d`
 * forgets a saved one (`supertag disconnect`, or the desktop app's store) and its cache. Adding
 * takes a name, the URL, an Operator Token or a client Auth Key (which enrolls this device), and
 * optional TLS files, and saves with `supertag connect`, the CLI's own store.
 */
import { describe } from "@supertag/client/model";
import { useEffect, useState } from "react";
import type { Connections, GatewayDraft, GatewayEntry } from "./connection";
import { clip, safe } from "./text";
import { color, type KeyEvent, MaskedField, pasteOnOneLine, useKeyboard } from "./ui";

const FIELDS = [
  { key: "name", label: "Name", placeholder: "work" },
  { key: "url", label: "URL", placeholder: "https://supertag.example.com" },
  { key: "token", label: "Token", placeholder: "Operator Token or client Auth Key (stak_…)" },
  { key: "serverCaFile", label: "CA file", placeholder: "optional: PEM of a private CA" },
  { key: "clientCertFile", label: "Client cert", placeholder: "optional: for mutual TLS" },
  { key: "clientKeyFile", label: "Client key", placeholder: "optional: its private key" },
] as const;
type Field = (typeof FIELDS)[number]["key"];

export function Gateways({
  connections,
  current,
  width,
  onOpen,
  onClose,
  onForgot,
}: {
  connections: Connections;
  current: string | undefined;
  width: number;
  onOpen(entry: GatewayEntry): void;
  onClose(): void;
  /** A saved Gateway was forgotten: the current one, if it was. */
  onForgot?(entry: GatewayEntry): void;
}) {
  const [entries, setEntries] = useState<GatewayEntry[] | undefined>();
  const [index, setIndex] = useState(0);
  /** The add form is open: empty for `a`, filled for `s` and `e`. */
  const [adding, setAdding] = useState<Partial<GatewayDraft> | undefined>();
  const [problem, setProblem] = useState("");
  const [forgetting, setForgetting] = useState<GatewayEntry | undefined>();
  const [busy, setBusy] = useState(false);
  async function forget(entry: GatewayEntry) {
    setBusy(true);
    setProblem("");
    try {
      await connections.forget(entry);
      setEntries(await connections.entries());
      setIndex(0);
      onForgot?.(entry);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
      setForgetting(undefined);
    }
  }
  useEffect(() => {
    let stopped = false;
    void connections.entries().then((listed) => {
      if (stopped) return;
      setEntries(listed);
      const at = listed.findIndex((entry) => entry.id === current);
      if (at >= 0) setIndex(at);
    });
    return () => {
      stopped = true;
    };
  }, [connections, current]);
  const list = entries ?? [];
  useKeyboard((key: KeyEvent) => {
    if (adding || busy) return;
    if (forgetting) {
      if (key.name === "return" || key.name === "enter") void forget(forgetting);
      else if (key.name === "escape") setForgetting(undefined);
      return;
    }
    if (key.name === "escape") onClose();
    else if (key.name === "down" || key.name === "j")
      setIndex((i) => Math.min(i + 1, list.length - 1));
    else if (key.name === "up" || key.name === "k") setIndex((i) => Math.max(i - 1, 0));
    else if (key.name === "a" && !key.ctrl) setAdding({});
    else if ((key.name === "s" || key.name === "e") && !key.ctrl) {
      // `s` saves the Gateway the launch named; `e` changes a saved one's credential or files.
      const entry = list[index];
      const wanted = key.name === "s" ? "launch" : "saved";
      if (entry?.kind !== wanted) {
        setProblem(
          key.name === "s"
            ? "s saves the Gateway this launch named (--gateway URL); select it first."
            : "e changes a saved Gateway; Local's token is never saved.",
        );
        return;
      }
      if (entry.source === "desktop") {
        setProblem(`${entry.name} is saved in the desktop app; change it there.`);
        return;
      }
      void connections.draft(entry.id).then((draft) => {
        if (draft) setAdding(draft);
        else setProblem("That Gateway is no longer saved.");
      });
    } else if (key.name === "d" && !key.ctrl) {
      const entry = list[index];
      if (entry?.kind === "saved") setForgetting(entry);
      else if (entry) setProblem(`${entry.name} is not saved, so there is nothing to forget.`);
    } else if (key.name === "return" || key.name === "enter") {
      const entry = list[index];
      if (!entry) return;
      if (!entry.available) {
        setProblem(entry.detail);
        return;
      }
      onOpen(entry);
    }
  });
  const inner = Math.max(20, width - 4);
  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title="Gateways"
      marginTop={2}
    >
      {adding ? (
        <AddGateway
          connections={connections}
          width={inner}
          initial={adding}
          onSaved={(id) => {
            setAdding(undefined);
            void connections.entries().then((listed) => {
              setEntries(listed);
              const entry = listed.find((candidate) => candidate.id === id);
              if (entry) onOpen(entry);
            });
          }}
          onCancel={() => setAdding(undefined)}
        />
      ) : (
        <>
          {entries === undefined ? <text fg={color.muted}>Looking for Gateways…</text> : null}
          {list.map((entry, position) => (
            <text
              key={entry.id}
              fg={!entry.available ? color.faint : position === index ? color.strong : color.text}
              bg={position === index ? color.selected : undefined}
            >
              {entry.id === current ? "● " : "  "}
              {clip(entry.name, 24).padEnd(25)}
              <span fg={color.muted}>
                {clip(
                  `${entry.detail}${entry.source === "desktop" ? " · desktop app" : ""}`,
                  Math.max(10, inner - 28),
                )}
              </span>
            </text>
          ))}
          {problem ? <text fg={color.warning}>{safe(problem)}</text> : null}
          {forgetting ? (
            <text fg={color.warning}>
              Forget {safe(forgetting.name)} and its cache on this device? Enter forgets · Esc keeps
              it
            </text>
          ) : (
            <text fg={color.faint}>
              {busy
                ? "Forgetting…"
                : "Enter connect · a add · s save launch · e edit · d forget · Esc close"}
            </text>
          )}
        </>
      )}
    </box>
  );
}

function AddGateway({
  connections,
  width,
  initial,
  onSaved,
  onCancel,
}: {
  connections: Connections;
  width: number;
  initial: Partial<GatewayDraft>;
  onSaved(id: string): void;
  onCancel(): void;
}) {
  const [values, setValues] = useState<Record<Field, string>>({
    name: "",
    url: "",
    token: "",
    serverCaFile: "",
    clientCertFile: "",
    clientKeyFile: "",
    ...initial,
  });
  // A saved Gateway's form starts on its credential, the launch Gateway's on its name.
  const [at, setAt] = useState(initial.name ? 2 : 0);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const set = (field: Field, value: string) => setValues((prior) => ({ ...prior, [field]: value }));
  async function save() {
    if (saving) return;
    if (!values.name.trim() || !values.url.trim() || !values.token) {
      setProblem("Enter a name, the URL, and a token or Auth Key.");
      return;
    }
    setSaving(true);
    setProblem("");
    try {
      const optional = (value: string) => (value.trim() ? value.trim() : undefined);
      const id = await connections.save({
        name: values.name.trim(),
        url: values.url.trim(),
        token: values.token.trim(),
        ...(optional(values.serverCaFile) ? { serverCaFile: values.serverCaFile.trim() } : {}),
        ...(optional(values.clientCertFile)
          ? { clientCertFile: values.clientCertFile.trim() }
          : {}),
        ...(optional(values.clientKeyFile) ? { clientKeyFile: values.clientKeyFile.trim() } : {}),
      });
      onSaved(id);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setSaving(false);
    }
  }
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape") onCancel();
    else if (key.ctrl && key.name === "s") void save();
    else if (key.name === "tab" || key.name === "down")
      setAt((i) => (key.shift ? Math.max(i - 1, 0) : Math.min(i + 1, FIELDS.length - 1)));
    else if (key.name === "up") setAt((i) => Math.max(i - 1, 0));
    else if (FIELDS[at]?.key === "token" && (key.name === "return" || key.name === "enter"))
      setAt((i) => i + 1);
  });
  return (
    <box flexDirection="column">
      <text fg={color.muted}>Saved with supertag connect. An Auth Key enrolls this device.</text>
      {FIELDS.map((field, position) => (
        <box key={field.key} flexDirection="row" height={1}>
          <text fg={position === at ? color.strong : color.muted} width={13}>
            {field.label}
          </text>
          <box width={Math.max(10, width - 13)} height={1}>
            {field.key === "token" ? (
              <MaskedField
                focused={position === at}
                value={values.token}
                onChange={(change) =>
                  setValues((prior) => ({ ...prior, token: change(prior.token) }))
                }
                placeholder={field.placeholder}
              />
            ) : (
              <input
                onPaste={pasteOnOneLine}
                focused={position === at}
                placeholder={field.placeholder}
                value={values[field.key]}
                onInput={(value: string) => set(field.key, value)}
                onSubmit={() =>
                  position === FIELDS.length - 1 ? void save() : setAt(position + 1)
                }
              />
            )}
          </box>
        </box>
      ))}
      {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
      <text fg={color.faint}>
        {saving ? "Saving…" : "Tab next field · Ctrl-S save · Esc cancel"}
      </text>
    </box>
  );
}
