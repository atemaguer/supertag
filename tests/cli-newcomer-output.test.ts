import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliFailureExitCode, formatCliFailure, main } from "../apps/cli/src/index.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

describe("newcomer-facing CLI output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    "supertag message tag NAME TEXT|- [--session NAME] [--output text|json] (deprecated)",
    "supertag message objective ID TEXT|- [--output text|json] (deprecated)",
  ])
    expect(text).toContain(entry);
  // The Objective controller's commands and tools are gone from the surface.
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

it.each(["tag", "objective"] as const)(
  "warns about message %s only for interactive text output",
  async (kind) => {
    const state = mkdtempSync(join(tmpdir(), "supertag-message-deprecation-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "test-token");
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const tty = (stream: typeof process.stdin | typeof process.stdout, value: boolean) =>
      Object.defineProperty(stream, "isTTY", { configurable: true, value });
    const message = {
      tag: "planner",
      conversation: "default",
      taskId: "task-1",
      status: "REPLY_STATUS_REPLIED",
      reply: { presentation: "REPLY_PRESENTATION_FINAL_RESULT", text: "Hello." },
    };
    fakeOperatorRpc({
      "ConversationService/SendMessage": () => message,
      "ConversationService/GetMessage": () => message,
      "ConversationService/FollowMessage": async function* () {
        yield { sequence: "1", finish: { reply: message.reply, message } };
        yield { sequence: "2", end: { message } };
      },
      "ObjectiveService/MessageObjective": () => ({ tag: "planner", taskId: message.taskId }),
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const send = (...args: string[]) =>
      main(["--control-plane=http://127.0.0.1:4321", "message", kind, "planner", "Hello", ...args]);
    const stdoutText = () => output.mock.calls.map(([text]) => String(text)).join("");
    const replacement = kind === "tag" ? "select a Tag" : "select the Objective, and press m";
    try {
      tty(process.stdin, true);
      tty(process.stdout, true);
      expect(await main(["message", kind, "--help"])).toBe(0);
      expect(stdoutText()).toContain(`supertag message ${kind} is deprecated.`);
      expect(stdoutText()).toContain(replacement);
      expect(warning).not.toHaveBeenCalled();

      expect(await send("--output", "text")).toBe(0);
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(replacement));
      warning.mockClear();
      for (const flags of [["--output", "json"], ["--output=json"]]) {
        output.mockClear();
        expect(await send(...flags)).toBe(0);
        expect(JSON.parse(stdoutText())).toMatchObject({ taskId: message.taskId });
      }
      tty(process.stdout, false);
      expect(await send()).toBe(0);
      tty(process.stdout, true);
      tty(process.stdin, false);
      expect(await send()).toBe(0);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(state, { recursive: true, force: true });
    }
  },
);

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
