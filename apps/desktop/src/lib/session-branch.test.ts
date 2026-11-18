import { expect, it } from "vitest";
import { sessionBranch } from "./session-branch";

it("names a Session's branch as the Rust protocol does", async () => {
  // supertag_protocol::session_branch("lead", "conversation/planning")
  expect(await sessionBranch("lead", "conversation/planning")).toBe(
    "supertag/session/f611016e7a44212c81180b5df8a57d3752c0686e91a236cbf8cf7351896aa5b9",
  );
});
