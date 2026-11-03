import { spawn } from "node:child_process";
import type { NotificationDestination, OperatorNotificationSender } from "@supertag/control-plane";
import type { OperatorNotification } from "@supertag/core";

export interface NotificationDeliveryTransport {
  readonly request?: typeof fetch;
  readonly desktop?: (title: string, text: string) => Promise<void>;
}

/** Sends one harmless sample through every configured destination for the CLI test command. */
export async function sendTestNotification(
  destinations: readonly NotificationDestination[],
  sender: OperatorNotificationSender,
  objectiveId: string,
): Promise<readonly { destination: string; status: "delivered" | "failed"; error?: string }[]> {
  const now = new Date().toISOString();
  const notification: OperatorNotification = {
    id: "test-notification",
    destination: "",
    objectiveId,
    itemKeys: [`test:${objectiveId}`],
    text: `SuperTag test notification\n\`${objectiveId ? `supertag describe objective ${objectiveId}` : "supertag list inbox"}\``,
    immediate: true,
    status: "delivering",
    attemptCount: 1,
    maxAttempts: 1,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    externalMessageId: null,
    deliveredAt: null,
    failedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return Promise.all(
    destinations.map(async (destination) => {
      try {
        await sender(destination, notification.text, {
          ...notification,
          destination: destination.key,
        });
        return { destination: destination.provider, status: "delivered" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          destination: destination.provider,
          status: "failed" as const,
          error: message.replace(/https?:\/\/[^\s)]+/giu, "<redacted URL>"),
        };
      }
    }),
  );
}

/** Local senders used by the durable operator notification outbox. */
export function createNotificationDeliverySender(
  slack: OperatorNotificationSender,
  secrets: Readonly<Record<string, string>> = {},
  transport: NotificationDeliveryTransport = {},
): OperatorNotificationSender {
  return async (destination, message, notification) => {
    const redact = (value: string) => {
      let clean = value;
      for (const secret of Object.values(secrets))
        if (secret) clean = clean.replaceAll(secret, "<redacted>");
      return clean.replace(/https?:\/\/[^\s)`]+/giu, "<redacted URL>");
    };
    const text = redact(message);
    if (destination.provider === "slack") return slack(destination, text, notification);
    const title = "SuperTag needs you";
    if (destination.provider === "desktop") {
      await (transport.desktop ?? sendDesktopNotification)(title, text);
      return undefined;
    }
    const secret = destination.secretName ? secrets[destination.secretName] : undefined;
    if (destination.secretName && !secret) throw new Error("Webhook header secret is unavailable");
    const command =
      /`(supertag (?:list inbox|describe objective)[^`]*)`\s*$/u.exec(text)?.[1] ??
      `supertag list inbox --objective ${redact(notification?.objectiveId ?? "")}`;
    const itemKeys = (notification?.itemKeys ?? []).map(redact);
    const response = await (transport.request ?? fetch)(destination.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        objectiveId: redact(notification?.objectiveId ?? ""),
        kinds: [...new Set(itemKeys.map((key) => key.split(":", 1)[0]))],
        count: itemKeys.length,
        title,
        text,
        command,
        itemKeys,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    return undefined;
  };
}

async function sendDesktopNotification(title: string, text: string): Promise<void> {
  if (process.platform === "darwin") {
    await runNotifier("osascript", [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      text,
    ]);
    return;
  }
  if (process.platform === "linux") {
    await runNotifier("notify-send", [title, text]);
    return;
  }
  throw new Error("Desktop notification unavailable");
}

function runNotifier(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Desktop notification unavailable"));
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Desktop notification unavailable"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("Desktop notification unavailable"));
    });
  });
}
