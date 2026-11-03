import { expect, it, vi } from "vitest";
import { withdrawSessionInput } from "../packages/control-plane/src/session-input-withdrawal.js";
import { withdrawTeamLiveInput } from "../packages/control-plane/src/team-live-delivery.js";
import { mailboxText } from "../packages/core/src/index.js";

it.each(["", " ", "bad id", "bad\n", "bad\u0000", "x".repeat(201)])(
  "ignores malformed withdrawal identifiers on repeated replay: %j",
  async (id) => {
    const appendTaskEvent = vi.fn();
    const withdrawTeamLiveDelivery = vi.fn(async ({ id }: { id: string }) => {
      mailboxText(id, "id");
      return undefined;
    });
    const withdrawInboundControlDelivery = vi.fn(
      async ({ inboundEventId }: { inboundEventId: string }) => {
        mailboxText(inboundEventId, "inboundEventId");
        return undefined;
      },
    );
    const store = { appendTaskEvent, withdrawTeamLiveDelivery, withdrawInboundControlDelivery };
    for (let replay = 0; replay < 2; replay++) {
      const event = {
        type: "input.withdrawn" as const,
        taskId: "task",
        attemptId: "attempt",
        at: new Date().toISOString(),
      };
      await expect(
        withdrawTeamLiveInput(store, { ...event, commandId: `team-input:${id}` }),
      ).resolves.toBeUndefined();
      await expect(
        withdrawSessionInput(store, { ...event, commandId: `session-input:${id}` }),
      ).resolves.toBe(false);
    }
    expect(withdrawTeamLiveDelivery).not.toHaveBeenCalled();
    expect(withdrawInboundControlDelivery).not.toHaveBeenCalled();
    expect(appendTaskEvent).not.toHaveBeenCalled();
  },
);
