import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliFailureExitCode, formatCliFailure, main } from "../apps/cli/src/index.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("newcomer-facing CLI output", () => {
  it("prints existing local guides matching the installed Slack setup version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main(["setup", "slack", "--help"])).resolves.toBe(0);

    const output = write.mock.calls.map(([value]) => String(value)).join("");
    for (const label of ["Guide", "Manifest"]) {
      const path = output.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1];
      expect(path).toBeDefined();
      expect(isAbsolute(path as string)).toBe(true);
      expect(existsSync(path as string)).toBe(true);
    }
    expect(output).not.toContain("https://github.com/atemaguer/supertag/blob/main/");
  });

  it("formats prompt cancellation without exposing the prompt implementation", () => {
    const error = new Error("User force closed the prompt with 0 null");
    error.name = "ExitPromptError";

    expect(formatCliFailure(error)).toBe("Setup canceled. No credentials were saved.\n");
    expect(cliFailureExitCode(error)).toBe(130);
  });

  it("keeps a multi-line failure's line breaks for people and one line for JSON", () => {
    const error = new Error(
      "Invalid manifests:\n  org.yaml document 1: bad\u001b[31m\n  org.yaml document 2: bad",
    );
    expect(formatCliFailure(error, ["apply"])).toBe(
      "SuperTag failed: Invalid manifests:\n  org.yaml document 1: bad [31m\n  org.yaml document 2: bad\n",
    );
    expect(formatCliFailure(error, ["apply", "--output", "json"])).toBe(
      "SuperTag failed: Invalid manifests:   org.yaml document 1: bad [31m   org.yaml document 2: bad\n",
    );
  });

  it("preserves ordinary CLI failure details", () => {
    const error = new Error("No Control Plane is available");

    expect(formatCliFailure(error)).toBe("SuperTag failed: No Control Plane is available\n");
    expect(cliFailureExitCode(error)).toBe(1);
  });

  it("uses the Control Plane address for the Worklet API in either CLI position", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      main(["connect", "worklet", "--worklet-url", "http://127.0.0.1:3434", "--help"]),
    ).resolves.toBe(0);
    await expect(
      main(["--control-plane=http://127.0.0.1:3434", "worklet", "connect", "--help"]),
    ).resolves.toBe(0);

    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("supertag connect worklet [--worklet-url URL]");
    expect(output).toContain("Control Plane's Worklet API");
    expect(output).not.toContain("--gateway");
  });
});

it("lists the routed coordination interfaces and documented flags in root help", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await main(["--help"]);
  const text = write.mock.calls.map(([value]) => String(value)).join("");
  for (const entry of [
    "--worker-profile NAME",
    "--runtime-action ACTION",
    "supertag status",
    "supertag create team NAME --member TAG",
    "supertag grant mailbox RECIPIENT --sender SENDER",
    "supertag list workstream-post --team TEAM",
    "supertag list message --mailbox TAG [--limit N]",
    "supertag message tag NAME TEXT|- [--session NAME] [--output text|json]",
    "supertag message objective ID TEXT|- [--output text|json]",
  ])
    expect(text).toContain(entry);
  for (const removed of [
    "supertag coordinate",
    "supertag assign task",
    "supertag start objective",
    "--no-start",
    "events team",
    "--reply-to",
    "read_mailbox",
    "update_task",
    "assign_task",
  ])
    expect(text).not.toContain(removed);
});

describe("CLI messaging commands", () => {
  it.each([
    ["tag", "message"],
    ["objective", "message"],
  ])("rejects %s %s without sending or printing the message", async (command, resource) => {
    const { fetch } = fakeOperatorRpc({});
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const message = "--private-message=unpublished-details";

    await expect(
      main(["--control-plane=unused", command, resource, "planner", message, "--output", "json"]),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown (?:Tag |Objective )?command/u),
    );
    expect(error.mock.calls.map(([text]) => String(text)).join("")).not.toContain(message);
    expect(output).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a Tag message from stdin and writes its reply as JSON", async () => {
    const state = mkdtempSync(join(tmpdir(), "supertag-message-cli-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "test-token");
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from("Check the invoices.\n");
    });
    const reply = { text: "Invoices match." };
    const message = { taskId: "task-1", tag: "planner", conversation: "billing", reply };
    const rpc = fakeOperatorRpc({
      "ConversationService/SendMessage": () => message,
      "ConversationService/FollowMessage": async function* () {
        yield { sequence: "1", finish: { reply, message } };
      },
      "ConversationService/GetMessage": () => message,
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        await main([
          "--control-plane=http://127.0.0.1:4321",
          "message",
          "tag",
          "planner",
          "-",
          "--session",
          "billing",
          "--output",
          "json",
        ]),
      ).toBe(0);
      expect(rpc.called("ConversationService/SendMessage")[0]?.body).toEqual({
        tag: "planner",
        conversation: "billing",
        text: "Check the invoices.\n",
      });
      expect(rpc.called("ConversationService/FollowMessage")[0]?.body).toEqual({
        tag: "planner",
        taskId: "task-1",
      });
      expect(JSON.parse(output.mock.calls.map(([value]) => String(value)).join(""))).toEqual(
        message,
      );
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("sends an Objective follow-up and returns its Task ID for automation", async () => {
    const state = mkdtempSync(join(tmpdir(), "supertag-message-cli-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "test-token");
    const result = { taskId: "task-1", tag: "planner" };
    const rpc = fakeOperatorRpc({ "ObjectiveService/MessageObjective": () => result });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        await main([
          "--control-plane=http://127.0.0.1:4321",
          "message",
          "objective",
          "billing",
          "--output=json",
          "--",
          "--help",
        ]),
      ).toBe(0);
      expect(rpc.calls).toEqual([
        {
          method: "ObjectiveService/MessageObjective",
          body: { id: "billing", text: "--help", idempotencyKey: expect.any(String) },
        },
      ]);
      expect(JSON.parse(output.mock.calls.map(([value]) => String(value)).join(""))).toEqual(
        result,
      );
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("follows an Objective's reply in text output", async () => {
    const state = mkdtempSync(join(tmpdir(), "supertag-message-cli-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "test-token");
    const result = { taskId: "task-1", tag: "planner" };
    const reply = { text: "The staging records match." };
    const message = { ...result, conversation: "objective:billing", reply };
    const rpc = fakeOperatorRpc({
      "ObjectiveService/MessageObjective": () => result,
      "ConversationService/GetMessage": () => message,
      "ConversationService/FollowMessage": async function* () {
        yield { sequence: "1", finish: { reply, message } };
        yield { sequence: "2", end: { message } };
      },
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        await main([
          "--control-plane=http://127.0.0.1:4321",
          "message",
          "objective",
          "billing",
          "Check staging.",
        ]),
      ).toBe(0);
      expect(rpc.called("ConversationService/FollowMessage")[0]?.body).toEqual(result);
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toBe(
        "Sent to the conversation of Objective billing.\nThe staging records match.\n",
      );
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("lists a Tag's mailbox through the operator API", async () => {
    const state = mkdtempSync(join(tmpdir(), "supertag-mailbox-cli-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "test-token");
    const method = "MailboxService/ListTagMessages";
    const rpc = fakeOperatorRpc({ [method]: () => ({ messages: [{ id: "message-1" }] }) });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(
        main([
          "--control-plane=http://127.0.0.1:4321",
          "list",
          "message",
          "--mailbox",
          "planner",
          "--limit",
          "5",
        ]),
      ).resolves.toBe(0);
      expect(rpc.calls).toEqual([{ method, body: { tag: "planner", pageSize: 5 } }]);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("message-1"));
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

it("reports the public package version from a checkout", async () => {
  const { readFile } = await import("node:fs/promises");
  const metadata = JSON.parse(
    await readFile(new URL("../packages/supertag-ai/package.json", import.meta.url), "utf8"),
  );
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await main(["--version"]);
  expect(write).toHaveBeenCalledWith(
    `${process.env["SUPERTAG_CLI_VERSION"]?.trim() || metadata.version}\n`,
  );
});
