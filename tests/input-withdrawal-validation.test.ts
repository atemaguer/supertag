import { expect, it, vi } from "vitest";
import { withdrawSessionInput } from "../packages/control-plane/src/session-input-withdrawal.js";
import { mailboxText } from "../packages/core/src/index.js";

it.each(["", " ", "bad id", "bad\n", "bad\u0000", "x".repeat(201)])(
  "ignores malformed withdrawal identifiers on repeated replay: %j",
  async (id) => {
    const appendTaskEvent = vi.fn();
    const withdrawInboundControlDelivery = vi.fn(
      async ({ inboundEventId }: { inboundEventId: string }) => {
        mailboxText(inboundEventId, "inboundEventId");
        return undefined;
      },
    );
    const store = { appendTaskEvent, withdrawInboundControlDelivery };
    for (let replay = 0; replay < 2; replay++) {
      const event = {
        type: "input.withdrawn" as const,
        taskId: "task",
        attemptId: "attempt",
        at: new Date().toISOString(),
      };
      await expect(
        withdrawSessionInput(store, { ...event, commandId: `session-input:${id}` }),
      ).resolves.toBe(false);
    }
    expect(withdrawInboundControlDelivery).not.toHaveBeenCalled();
    expect(appendTaskEvent).not.toHaveBeenCalled();
  },
);
