import { confirm } from "@inquirer/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { objectiveHelp, runObjectiveCommand } from "./src/objectives.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("message objective", () => {
  it("lists the JSON output option in per-command help", () => {
    expect(objectiveHelp()).toContain(
      "supertag message objective ID TEXT|- [--reopen] [--reply-to MESSAGE_ID] [--output text|json]",
    );
  });
  it("shows pending questions and sends a noninteractive message without answering one", async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    vi.spyOn(ControlPlaneClient.prototype, "request").mockImplementation(async (path, init) => {
      requests.push({ path, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
      if (path.includes("/inbox?"))
        return {
          items: [
            {
              kind: "operator_message",
              evidence: [{ kind: "message", id: "question-1" }],
              message: { text: "Which format?" },
            },
          ],
        } as never;
      return {
        message: { id: "sent-1" },
        objective: { id: "objective-1" },
        repliedToMessageId: null,
        statusChange: null,
      } as never;
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runObjectiveCommand({ url: "http://localhost", token: "test" }, [
      "message",
      "objective-1",
      "Check appendix",
    ]);
    expect(output).toHaveBeenCalledWith("Pending question question-1: Which format?\n");
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toEqual({ message: "Check appendix" });
  });

  it("keeps a question pending on a terminal without --reply-to", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      vi.mocked(confirm).mockResolvedValueOnce(true);
      const send = vi
        .spyOn(ControlPlaneClient.prototype, "request")
        .mockImplementation(async (path) => {
          if (path.includes("/inbox?"))
            return {
              items: [
                {
                  kind: "operator_message",
                  evidence: [{ kind: "message", id: "question-1" }],
                  message: { text: "Which format?" },
                },
              ],
            } as never;
          return {
            message: { id: "sent-1" },
            objective: { id: "objective-1" },
            repliedToMessageId: "question-1",
            statusChange: null,
          } as never;
        });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runObjectiveCommand({ url: "http://localhost", token: "test" }, [
        "message",
        "objective-1",
        "Use PDF",
      ]);
      expect(confirm).not.toHaveBeenCalled();
      expect(JSON.parse(String(send.mock.calls.at(-1)?.[1]?.body))).toEqual({
        message: "Use PDF",
      });
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  function mockInbox() {
    return vi.spyOn(ControlPlaneClient.prototype, "request").mockImplementation(async (path) => {
      if (path.includes("/inbox?"))
        return {
          items: [
            {
              kind: "operator_message",
              evidence: [{ kind: "message", id: "question-1" }],
              message: { text: "Which format?" },
            },
          ],
        } as never;
      return {
        message: { id: "sent-1" },
        objective: { id: "objective-1" },
        repliedToMessageId: "question-1",
        statusChange: null,
      } as never;
    });
  }

  it("answers the question named by --reply-to without prompting", async () => {
    vi.mocked(confirm).mockClear();
    const send = mockInbox();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runObjectiveCommand({ url: "http://localhost", token: "test" }, [
      "message",
      "objective-1",
      "Use PDF",
      "--reply-to",
      "question-1",
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Pending question question-1: Which format?\n");
    expect(JSON.parse(String(send.mock.calls.at(-1)?.[1]?.body))).toEqual({
      message: "Use PDF",
      inReplyTo: "question-1",
    });
  });

  it("rejects --reply-to for an id that is not a pending question", async () => {
    const send = mockInbox();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      runObjectiveCommand({ url: "http://localhost", token: "test" }, [
        "message",
        "objective-1",
        "Use PDF",
        "--reply-to",
        "question-9",
      ]),
    ).rejects.toThrow(
      "question-9 is not a pending question on objective/objective-1. Pending questions: question-1",
    );
    expect(send.mock.calls.some(([path]) => String(path).endsWith("/messages"))).toBe(false);
  });
});
