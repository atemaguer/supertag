import { expect, it } from "vitest";
import { validateActions } from "./src/rust-adapter/workspace.js";

// Cursor fails closed on unknown actions; `schedule:create` only offers the coordination tools.
it("accepts schedule:create and still refuses unknown actions", () => {
  expect(() => validateActions(["files:read", "schedule:create"], false)).not.toThrow();
  expect(() => validateActions(["files:read", "schedule:delete"], false)).toThrow();
});
