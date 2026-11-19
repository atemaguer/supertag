/**
 * What the window asks of the desktop itself: native notifications, the Dock badge, web links in
 * the system browser, and the folder picker. The Electron objects are passed in, so the checks
 * run in tests without Electron.
 */
import type { BrowserWindow, Dialog, Notification, NotificationConstructorOptions } from "electron";
import type { NotificationRequest } from "./channels";

/** A web link the system browser may open, or nothing: only `http:` and `https:` URLs. */
export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const LIMITS = { key: 256, tagId: 256, title: 256, body: 2048 };

/** A notification request the window sent, checked field by field; nothing when it is malformed. */
export function notificationRequest(value: unknown): NotificationRequest | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const checked: Partial<NotificationRequest> = {};
  for (const field of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const text = entry[field];
    if (typeof text !== "string" || text.length === 0) return undefined;
    checked[field] = text.slice(0, LIMITS[field]);
  }
  return checked as NotificationRequest;
}

/** A badge count the window sent, as a whole number from 0. */
export function badgeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface NotificationHost {
  create(options: NotificationConstructorOptions): Notification;
  supported(): boolean;
  /** Shows and focuses the main window, then tells it the clicked notification's Tag. */
  clicked(tagId: string): void;
}

/**
 * The window's notifications. A newer one with the same key replaces the earlier, and each is
 * kept until it closes, so its click still reaches the window.
 */
export class Notifications {
  private readonly shown = new Map<string, Notification>();

  constructor(private readonly host: NotificationHost) {}

  show(request: NotificationRequest) {
    if (!this.host.supported()) return;
    this.shown.get(request.key)?.close();
    const notification = this.host.create({ title: request.title, body: request.body });
    notification.on("click", () => this.host.clicked(request.tagId));
    notification.on("close", () => {
      if (this.shown.get(request.key) === notification) this.shown.delete(request.key);
    });
    this.shown.set(request.key, notification);
    notification.show();
  }

  get size() {
    return this.shown.size;
  }
}

/** Asks for the project folder with the system's folder picker; null when cancelled. */
export async function chooseFolder(
  dialog: Pick<Dialog, "showOpenDialog">,
  window: BrowserWindow | undefined,
): Promise<string | null> {
  const options = {
    title: "Choose your project folder",
    properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
