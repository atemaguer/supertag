import { describe, expect, it, vi } from "vitest";
import {
  createNotificationDeliverySender,
  sendTestNotification,
} from "../apps/cli/src/operator-notification-delivery.js";
import { resolvedSummary } from "../apps/cli/src/up-serve.js";
import { parseNotificationDestination } from "../packages/control-plane/src/index.js";
import type { OperatorNotification } from "../packages/core/src/operator-notification.js";

describe("operator notification transports", () => {
  it("posts a redacted webhook payload with a header secret and no URL in its status", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const desktop = vi.fn(async () => {});
    const slack = vi.fn(async () => undefined);
    const sender = createNotificationDeliverySender(
      slack,
      { hook: "top-secret" },
      { request, desktop },
    );
    const destination = parseNotificationDestination(
      "webhook:https://hooks.example/x?token=hidden#hook",
    );
    expect(destination.key).not.toContain("hooks.example");
    const result = await sendTestNotification([destination], sender, "objective-a");
    expect(result).toEqual([{ destination: "webhook", status: "delivered" }]);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x?token=hidden");
    expect(init.headers).toMatchObject({ authorization: "Bearer top-secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      objectiveId: "objective-a",
      kinds: ["test"],
      count: 1,
      title: "SuperTag needs you",
      command: "supertag describe objective objective-a",
      itemKeys: ["test:objective-a"],
    });
    expect(desktop).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
  });

  it("uses a fake desktop notifier and returns per-channel failures without URL disclosure", async () => {
    const desktop = vi.fn(async () => {});
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const sender = createNotificationDeliverySender(
      vi.fn(async () => undefined),
      {},
      { desktop, request },
    );
    const result = await sendTestNotification(
      [
        parseNotificationDestination("desktop"),
        parseNotificationDestination("webhook:https://hooks.example/secret?x=y"),
      ],
      sender,
      "objective-b",
    );
    expect(result).toEqual([
      { destination: "desktop", status: "delivered" },
      { destination: "webhook", status: "failed", error: "Webhook returned HTTP 503" },
    ]);
    expect(desktop).toHaveBeenCalledWith(
      "SuperTag needs you",
      expect.stringContaining("supertag describe objective objective-b"),
    );
    expect(JSON.stringify(result)).not.toContain("hooks.example");
  });

  it("keeps webhook URLs out of the service status summary", () => {
    const summary = resolvedSummary({
      type: "control-plane",
      notify: ["desktop", "webhook:https://hooks.example/private?token=hidden#hook"],
    });
    expect(summary["notify"]).toEqual([
      "desktop",
      parseNotificationDestination("webhook:https://hooks.example/private?token=hidden#hook").key,
    ]);
    expect(JSON.stringify(summary)).not.toContain("hooks.example");
  });

  it("redacts configured secrets and URLs from every webhook text field", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const sender = createNotificationDeliverySender(
      vi.fn(async () => undefined),
      { hook: "top-secret" },
      { request },
    );
    await sender(
      parseNotificationDestination("webhook:https://hooks.example/x#hook"),
      "top-secret at https://private.example/path\n`supertag describe objective top-secret`",
      {
        objectiveId: "top-secret",
        itemKeys: ["operator_message:top-secret"],
      } as OperatorNotification,
    );
    const payload = JSON.parse(
      String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(JSON.stringify(payload)).not.toContain("top-secret");
    expect(JSON.stringify(payload)).not.toContain("private.example");
    expect(payload.objectiveId).toBe("<redacted>");
    expect(payload.command).toContain("<redacted>");
  });
});
