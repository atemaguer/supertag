import { expect, it } from "vitest";
import { openCodeToolActivity } from "./src/index.js";

it("says what an OpenCode tool call did in one line from its input", () => {
  expect(openCodeToolActivity("bash", { command: "go test ./..." })).toBe("Running go test ./...");
  expect(openCodeToolActivity("read", { filePath: "/w/main.go" })).toBe("Reading /w/main.go");
  expect(openCodeToolActivity("edit", { filePath: "/w/main.go" })).toBe("Editing /w/main.go");
  expect(openCodeToolActivity("webfetch", { url: "https://example.com" })).toBe(
    "Fetching https://example.com",
  );
  expect(openCodeToolActivity("custom_tool", undefined)).toBe("Using custom_tool");
});
