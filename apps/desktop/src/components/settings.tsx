/**
 * Settings: one dialog, opened by the gear at the foot of the sidebar, ⌘, (Ctrl+, outside macOS)
 * and the app menu. It holds what is true of the app as a whole: its release and the connected
 * Gateway's, updates, and what this device notifies about.
 */
import type { GatewayRelease, NotificationLevel } from "@supertag/client/model";
import { Settings } from "lucide-react";
import { type RefObject, useState } from "react";
import { RELEASES_URL, type UpdateStatus } from "../../electron/update-state";
import { openExternal } from "./external-link";
import { NOTIFICATION_CHOICES } from "./gateway-selector";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { type Updates, updateView } from "./update";
import { APP_VERSION, releaseDiffers } from "./version";

const DOCS_URL = "https://github.com/atemaguer/supertag/tree/main/docs";

/** Whether a key press opens Settings: ⌘, on macOS, Ctrl+, elsewhere. */
export function isSettingsShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  mac: boolean,
) {
  if (event.key !== "," || event.altKey || event.shiftKey || event.isComposing) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Whether something in Settings waits to be seen, which the gear marks with a dot: an update
 * offered or under way, a failed one, or a Gateway on another release than the app.
 */
export function settingsPending(status: UpdateStatus, app: string, gateway?: GatewayRelease) {
  const view = updateView(status);
  return Boolean(view.button || view.banner) || releaseDiffers(app, gateway);
}

/** What the Updates section says for a status; `checked` once a check was asked for here. */
export function updateLine(status: UpdateStatus, checked: boolean): string {
  switch (status.state) {
    case "off":
      return "Updates are off in this build.";
    case "idle":
      return checked ? "SuperTag is up to date." : "";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading SuperTag ${status.version} · ${status.percent}%`;
    case "preparing":
      return `Preparing SuperTag ${status.version}…`;
    case "ready":
      return `SuperTag ${status.version} is ready. It installs when you restart or quit.`;
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

export function SettingsDialog({
  open,
  onOpenChange,
  app = APP_VERSION,
  gatewayName,
  gateway,
  updates,
  notifications,
  onNotifications,
  returnFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  app?: string;
  /** The connected Gateway's name; none while disconnected. */
  gatewayName?: string;
  gateway?: GatewayRelease;
  updates: Updates;
  notifications: NotificationLevel;
  onNotifications(level: NotificationLevel): void;
  /** Where the focus goes when the dialog closes: the gear. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [checked, setChecked] = useState(false);
  const { status, button } = updates;
  const line = updateLine(status, checked);
  const working = ["checking", "downloading", "preparing", "installing"].includes(status.state);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="workspace-dialog settings-dialog"
        // The dialog itself takes the focus, so Enter restarts or changes nothing by accident.
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
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            This app, its updates, and this device's notifications.
          </DialogDescription>
        </DialogHeader>

        <section className="settings-section" aria-labelledby="settings-about">
          <h3 id="settings-about">About</h3>
          <dl className="settings-facts">
            <dt>SuperTag</dt>
            <dd>{app}</dd>
            <dt>Gateway</dt>
            <dd>{gatewayName ?? "Not connected"}</dd>
            {gateway && (
              <>
                <dt>Gateway release</dt>
                <dd>
                  {gateway.build}
                  {gateway.protocol > 0 && ` · Protocol ${gateway.protocol}`}
                </dd>
              </>
            )}
          </dl>
          {releaseDiffers(app, gateway) && (
            <p className="settings-warning" role="status">
              This Gateway runs another release than the app. Update whichever is older so they
              match.
            </p>
          )}
        </section>

        <section className="settings-section" aria-labelledby="settings-updates">
          <h3 id="settings-updates">Updates</h3>
          {line && (
            <p className="settings-line" role="status">
              {line}
            </p>
          )}
          {updates.error && (
            <p className="field-error" role="alert">
              {updates.error}
            </p>
          )}
          <div className="settings-actions">
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
          </div>
        </section>

        <fieldset className="settings-section settings-choices">
          <legend>Notifications</legend>
          <p className="field-hint">
            What this device notifies you about while you look elsewhere.
          </p>
          {NOTIFICATION_CHOICES.map(([level, label]) => (
            <label key={level}>
              <input
                type="radio"
                name="settings-notifications"
                checked={notifications === level}
                onChange={() => onNotifications(level)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="settings-links">
          <Button variant="link" className="settings-link" onClick={() => openExternal(DOCS_URL)}>
            Documentation
          </Button>
          <Button
            variant="link"
            className="settings-link"
            onClick={() => openExternal(RELEASES_URL)}
          >
            Release notes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
