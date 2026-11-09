import { inboxSessionKey, objectiveSessionKey, type Session } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { sessionResource } from "./src/work-views.js";

function session(sessionKey: string, origin: Record<string, unknown> = {}): Session {
  const at = "2026-11-08T12:00:00.000Z";
  return {
    id: "session-1",
    tagId: "tag-1",
    sessionKey,
    origin,
    state: "open",
    audience: "shared",
    createdAt: at,
    updatedAt: at,
    lastInteractionAt: at,
  } as Session;
}

describe("Session titles", () => {
  it("names an Objective's conversation for its Objective, not its first turn", () => {
    const resource = sessionResource(session(objectiveSessionKey("subtract")), {
      firstRequest: "Objective subtract has started.",
    });
    expect(resource.status.title).toBe("Objective subtract");
  });

  it("names a Tag's inbox", () => {
    expect(sessionResource(session(inboxSessionKey("tag-1"))).status.title).toBe("Inbox");
  });

  it("keeps a work Session's own title and a conversation's first request", () => {
    expect(sessionResource(session("work:parent:1", { title: "Add subtract" })).status.title).toBe(
      "Add subtract",
    );
    expect(
      sessionResource(session("slack:T1:C1:1.2"), { firstRequest: "Why is billing slow?" }).status
        .title,
    ).toBe("Why is billing slow?");
  });
});
