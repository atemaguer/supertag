import { afterEach, expect, it, vi } from "vitest";
import { formatCliFailure, main } from "./src/index.js";
import { objectiveHelp, runObjectiveCommand } from "./src/objectives.js";
import { runTaskCommand, taskHelp } from "./src/tasks.js";
import { terminalText } from "./src/terminal-text.js";

afterEach(() => vi.restoreAllMocks());

it.each(["help", "not-a-command"])("keeps unknown command %s short", async (command) => {
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await main([command])).toBe(1);
  expect(write).toHaveBeenCalledWith(
    `Unknown command: ${command}\nRun supertag --help for available commands.\n`,
  );
});

it.each([
  [[], "--outcome, --owner"],
  [["--outcome", "Ship it"], "--owner"],
  [["--owner=alice"], "--outcome"],
])("names missing objective flags with one usage line", async (flags, missing) => {
  const error = await runObjectiveCommand({ url: "http://unused", token: "" }, [
    "create",
    ...flags,
  ]).catch((error: unknown) => error);
  const output = formatCliFailure(error, ["create", "objective", ...flags]);
  expect(output).toBe(
    `SuperTag failed: Missing required flag${missing.includes(",") ? "s" : ""}: ${missing}\nUsage: ${objectiveHelp().split("\n")[1]?.trim()}\n`,
  );
});

it.each([{ output: ["--output", "json"] }, { output: ["--output=json"] }])(
  "preserves JSON error bytes",
  ({ output }) => {
    expect(formatCliFailure(new Error(objectiveHelp()), ["create", "objective", ...output])).toBe(
      `SuperTag failed: ${terminalText(objectiveHelp())}\n`,
    );
  },
);

it.each([
  { flags: [], message: "--objective is required and must not be blank" },
  {
    flags: [
      "--objective",
      "demo",
      "--team",
      "build",
      "--tag",
      "builder",
      "--instruction-file",
      "-",
    ],
    message: "At least one --criterion is required",
  },
])("adds task usage to $message", async ({ flags, message }) => {
  const request = vi.fn();
  const error = await runTaskCommand({ request }, "assign", ["demo", ...flags]).catch(
    (error: unknown) => error,
  );
  expect(formatCliFailure(error, ["assign", "task", "demo", ...flags])).toBe(
    `SuperTag failed: ${message}\nUsage: ${taskHelp().split("\n")[1]?.trim()}\n`,
  );
  for (const output of [["--output", "json"], ["--output=json"]]) {
    expect(formatCliFailure(error, ["assign", "task", "demo", ...flags, ...output])).toBe(
      `SuperTag failed: ${message}\n`,
    );
  }
  expect(request).not.toHaveBeenCalled();
});

it.each([
  [
    "deny request requires --reason TEXT",
    ["deny", "request", "demo"],
    "supertag deny request ID --reason TEXT",
  ],
  ["connect worklet requires --worklet-url", ["connect", "worklet"], "supertag connect worklet "],
])("adds usage to %s", (message, args, usage) => {
  const output = formatCliFailure(new Error(message), args);
  expect(output).toContain(`SuperTag failed: ${message}\nUsage: ${usage}`);
  expect(output.trim().split("\n")).toHaveLength(2);
});

it("does not throw while reporting a missing global flag value", () => {
  expect(
    formatCliFailure(new Error("--control-plane requires a configured Control Plane name or URL"), [
      "assign",
      "task",
      "demo",
      "--control-plane",
    ]),
  ).toContain("Usage: supertag assign task ");
});

it("preserves unrelated errors", () => {
  expect(formatCliFailure(new Error("Connection refused"), ["assign", "task", "demo"])).toBe(
    "SuperTag failed: Connection refused\n",
  );
});
