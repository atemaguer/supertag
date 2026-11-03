import { parseArgs } from "node:util";
import {
  type NotificationDestination,
  type OperatorNotificationSender,
  parseNotificationDestination,
} from "@supertag/control-plane";
import { DrizzleStore } from "@supertag/store";
import { createCredentialVaultFromEnvironment } from "./credential-vault.js";
import { createOperatorNotificationSender } from "./gateway-surfaces.js";
import {
  createNotificationDeliverySender,
  sendTestNotification,
} from "./operator-notification-delivery.js";
import { controlPlaneOf, loadServicesFile, readSecret } from "./supertag-yaml.js";

export const testNotificationHelp = `Usage: supertag test notification [--objective ID]\n`;

export interface TestNotificationOptions {
  readonly destinations: readonly NotificationDestination[];
  readonly send: OperatorNotificationSender;
  readonly secrets?: Readonly<Record<string, string>>;
}

export async function runTestNotificationCommand(
  args: readonly string[],
  options: TestNotificationOptions,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { objective: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(testNotificationHelp.trim());
  if (options.destinations.length === 0) return "Notification: not configured\n";
  const objectiveId = values.objective?.trim() ?? "";
  const results = await sendTestNotification(options.destinations, options.send, objectiveId);
  return `${results
    .map((result) => {
      if (result.status === "delivered") return `${result.destination}: delivered`;
      if (result.destination === "desktop" && result.error?.includes("unavailable"))
        return "desktop: unavailable";
      let error = result.error ?? "delivery failed";
      for (const secret of Object.values(options.secrets ?? {}))
        if (secret) error = error.replaceAll(secret, "<redacted>");
      return `${result.destination}: failed: ${error}`;
    })
    .join("\n")}\n`;
}

/** Uses the same settings and sender as a local `supertag up` Control Plane. */
export async function testConfiguredNotification(args: readonly string[]): Promise<string> {
  const file = await loadServicesFile();
  const service = controlPlaneOf(file);
  const setting =
    service?.notify ??
    (process.env["SUPERTAG_DEPLOYMENT_PLATFORM"] === undefined ? "desktop" : undefined);
  const destinations = (
    setting === undefined ? [] : typeof setting === "string" ? [setting] : setting
  ).map(parseNotificationDestination);
  const secrets: Record<string, string> = {};
  for (const destination of destinations)
    if (destination.secretName) {
      try {
        secrets[destination.secretName] = await readSecret(file, destination.secretName);
      } catch {
        // The sender reports this destination as failed while other channels still run.
      }
    }
  const store = destinations.some((destination) => destination.provider === "slack")
    ? new DrizzleStore(service?.database.url === undefined ? {} : { url: service.database.url })
    : undefined;
  try {
    const sender = createNotificationDeliverySender(
      store === undefined
        ? async () => {
            throw new Error("Slack is not configured");
          }
        : createOperatorNotificationSender(store, createCredentialVaultFromEnvironment()),
      secrets,
    );
    return await runTestNotificationCommand(args, { destinations, send: sender, secrets });
  } finally {
    await store?.disconnect();
  }
}
