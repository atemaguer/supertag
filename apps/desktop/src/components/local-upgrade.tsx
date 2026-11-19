import { useState } from "react";
import type { LocalUpgrade, RestartStep } from "../gateway";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** What the window says while a restart runs. */
export function restartStatus(step: RestartStep, upgrade: LocalUpgrade): string {
  return step === "stopping"
    ? `Stopping SuperTag ${upgrade.running}…`
    : `Starting SuperTag ${upgrade.version}…`;
}

/**
 * The local Gateway runs an older SuperTag release than this app, such as the one an installed
 * CLI started before the app was upgraded: offers to restart this machine's services with the
 * app's own version, after a confirmation that names what is interrupted.
 */
export function LocalUpgradeOffer({
  upgrade,
  step,
  error,
  onRestart,
}: {
  upgrade: LocalUpgrade;
  /** The restart's current step, while it runs. */
  step?: RestartStep;
  /** Why the last restart failed, with what the CLI printed. */
  error?: string;
  onRestart(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (step) {
    return (
      <p className="local-upgrade" role="status">
        {restartStatus(step, upgrade)}
      </p>
    );
  }
  return (
    <div className="local-upgrade">
      <p>
        This machine runs SuperTag {upgrade.running}, but this app is {upgrade.version}. Restart
        SuperTag with {upgrade.version} to connect.
      </p>
      {error && (
        <pre className="field-error local-upgrade-error" role="alert">
          {error}
        </pre>
      )}
      <Button className="primary" onClick={() => setConfirming(true)}>
        Restart SuperTag with {upgrade.version}
      </Button>
      {confirming && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(false)}>
          <DialogContent className="workspace-dialog">
            <DialogHeader>
              <DialogTitle>Restart SuperTag with {upgrade.version}?</DialogTitle>
              <DialogDescription>
                This stops SuperTag {upgrade.running} on this machine and starts {upgrade.version}{" "}
                in its place, which updates its database. Tasks running now are interrupted and
                follow the recovery rules once SuperTag is back.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                className="secondary"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="primary"
                onClick={() => {
                  setConfirming(false);
                  onRestart();
                }}
              >
                Restart
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
