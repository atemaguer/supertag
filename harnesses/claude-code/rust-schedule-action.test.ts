import { expect, it } from "vitest";
import { admittedTools } from "./src/rust-adapter/adapter.js";

// `schedule:create` offers the `schedule` coordination tools; it grants no native tool.
it("accepts schedule:create without granting a native tool", () => {
  expect(admittedTools(["files:read", "schedule:create"])).toEqual(admittedTools(["files:read"]));
});
