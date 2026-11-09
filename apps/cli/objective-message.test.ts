import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { objectiveHelp, runObjectiveCommand } from "./src/objectives.js";

afterEach(() => vi.restoreAllMocks());

const target = { url: "http://localhost", token: "test" };
const MESSAGES = "/api/v1/coordination/objectives/objective-1/messages";

/**
 * Answers the message POST and the Objective and Tag reads the reply follow needs over HTTP, and
 * the operator RPCs over Connect: `GetMessage` with `message`, or `NotFound` without one, and
 * `FollowMessage` with its finish and end.
 */
function controlPlane(result: Record<string, unknown>, message?: Record<string, unknown>) {
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
      throw new Error(`unexpected request ${path}`);
    });
  const rpcs: Array<{ path: string; body: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bytes = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    const streaming = path.endsWith("/FollowMessage");
    rpcs.push({ path, body: JSON.parse(new TextDecoder().decode(bytes.slice(streaming ? 5 : 0))) });
    if (message === undefined)
      return Response.json(
        { code: "not_found", message: "Task objective-1:turn-2 is not a message" },
        { status: 404 },
      );
    if (!streaming) return Response.json(message);
    const frames = [
      { sequence: "1", finish: { reply: message["reply"], message } },
      { sequence: "2", end: { message } },
    ].map((event) => envelope(0, event));
    return new Response(Buffer.concat([...frames, envelope(2, {})]), {
      headers: { "content-type": "application/connect+json" },
    });
  });
  return { requests, request, rpcs };
}

/** One Connect stream frame: its flags, its length, then its JSON. */
function envelope(flags: number, value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(json.length, 1);
  return Buffer.concat([header, json]);
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
    const { rpcs } = controlPlane(
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
    expect(rpcs[0]).toEqual({
      path: "/supertag.operator.v1.ConversationService/GetMessage",
      body: { tag: "planner", taskId: "objective-1:turn-2" },
    });
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
