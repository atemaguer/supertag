import type { FormEvent, RefObject } from "react";
import { useRef } from "react";
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
import type { ControlPlaneProfile } from "../control-plane";

interface ConnectionDialogProps {
  profile?: ControlPlaneProfile;
  busy: boolean;
  error: string;
  opener: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onSave(address: string, name: string, token: string): void;
  onForget(origin: string): void;
}

export function ConnectionDialog({
  profile,
  busy,
  error,
  opener,
  onClose,
  onSave,
  onForget,
}: ConnectionDialogProps) {
  const token = useRef<HTMLInputElement>(null);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = token.current;
    const data = new FormData(event.currentTarget);
    const address = profile?.origin ?? data.get("controlPlane");
    const name = data.get("name");
    if (busy || !field || typeof address !== "string" || typeof name !== "string") return;
    const secret = field.value.trim();
    field.value = "";
    onSave(address.trim(), name, secret);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
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
          <DialogTitle>{profile ? "Edit Control Plane" : "Add Control Plane"}</DialogTitle>
          <DialogDescription>
            {profile
              ? "Update the name or credential for this connection."
              : "Use the Control Plane URL and an operator token, or a client Auth Key (stak_…) that joins this device. Only the token or this device's own credential is saved."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <label htmlFor="control-plane-name">Name (optional)</label>
          <Input
            id="control-plane-name"
            name="name"
            defaultValue={profile?.name}
            placeholder="Engineering"
            maxLength={80}
            disabled={busy}
          />
          <label htmlFor="control-plane-url">Control Plane URL</label>
          <Input
            id="control-plane-url"
            name="controlPlane"
            type="url"
            defaultValue={profile?.origin}
            placeholder="http://127.0.0.1:7001"
            autoComplete="off"
            spellCheck={false}
            required
            readOnly={Boolean(profile)}
            disabled={busy}
          />
          <label htmlFor="control-plane-token">
            {profile ? "New operator token or Auth Key (optional)" : "Operator token or Auth Key"}
          </label>
          <Input
            id="control-plane-token"
            ref={token}
            type="password"
            autoComplete="off"
            required={!profile}
            disabled={busy}
          />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            {profile && (
              <Button
                type="button"
                variant="outline"
                className="secondary"
                disabled={busy}
                onClick={() => onForget(profile.origin)}
              >
                Forget Control Plane
              </Button>
            )}
            <Button type="submit" className="primary" disabled={busy}>
              {busy ? "Working…" : profile ? "Save changes" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
