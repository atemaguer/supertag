import { createHash } from "node:crypto";
import {
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  coordinationInboxHeadline,
  coordinationInboxOccurrence,
  type OperatorNotification,
  type ReadCoordinationInboxInput,
  type Store,
} from "@supertag/core";
import { objectiveHome } from "./objective-sessions.js";

/** Messages per Objective per destination are at most one per window, except blocking approvals. */
export const OPERATOR_CHANNEL_WINDOW_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const LEASE_MS = 60_000;
const INBOX_PAGE_LIMIT = 20;
const ITEMS_SHOWN = 5;

/** Where one operator hears about an inbox item. */
export interface NotificationDestination {
  /** Canonical key, stable across restarts: `slack:TARGET` or `slack:WORKSPACE/TARGET`. */
  readonly key: string;
  readonly provider: "slack" | "desktop" | "webhook";
  /** Slack workspace (team) ID; optional when one Slack Surface Account is enrolled. */
  readonly workspaceId?: string;
  /** Slack channel ID (C, G), DM ID (D), or user ID (U, W) for a direct message. */
  readonly target: string;
  readonly secretName?: string;
}

/**
 * Chooses destinations for an inbox item. Today one configured channel receives everything;
 * per-person destinations can replace it once SuperTag knows human identities.
 */
export interface NotificationDestinationResolver {
  resolveNotificationDestinations(
    item: CoordinationInboxItem,
  ): readonly NotificationDestination[] | Promise<readonly NotificationDestination[]>;
}

/** Sends one message to a destination through its Surface Account. */
export type OperatorNotificationSender = (
  destination: NotificationDestination,
  text: string,
  notification?: OperatorNotification,
) => Promise<{ readonly externalMessageId?: string } | undefined>;

/** Parse one configured channel without exposing webhook URLs in validation errors. */
export function parseNotificationDestination(value: string): NotificationDestination {
  const trimmed = value.trim();
  if (trimmed === "desktop") return { key: "desktop", provider: "desktop", target: "desktop" };
  if (trimmed.startsWith("webhook:")) {
    const raw = trimmed.slice("webhook:".length);
    const separator = raw.lastIndexOf("#");
    const secretName = separator >= 0 ? raw.slice(separator + 1) : undefined;
    const urlText = separator >= 0 ? raw.slice(0, separator) : raw;
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error("notify webhook must contain a valid HTTPS URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname ||
      (secretName !== undefined && !/^[A-Za-z0-9_-]+$/u.test(secretName))
    )
      throw new Error("notify webhook must contain an HTTPS URL and optional secret name");
    return {
      key: `webhook:${createHash("sha256").update(trimmed).digest("hex")}`,
      provider: "webhook",
      target: urlText,
      ...(secretName ? { secretName } : {}),
    };
  }
  return parseOperatorChannel(trimmed);
}

/**
 * Parses `SUPERTAG_OPERATOR_CHANNEL`: `slack:TARGET` or `slack:WORKSPACE_ID/TARGET`, where TARGET
 * is a Slack channel ID or a user ID for a direct message.
 */
export function parseOperatorChannel(value: string): NotificationDestination {
  const match = /^slack:(?:([A-Z0-9]+)\/)?([A-Z0-9]+)$/u.exec(value.trim());
  const target = match?.[2];
  if (!match || !target || !/^[CGDUW][A-Z0-9]{2,}$/u.test(target))
    throw new Error(
      "SUPERTAG_OPERATOR_CHANNEL must be slack:CHANNEL_OR_USER_ID or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID, using a Slack ID beginning with C, G, D, U, or W",
    );
  const workspaceId = match[1];
  return {
    key: `slack:${workspaceId ? `${workspaceId}/` : ""}${target}`,
    provider: "slack",
    ...(workspaceId ? { workspaceId } : {}),
    target,
  };
}

/** The pre-identity resolver: every item goes to the one configured destination, if any. */
export function configuredOperatorChannel(
  destination: NotificationDestination | readonly NotificationDestination[] | undefined,
): NotificationDestinationResolver {
  const destinations =
    destination === undefined ? [] : Array.isArray(destination) ? destination : [destination];
  const unique = [...new Map(destinations.map((entry) => [entry.key, entry])).values()];
  return { resolveNotificationDestinations: () => unique };
}

const SURFACE_DELIVERED_KINDS = new Set<CoordinationInboxItem["kind"]>([
  "question",
  "objective_budget",
  "objective_limit",
  "approval",
]);

/**
 * Whether the Objective's own collaboration surface thread already carries this item: its home
 * thread, named by `notificationTaskId` or else the thread that created the Objective. The
 * Objective's turns ask their questions and post their approval and limit notices there. A failed
 * delivery there falls back to the operator channel.
 */
export async function objectiveThreadCarries(
  store: Pick<Store, "getObjective" | "getVerifiedSurfaceTask">,
  item: CoordinationInboxItem,
): Promise<boolean> {
  if (
    !SURFACE_DELIVERED_KINDS.has(item.kind) ||
    item.notification?.status === "failed" ||
    item.objectiveId === null
  )
    return false;
  try {
    return (
      (await objectiveHome(store, await store.getObjective(item.objectiveId), undefined)) !==
      undefined
    );
  } catch {
    return false;
  }
}

export interface OperatorChannelOptions {
  readonly store: Pick<
    Store,
    | "latestOperatorNotification"
    | "listNotifiedInboxItems"
    | "recordOperatorNotification"
    | "claimNextOperatorNotification"
    | "completeOperatorNotification"
    | "retryOperatorNotification"
  >;
  readonly resolver: NotificationDestinationResolver;
  readonly send: OperatorNotificationSender;
  /** Reads the inbox with notification status, as an administrator. */
  readonly readInbox: (input: ReadCoordinationInboxInput) => Promise<CoordinationInboxPage>;
  /** True when the item already reaches the Objective's own collaboration surface thread. */
  readonly carriedElsewhere?: (item: CoordinationInboxItem) => Promise<boolean>;
  /** Parses a stored destination key; defaults to the Slack form. */
  readonly destinationFromKey?: (key: string) => NotificationDestination;
  readonly leaseOwner: string;
  readonly now?: () => Date;
  readonly windowMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly redact?: (text: string) => string;
}

/**
 * Sends new inbox items to operator destinations through a durable outbox. Each item
 * occurrence reaches a destination at most once. Messages per Objective are batched to one per
 * window; a pending approval that a running Task Attempt waits on is sent immediately.
 */
export class OperatorChannelNotifications {
  readonly #options: OperatorChannelOptions;
  readonly #now: () => Date;
  readonly #itemObjectives = new Map<string, string>();

  constructor(options: OperatorChannelOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Records messages for new items. Restarting never re-records an item already recorded. */
  async reconcile(): Promise<number> {
    const items: CoordinationInboxItem[] = [];
    this.#itemObjectives.clear();
    let cursor: string | undefined;
    for (let page = 0; page < INBOX_PAGE_LIMIT; page += 1) {
      const result = await this.#options.readInbox({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...result.items);
      for (const item of result.items)
        if (item.objectiveId !== null)
          this.#itemObjectives.set(coordinationInboxOccurrence(item), item.objectiveId);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const groups = new Map<
      string,
      { destination: NotificationDestination; objectiveId: string; items: CoordinationInboxItem[] }
    >();
    for (const item of items) {
      const destinations = await this.#options.resolver.resolveNotificationDestinations(item);
      if (destinations.length === 0) continue;
      const carried = await this.#options.carriedElsewhere?.(item);
      for (const destination of destinations) {
        if (carried && destination.provider === "slack") continue;
        // Desktop messages and items without an Objective (a Tag inbox's approvals) are not
        // batched per Objective.
        const objectiveId =
          destination.provider === "desktop" || item.objectiveId === null ? "*" : item.objectiveId;
        const key = JSON.stringify([destination.key, objectiveId]);
        const group = groups.get(key) ?? { destination, objectiveId, items: [] };
        group.items.push(item);
        groups.set(key, group);
      }
    }
    let recorded = 0;
    for (const group of groups.values()) {
      const notified = await this.#options.store.listNotifiedInboxItems(
        group.destination.key,
        group.items.map(coordinationInboxOccurrence),
      );
      const fresh = group.items.filter((item) => !notified.has(coordinationInboxOccurrence(item)));
      if (fresh.length === 0) continue;
      const immediate = fresh.some((item) => item.kind === "approval" && item.approval?.blocking);
      const now = this.#now();
      const window = this.#options.windowMs ?? OPERATOR_CHANNEL_WINDOW_MS;
      const previous = await this.#options.store.latestOperatorNotification(
        group.destination.key,
        group.objectiveId,
      );
      const more =
        !immediate &&
        previous !== undefined &&
        now.getTime() - Date.parse(previous.createdAt) < 2 * window;
      const notification = await this.#options.store.recordOperatorNotification({
        destination: group.destination.key,
        objectiveId: group.objectiveId,
        itemKeys: fresh.map(coordinationInboxOccurrence),
        text: this.#redact(
          group.objectiveId === "*"
            ? formatDesktopNotification(fresh, more)
            : formatOperatorNotification(group.objectiveId, fresh, more),
        ),
        immediate,
        createdAt: now.toISOString(),
        maxAttempts:
          this.#options.maxAttempts ?? (group.destination.provider === "desktop" ? 3 : 5),
        ...(immediate ? {} : { windowStartedAt: new Date(now.getTime() - window).toISOString() }),
      });
      if (notification) recorded += 1;
    }
    return recorded;
  }

  /** Delivers one due message. Returns whether a message was attempted. */
  async deliverNext(): Promise<boolean> {
    const now = this.#now();
    const notification = await this.#options.store.claimNextOperatorNotification({
      leaseOwner: this.#options.leaseOwner,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
    });
    if (!notification) return false;
    try {
      const destination = (this.#options.destinationFromKey ?? parseNotificationDestination)(
        notification.destination,
      );
      const active = await this.#activeItems(notification);
      if (active.length === 0) {
        await this.#options.store.completeOperatorNotification({
          id: notification.id,
          leaseOwner: this.#options.leaseOwner,
          deliveredAt: this.#now().toISOString(),
        });
        return true;
      }
      const text = this.#redact(
        notification.objectiveId === "*"
          ? formatDesktopNotification(active, /\bmore items?\b/u.test(notification.text))
          : formatOperatorNotification(
              notification.objectiveId,
              active,
              /\bmore items?\b/u.test(notification.text),
            ),
      );
      const receipt = await this.#options.send(destination, text, {
        ...notification,
        itemKeys: active.map(coordinationInboxOccurrence),
      });
      await this.#options.store.completeOperatorNotification({
        id: notification.id,
        leaseOwner: this.#options.leaseOwner,
        deliveredAt: this.#now().toISOString(),
        ...(receipt?.externalMessageId ? { externalMessageId: receipt.externalMessageId } : {}),
      });
    } catch (error) {
      await this.#retry(notification, error);
    }
    return true;
  }

  async #activeItems(notification: OperatorNotification): Promise<CoordinationInboxItem[]> {
    const active = new Set(notification.itemKeys);
    const items: CoordinationInboxItem[] = [];
    const seen = new Set<string>();
    const objectives =
      notification.objectiveId === "*"
        ? [...new Set(notification.itemKeys.map((key) => this.#itemObjectives.get(key)))]
        : [notification.objectiveId];
    // A restarted desktop outbox has no in-memory item map. One full scan recovers its targets.
    const scoped = objectives.every((id): id is string => id !== undefined);
    for (const objectiveId of scoped ? objectives : [undefined]) {
      let cursor: string | undefined;
      for (let page = 0; page < INBOX_PAGE_LIMIT; page += 1) {
        const result = await this.#options.readInbox({
          limit: 100,
          ...(objectiveId ? { objectiveId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        for (const item of result.items) {
          const occurrence = coordinationInboxOccurrence(item);
          if (active.has(occurrence) && !seen.has(occurrence)) {
            items.push(item);
            seen.add(occurrence);
          }
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    }
    return items;
  }

  async #retry(notification: OperatorNotification, error: unknown): Promise<void> {
    const now = this.#now();
    const delay = Math.min(
      MAX_RETRY_DELAY_MS,
      (this.#options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) *
        2 ** Math.max(0, notification.attemptCount - 1),
    );
    await this.#options.store.retryOperatorNotification({
      id: notification.id,
      leaseOwner: this.#options.leaseOwner,
      error: this.#redact(safeNotificationError(error)),
      retryAt: new Date(now.getTime() + delay).toISOString(),
      failedAt: now.toISOString(),
    });
  }

  #redact(value: string): string {
    const redacted = this.#options.redact?.(value) ?? value;
    return redacted.replace(/https?:\/\/[^\s)`]+/giu, "<redacted URL>");
  }
}

function safeNotificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s)]+/giu, "<redacted URL>").slice(0, 500);
}

/** A short message: what needs the operator, then the command to act. */
export function formatOperatorNotification(
  objectiveId: string,
  items: readonly CoordinationInboxItem[],
  more = false,
): string {
  const [only] = items;
  if (items.length === 1 && only && !more) {
    const command = `supertag describe objective ${objectiveId}`;
    return [
      `Objective ${objectiveId} needs you: ${coordinationInboxHeadline(only)}`,
      ...(command ? [`\`${command}\``] : []),
    ].join("\n");
  }
  const shown = items.slice(0, ITEMS_SHOWN);
  return [
    `Objective ${objectiveId} has ${items.length} ${more ? "more" : "new"} ${items.length === 1 ? "item that needs" : "items that need"} you:`,
    ...shown.flatMap((item) => {
      const command = item.commands?.[0];
      return [`- ${coordinationInboxHeadline(item)}${command ? `: \`${command}\`` : ""}`];
    }),
    ...(items.length > shown.length ? [`- …and ${items.length - shown.length} more`] : []),
    `\`supertag list inbox --objective ${objectiveId}\``,
  ].join("\n");
}

function formatDesktopNotification(items: readonly CoordinationInboxItem[], more = false): string {
  const objectiveIds = [...new Set(items.map((item) => item.objectiveId))];
  const [objectiveId] = objectiveIds;
  if (objectiveIds.length === 1 && objectiveId)
    return formatOperatorNotification(objectiveId, items, more);
  const [only] = items;
  if (items.length === 1 && only && !more) {
    const command = only.commands?.[0];
    return [
      `SuperTag needs you: ${coordinationInboxHeadline(only)}`,
      ...(command ? [`\`${command}\``] : []),
    ].join("\n");
  }
  return objectiveIds.includes(null)
    ? `SuperTag has ${items.length} ${more ? "more" : "new"} items that need you.\n\`supertag list inbox\``
    : `SuperTag has ${items.length} ${more ? "more" : "new"} items across ${objectiveIds.length} Objectives.\n\`supertag list inbox\``;
}
