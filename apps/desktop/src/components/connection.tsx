import type { FormEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { nativeGateway, type Tag } from "../gateway";
import { describe } from "../lib/polling";

interface ConnectionDialogProps {
  open: boolean;
  address: string;
  connected: boolean;
  opener: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onReset(): void;
  onConnect(address: string, tags: Tag[], connectionId: string): void;
}

export function ConnectionDialog({
  open,
  address,
  connected,
  opener,
  onClose,
  onReset,
  onConnect,
}: ConnectionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && error && !busy) token.current?.focus();
  }, [busy, error, open]);

  function close() {
    if (pending.current) return;
    setError("");
    onClose();
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = token.current;
    const url = event.currentTarget.elements.namedItem("gateway");
    if (pending.current || !field || !(url instanceof HTMLInputElement)) return;
    const destination = url.value.trim();
    pending.current = true;
    setBusy(true);
    setError("");
    onReset();
    try {
      const connecting = nativeGateway.connect(destination, field.value.trim());
      field.value = "";
      const connectionId = await connecting;
      try {
        onConnect(destination, await nativeGateway.tags(), connectionId);
      } catch (error) {
        await nativeGateway.disconnect();
        throw error;
      }
    } catch (error) {
      setError(describe(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function disconnect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await nativeGateway.disconnect();
      onReset();
      onClose();
    } catch (error) {
      setError(describe(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="workspace-dialog"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Gateway connection</DialogTitle>
          <DialogDescription>Connect to the Gateway for your SuperTag workspace.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void connect(event)}>
          <label htmlFor="gateway-url">Gateway URL</label>
          <Input
            id="gateway-url"
            name="gateway"
            type="url"
            defaultValue={address}
            placeholder="http://127.0.0.1:7001"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          <label htmlFor="gateway-token">Operator token</label>
          <Input
            id="gateway-token"
            ref={token}
            type="password"
            autoComplete="off"
            required
            disabled={busy}
          />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            {connected && (
              <Button
                type="button"
                variant="outline"
                className="secondary"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                Disconnect
              </Button>
            )}
            <Button type="submit" className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
