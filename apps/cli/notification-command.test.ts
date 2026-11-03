import { parseNotificationDestination } from "@supertag/control-plane";
import { describe, expect, it, vi } from "vitest";
import { runTestNotificationCommand } from "./src/notification-command.js";

describe("test notification command", () => {
  it("sends through every configured channel and reports redacted failures", async () => {
    const sent: string[] = [];
    const result = await runTestNotificationCommand(["--objective", "goal"], {
      destinations: [
        parseNotificationDestination("desktop"),
        parseNotificationDestination("webhook:https://example.test/hook#token"),
      ],
      send: async (destination) => {
        sent.push(destination.provider);
        if (destination.provider === "webhook")
          throw new Error("request to https://example.test/hook failed with secret-value");
      },
      secrets: { token: "secret-value" },
    });
    expect(sent).toEqual(["desktop", "webhook"]);
    expect(result).toContain("desktop: delivered");
    expect(result).toContain("webhook: failed: request to <redacted URL> failed with <redacted>");
    expect(result).not.toContain("secret-value");
  });

  it("reports no destination and desktop unavailability", async () => {
    expect(await runTestNotificationCommand([], { destinations: [], send: vi.fn() })).toBe(
      "Notification: not configured\n",
    );
    expect(
      await runTestNotificationCommand([], {
        destinations: [parseNotificationDestination("desktop")],
        send: async () => {
          throw new Error("Desktop notification unavailable");
        },
      }),
    ).toBe("desktop: unavailable\n");
  });

  it("links an unscoped sample to the inbox", async () => {
    let message = "";
    await runTestNotificationCommand([], {
      destinations: [parseNotificationDestination("desktop")],
      send: async (_destination, text) => {
        message = text;
      },
    });
    expect(message).toContain("`supertag list inbox`");
  });
});
