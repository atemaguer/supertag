import { describe, expect, it } from "vitest";
import type { InboundSurfaceEvent } from "./index.js";
import { parseSurfaceObjectiveCommand } from "./surface-objective-command.js";

const event = (text: string, overrides: Partial<InboundSurfaceEvent> = {}) =>
  ({
    provider: "slack",
    kind: "mention",
    actor: { id: "human", kind: "user" },
    text,
    ...overrides,
  }) as InboundSurfaceEvent;

describe("explicit Objective commands", () => {
  it("recognizes literal and native Slack mentions with multiline outcomes", () => {
    expect(
      parseSurfaceObjectiveCommand(event("<@U123> objective Launch product\nwithin $2,000")),
    ).toEqual({ kind: "create", outcome: "Launch product\nwithin $2,000" });
  });
  it("does not treat quotes, embedded commands or ordinary replies as authorization", () => {
    for (const text of [
      "> @SuperTag objective launch",
      "Please say @SuperTag objective launch",
      "```@SuperTag objective launch```",
      "@SuperTag explain objectives",
    ]) {
      expect(parseSurfaceObjectiveCommand(event(text))).toBeUndefined();
    }
    expect(
      parseSurfaceObjectiveCommand(event("@SuperTag objective launch", { kind: "message" })),
    ).toBeUndefined();
    expect(
      parseSurfaceObjectiveCommand(
        event("@SuperTag objective launch", { actor: { kind: "bot", id: "bot" } }),
      ),
    ).toBeUndefined();
  });
  it("fails closed without an outcome", () => {
    expect(parseSurfaceObjectiveCommand(event("@SuperTag objective"))).toEqual({ kind: "invalid" });
  });
});
