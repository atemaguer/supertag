import { describe, expect, it } from "vitest";
import { parseCreateTeam, parseUpdateTeam } from "./team.js";

const definition = { id: "research", name: "Research", memberTagIds: ["writer", "lead"] };

describe("Team input", () => {
  it("sorts and deduplicates members and leaves concurrency unset by default", () => {
    expect(parseCreateTeam({ ...definition, memberTagIds: ["writer", "lead", "writer"] })).toEqual({
      id: "research",
      name: "Research",
      memberTagIds: ["lead", "writer"],
    });
    expect(parseCreateTeam({ ...definition, maxConcurrency: 4 })).toMatchObject({
      maxConcurrency: 4,
    });
  });

  it("refuses fields of nested or governed Teams", () => {
    for (const field of ["objectiveId", "leadTagId", "parentTeamId", "scaling", "context"])
      expect(() => parseCreateTeam({ ...definition, [field]: "x" })).toThrow(
        `Unknown field: ${field}`,
      );
  });

  it.each([0, 1001, 1.5, "2", true])("refuses maxConcurrency %j", (maxConcurrency) => {
    expect(() => parseCreateTeam({ ...definition, maxConcurrency })).toThrow(
      "maxConcurrency must be an integer from 1 to 1000",
    );
    expect(() => parseUpdateTeam({ expectedRevision: 1, maxConcurrency })).toThrow(
      "maxConcurrency must be an integer from 1 to 1000",
    );
  });

  it("keeps updates partial and lets null remove the concurrency limit", () => {
    expect(parseUpdateTeam({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
    expect(parseUpdateTeam({ expectedRevision: 2, maxConcurrency: null })).toEqual({
      expectedRevision: 2,
      maxConcurrency: null,
    });
    expect(parseUpdateTeam({ expectedRevision: 2, memberTagIds: ["b", "a"] })).toEqual({
      expectedRevision: 2,
      memberTagIds: ["a", "b"],
    });
    expect(() => parseUpdateTeam({ name: "Research" })).toThrow("expectedRevision");
  });
});
