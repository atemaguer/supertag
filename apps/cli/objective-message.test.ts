import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient, ControlPlaneRequestError } from "./src/control-plane-client.js";
import { objectiveHelp, runObjectiveCommand } from "./src/objectives.js";

afterEach(() => vi.restoreAllMocks());

const target = { url: "http://localhost", token: "test" };
const MESSAGES = "/api/v1/coordination/objectives/objective-1/messages";

/**
 * Answers the message POST, the Objective and Tag reads the reply follow needs, and then the
 * CLI conversation read with `reply`, or with a `ControlPlaneRequestError` of `status`.
 */
function controlPlane(
  result: Record<string, unknown>,
  conversation: { readonly reply?: unknown; readonly status?: number } = { status: 404 },
) {
  const requests: Array<{ path: string; body?: string }> = [];
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (path, init) => {
      requests.push({ path, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
      if (path.endsWith("/messages") && init?.method === "POST") return result as never;
      if (path === "/api/v1/tag-messaging/objectives/objective-1")
        return { id: "objective-1", ownerTagId: "owner-id" } as never;
      if (path === "/api/v1/tags")
        return { items: [{ metadata: { id: "owner-id", name: "planner" } }] } as never;
      if (conversation.reply !== undefined) return conversation.reply as never;
      throw new ControlPlaneRequestError("no CLI conversation", conversation.status ?? 404);
    });
  return { requests, request };
}

describe("message objective", () => {
  it("documents the message command without the removed reply and reopen flags", () => {
    expect(objectiveHelp()).toContain("supertag message objective ID TEXT|- [--output text|json]");
    for (const removed of ["--reply-to", "--reopen"])
      expect(objectiveHelp()).not.toContain(removed);
  });

  it("sends the text as the Objective's next turn and reports the status it reopened", async () => {
    const { requests } = controlPlane({
      duplicate: false,
      taskId: "objective-1:turn-2",
      statusChange: "ready_for_review",
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runObjectiveCommand(target, ["message", "objective-1", "  Check appendix  "]);
    const sent = requests.find((entry) => entry.path === MESSAGES);
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ text: "Check appendix" });
    expect(output).toHaveBeenCalledWith(
      "Sent to the conversation of Objective objective-1.\nThe Objective moved from ready for review back to working.\n",
    );
  });

  it("says where the reply appears when the Objective's home is not this CLI conversation", async () => {
    controlPlane({ duplicate: false, taskId: "objective-1:turn-2" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runObjectiveCommand(target, ["message", "objective-1", "Check appendix"])).toBe(
      "The reply posts to the thread the Objective was created in.\n",
    );
  });

  it("follows the owner's reply in the operator's own CLI conversation", async () => {
    const { requests } = controlPlane(
      { duplicate: true, taskId: "objective-1:turn-2" },
      {
        reply: {
          kind: "TagMessage",
          tag: "planner",
          session: "objective:objective-1",
          sessionId: "session-1",
          taskId: "objective-1:turn-2",
          status: "replied",
          reply: { presentation: "markdown", text: "Appendix checked." },
        },
      },
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await runObjectiveCommand(target, ["message", "objective-1", "Check appendix"]);
    // A repeated send is not a second turn, and the reply is read from the owner's conversation.
    expect(written[0]).toBe("Already sent to the conversation of Objective objective-1.\n");
    expect(requests.at(-1)?.path).toBe("/api/v1/tags/planner/messages/objective-1%3Aturn-2");
    expect(written.join("")).toContain("Appendix checked.");
  });

  it("prints the whole result for scripts and sends nothing for empty text", async () => {
    const { requests } = controlPlane({ duplicate: false, taskId: "objective-1:turn-2" });
    expect(
      JSON.parse(
        await runObjectiveCommand(target, [
          "message",
          "objective-1",
          "Check appendix",
          "--output",
          "json",
        ]),
      ),
    ).toEqual({ duplicate: false, taskId: "objective-1:turn-2" });
    // --output json stops at the result; it never follows the reply.
    expect(requests).toHaveLength(1);
    await expect(runObjectiveCommand(target, ["message", "objective-1", "   "])).rejects.toThrow(
      "The message is empty",
    );
    expect(requests).toHaveLength(1);
  });
});
