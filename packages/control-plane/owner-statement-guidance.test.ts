import { OBJECTIVE_STATEMENT_TEMPLATE } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { OWNER_STATEMENT_GUIDANCE } from "./src/index.js";

describe("Objective statement template", () => {
  it("names each part in order", () => {
    expect(OBJECTIVE_STATEMENT_TEMPLATE).toBe(
      "<desired end state>. Done when <specific evidence>. Keep <constraints>. Use <boundaries>. Between steps, <how to choose the next action>. If blocked, stop and report <what you tried and what would unlock it>.",
    );
  });

  it("tells the owner to follow the iteration policy and blocked stop condition", () => {
    expect(OWNER_STATEMENT_GUIDANCE).toContain('"Between steps, ..."');
    expect(OWNER_STATEMENT_GUIDANCE).toContain('"If blocked, stop and report ..."');
  });
});
