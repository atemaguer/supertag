import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeOperatorRpc } from "../../tests/support/fake-operator-rpc.js";
import { objectiveHelp, runObjectiveCommand } from "./src/objectives.js";

afterEach(() => vi.restoreAllMocks());

const target = { url: "http://localhost", token: "test" };
const MESSAGE = "ObjectiveService/MessageObjective";

/**
 * Answers `MessageObjective` with `result`, and the reply follow's `GetMessage` with `message`,
 * or `NotFound` without one, and `FollowMessage` with its finish and end.
 */
function controlPlane(result: Record<string, unknown>, message?: Record<string, unknown>) {
  const rpc = fakeOperatorRpc({
    [MESSAGE]: () => ({ tag: "planner", ...result }),
    "ConversationService/GetMessage": () => {
      if (message === undefined)
        throw new FakeRpcError("not_found", "Task objective-1:turn-2 is not a message", 404);
      return message;
    },
    "ConversationService/FollowMessage": () =>
      (async function* () {
        yield { sequence: "1", finish: { reply: message?.["reply"], message } };
        yield { sequence: "2", end: { message } };
      })(),
  });
  return { rpc };
}

describe("message objective", () => {
  it("documents the message command without the removed reply and reopen flags", () => {
    expect(objectiveHelp()).toContain("supertag message objective ID TEXT|- [--output text|json]");
    for (const removed of ["--reply-to", "--reopen"])
      expect(objectiveHelp()).not.toContain(removed);
  });

  it("sends the text as the Objective's next turn and reports the status it reopened", async () => {
    const { rpc } = controlPlane({
      duplicate: false,
      taskId: "objective-1:turn-2",
      statusChange: "OBJECTIVE_STATUS_READY_FOR_REVIEW",
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runObjectiveCommand(target, ["message", "objective-1", "  Check appendix  "]);
    // Each command sends its own idempotency key, so a retried call admits the message once.
    expect(rpc.called(MESSAGE)[0]?.body).toEqual({
      id: "objective-1",
      text: "Check appendix",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
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
    const { rpc } = controlPlane(
      { duplicate: true, taskId: "objective-1:turn-2" },
      {
        taskId: "objective-1:turn-2",
        tag: "planner",
        conversation: "objective:objective-1",
        sessionId: "session-1",
        status: "REPLY_STATUS_REPLIED",
        reply: { presentation: "REPLY_PRESENTATION_FINAL_RESULT", text: "Appendix checked." },
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
    expect(rpc.called("ConversationService/GetMessage")[0]?.body).toEqual({
      tag: "planner",
      taskId: "objective-1:turn-2",
    });
    expect(written.join("")).toContain("Appendix checked.");
  });

  it("prints the whole result for scripts and sends nothing for empty text", async () => {
    const { rpc } = controlPlane({ duplicate: false, taskId: "objective-1:turn-2" });
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
    ).toEqual({ taskId: "objective-1:turn-2", tag: "planner" });
    // --output json stops at the result; it never follows the reply.
    expect(rpc.calls).toHaveLength(1);
    await expect(runObjectiveCommand(target, ["message", "objective-1", "   "])).rejects.toThrow(
      "The message is empty",
    );
    expect(rpc.calls).toHaveLength(1);
  });
});
