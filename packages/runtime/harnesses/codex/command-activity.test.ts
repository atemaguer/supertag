import { expect, it } from "vitest";
import { codexCommandStatus, codexCommandText } from "./src/command-activity.ts";

it("maps Codex command items to running, completed, or failed", () => {
  expect(codexCommandStatus("item.started", { status: "in_progress" })).toBe("running");
  expect(codexCommandStatus("item/started", { status: "inProgress" })).toBe("running");
  expect(codexCommandStatus("item.completed", { status: "completed", exit_code: 0 })).toBe(
    "completed",
  );
  expect(codexCommandStatus("item.completed", { status: "completed", exit_code: 2 })).toBe(
    "failed",
  );
  expect(codexCommandStatus("item/completed", { status: "completed", exitCode: 1 })).toBe("failed");
  expect(codexCommandStatus("item/completed", { status: "declined" })).toBe("failed");
  expect(codexCommandStatus("item.completed", { status: "failed" })).toBe("failed");
});

it("reads app-server command lines given as text or an argument list", () => {
  expect(codexCommandText("pnpm test")).toBe("pnpm test");
  expect(codexCommandText(["pnpm", "test"])).toBe("pnpm test");
  expect(codexCommandText([1])).toBeUndefined();
  expect(codexCommandText(undefined)).toBeUndefined();
});
