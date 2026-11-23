import { ArrowDownToLine, CircleAlert, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { statusVersion, type UpdateStatus } from "../../electron/update-state";
import { desktop } from "../desktop";
import { Button } from "./ui/button";

/** Where the window hears of the app's own updates and asks to install one. */
export interface UpdateSource {
  status(): Promise<UpdateStatus>;
  /** Calls `changed` with each new status, until the returned stop. */
  subscribe(changed: (status: UpdateStatus) => void): () => void;
  /** Restarts into a downloaded update, or else opens the release page. */
  install(): Promise<void>;
  /** Looks for a newer release now, as "Check for Updates…" in the app menu does. */
  check(): Promise<void>;
}

/** The main process's updater; outside the desktop app, updates are off. */
export const nativeUpdates: UpdateSource = {
  status: () => desktop().updateStatus({}),
  subscribe: (changed) => desktop().onUpdateStatus(changed),
  install: () => desktop().installUpdate({}),
  check: () => desktop().checkForUpdates({}),
};

/** The bottom-right banner: a title, a line under it, and its action beside "Later". */
export interface UpdateBannerView {
  /** Which status it is about; "Later" hides it until this changes. */
  key: string;
  tone: "ready" | "available" | "error";
  title: string;
  detail: string;
  action: string;
  /** The action runs already: shown, but not clickable. */
  busy?: boolean;
}

/**
 * The button at the sidebar's foot, beside the version; `progress` is not a button, and has no
 * `percent` while the app prepares a downloaded update, which reports none.
 */
export type UpdateButtonView =
  | { kind: "install" | "download"; label: string; busy?: boolean }
  | { kind: "progress"; label: string; percent?: number };

/** What the window shows for an update status: a banner, the sidebar's button, both, or neither. */
export function updateView(status: UpdateStatus): {
  banner?: UpdateBannerView;
  button?: UpdateButtonView;
} {
  const stage = status.state === "error" ? status.stage : "";
  const key = `${status.state}:${stage}:${statusVersion(status) ?? ""}`;
  switch (status.state) {
    case "downloading":
      return {
        button: {
          kind: "progress",
          label: `Downloading ${status.version}`,
          percent: status.percent,
        },
      };
    case "preparing":
      // Downloaded, but restarting now would wait for Squirrel.Mac: no banner until it is done.
      return { button: { kind: "progress", label: `Preparing ${status.version}` } };
    case "ready":
      return {
        banner: {
          key,
          tone: "ready",
          title: `SuperTag ${status.version} is ready`,
          detail:
            "Restart now, or it installs when you quit. SuperTag's local services then restart with the new version.",
          action: "Restart to update",
        },
        button: { kind: "install", label: `Update to ${status.version}` },
      };
    case "installing":
      return {
        banner: {
          key,
          tone: "ready",
          title: `Installing SuperTag ${status.version}…`,
          detail: "SuperTag closes while the update goes in, then opens again by itself.",
          action: "Restarting…",
          busy: true,
        },
        button: { kind: "install", label: `Updating to ${status.version}…`, busy: true },
      };
    case "available":
      return {
        banner: {
          key,
          tone: "available",
          title: `SuperTag ${status.version} is available`,
          detail: "Download the new package from GitHub and install it.",
          action: `Download ${status.version}`,
        },
        button: { kind: "download", label: `Download ${status.version}` },
      };
    case "error":
      if (status.stage === "install" && status.version !== undefined) {
        return {
          banner: {
            key,
            tone: "error",
            title: "Couldn't install the update",
            detail: `SuperTag ${status.version} didn't install. Download it from GitHub instead.`,
            action: "Download from GitHub",
          },
          button: { kind: "download", label: `Download ${status.version}` },
        };
      }
      return status.version === undefined
        ? {
            banner: {
              key,
              tone: "error",
              title: "Couldn't check for updates",
              detail: "Check your connection, or get the latest release from GitHub.",
              action: "Download from GitHub",
            },
          }
        : {
            banner: {
              key,
              tone: "error",
              title: `Couldn't download SuperTag ${status.version}`,
              detail: "Download it from GitHub instead.",
              action: "Download from GitHub",
            },
            button: { kind: "download", label: `Download ${status.version}` },
          };
    default:
      return {};
  }
}

/**
 * The app's update status as it changes, "Later" for the banner, which lasts until the next
 * launch or the next status, and the install action, with what it failed with.
 */
export function useUpdates(source: UpdateSource) {
  const [status, setStatus] = useState<UpdateStatus>({ state: "off" });
  const [dismissed, setDismissed] = useState<string>();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const stop = source.subscribe((next) => {
      if (live) setStatus(next);
    });
    source.status().then(
      (first) => {
        if (live) setStatus((current) => (current.state === "off" ? first : current));
      },
      () => {},
    );
    return () => {
      live = false;
      stop();
    };
  }, [source]);

  const view = updateView(status);
  const install = useCallback(() => {
    setInstalling(true);
    setError("");
    source.install().then(
      // Restarting quits the app; opening a page leaves it as it is.
      () => setInstalling(false),
      (failure: unknown) => {
        setInstalling(false);
        setError(typeof failure === "string" ? failure : "Could not install the update.");
      },
    );
  }, [source]);

  // What the check finds arrives as a status; a check that cannot start changes nothing.
  const check = useCallback(() => void source.check().catch(() => {}), [source]);

  return {
    status,
    check,
    banner: view.banner && view.banner.key !== dismissed ? view.banner : undefined,
    button: view.button,
    installing,
    error,
    install,
    later: () => setDismissed(view.banner?.key),
  };
}

export type Updates = ReturnType<typeof useUpdates>;

/** The bottom-right banner that says an update is ready, available, or failed. */
export function UpdateBanner({ updates }: { updates: Updates }) {
  const { banner, installing, error } = updates;
  if (!banner) return null;
  const Icon =
    banner.tone === "error" ? CircleAlert : banner.tone === "ready" ? RotateCw : ArrowDownToLine;
  return (
    <section
      className="update-banner"
      data-tone={banner.tone}
      aria-label="SuperTag update"
      role="status"
    >
      <Icon className="update-banner-icon" size={16} aria-hidden />
      <div className="update-banner-body">
        <p className="update-banner-title">{banner.title}</p>
        <p className="update-banner-detail">{banner.detail}</p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="update-banner-actions">
          <Button
            className="primary"
            disabled={installing || banner.busy}
            onClick={updates.install}
          >
            {installing && banner.tone === "ready" ? "Restarting…" : banner.action}
          </Button>
          <Button variant="outline" className="secondary" onClick={updates.later}>
            Later
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The update button at the sidebar's foot, which stays until the update is installed. */
export function UpdateButton({ updates, wide }: { updates: Updates; wide: boolean }) {
  const { button, installing } = updates;
  if (!button) return null;
  if (button.kind === "progress") {
    const text =
      button.percent === undefined ? `${button.label}…` : `${button.label} · ${button.percent}%`;
    return (
      <div
        className="sidebar-update"
        data-wide={wide}
        data-kind="progress"
        role="progressbar"
        aria-label={`SuperTag update, ${button.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={button.percent}
        aria-busy={button.percent === undefined}
        title={text}
      >
        {wide ? <span>{text}</span> : <ArrowDownToLine size={14} aria-hidden />}
        <span className="sidebar-update-bar" aria-hidden>
          <span style={{ width: `${button.percent ?? 100}%` }} />
        </span>
      </div>
    );
  }
  return (
    <Button
      variant="ghost"
      className="sidebar-update"
      data-wide={wide}
      data-kind={button.kind}
      aria-label={button.label}
      title={button.label}
      disabled={installing || button.busy}
      onClick={updates.install}
    >
      {button.kind === "install" ? (
        <RotateCw size={14} aria-hidden />
      ) : (
        <ArrowDownToLine size={14} aria-hidden />
      )}
      {wide && <span>{button.label}</span>}
    </Button>
  );
}
