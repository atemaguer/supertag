import { describe, expect, it } from "vitest";
import { parseCreateTeam, parseUpdateTeam, resolveTeamScaling } from "./team.js";

const definition = {
  id: "research",
  objectiveId: "launch",
  name: "Research",
  leadTagId: "lead",
  memberTagIds: ["lead"],
  maxConcurrency: 4,
};

describe("Team scaling input", () => {
  it("defaults new Teams to no local limits without changing concurrency", () => {
    expect(parseCreateTeam(definition)).toMatchObject({ scaling: {}, maxConcurrency: 4 });
  });

  it("preserves zero and the largest safe integer as explicit limits", () => {
    const scaling = { maxBreadth: 0, maxDepth: Number.MAX_SAFE_INTEGER };
    expect(parseCreateTeam({ ...definition, scaling }).scaling).toEqual(scaling);
    expect(parseUpdateTeam({ expectedRevision: 1, scaling }).scaling).toEqual(scaling);
  });

  it("keeps updates partial so omitted limits cannot reset stored limits", () => {
    expect(parseUpdateTeam({ expectedRevision: 1 })).not.toHaveProperty("scaling");
    expect(parseUpdateTeam({ expectedRevision: 1, scaling: {} }).scaling).toEqual({});
    expect(parseUpdateTeam({ expectedRevision: 1, scaling: { maxDepth: 0 } }).scaling).toEqual({
      maxDepth: 0,
    });
    expect(parseUpdateTeam({ expectedRevision: 1, scaling: { maxBreadth: 3 } }).scaling).toEqual({
      maxBreadth: 3,
    });
  });

  it.each(["maxBreadth", "maxDepth"])(
    "rejects invalid %s limits at both input boundaries",
    (key) => {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "2", null, true]) {
        const scaling = { [key]: value };
        expect(() => parseCreateTeam({ ...definition, scaling })).toThrow(
          `scaling.${key} must be a nonnegative safe integer`,
        );
        expect(() => parseUpdateTeam({ expectedRevision: 1, scaling })).toThrow(
          `scaling.${key} must be a nonnegative safe integer`,
        );
      }
    },
  );

  it.each([null, [], 1, "unlimited", { reset: true }, { maxChildren: 3 }])(
    "rejects unsupported scaling shapes and reset commands: %j",
    (scaling) => {
      expect(() => parseCreateTeam({ ...definition, scaling })).toThrow();
      expect(() => parseUpdateTeam({ expectedRevision: 1, scaling })).toThrow();
    },
  );
});

describe("inherited Team scaling", () => {
  it("does not create a limit for empty or undeclared lineages", () => {
    expect(resolveTeamScaling([])).toEqual({});
    expect(resolveTeamScaling([{ id: "root", scaling: {} }])).toEqual({});
  });

  it("retains independent strongest ancestors and decrements depth per edge", () => {
    expect(
      resolveTeamScaling([
        { id: "root", scaling: { maxBreadth: 2, maxDepth: 5 } },
        { id: "parent", scaling: { maxBreadth: 8, maxDepth: 2 } },
        { id: "target", scaling: { maxDepth: 10 } },
      ]),
    ).toEqual({ maxBreadth: 2, maxBreadthTeamId: "root", maxDepth: 1, maxDepthTeamId: "parent" });
  });

  it("allows descendants to tighten breadth and depth but never relax ancestors", () => {
    expect(
      resolveTeamScaling([
        { id: "root", scaling: { maxBreadth: 4, maxDepth: 8 } },
        { id: "target", scaling: { maxBreadth: 0, maxDepth: 0 } },
      ]),
    ).toEqual({ maxBreadth: 0, maxBreadthTeamId: "target", maxDepth: 0, maxDepthTeamId: "target" });
  });

  it("keeps an exceeded ancestor depth visible rather than clamping it to zero", () => {
    expect(
      resolveTeamScaling([
        { id: "root", scaling: { maxDepth: 0 } },
        { id: "child", scaling: {} },
      ]),
    ).toEqual({ maxDepth: -1, maxDepthTeamId: "root" });
  });

  it("reports the nearest declaration when effective limits tie", () => {
    expect(
      resolveTeamScaling([
        { id: "root", scaling: { maxBreadth: 3, maxDepth: 2 } },
        { id: "child", scaling: { maxBreadth: 3, maxDepth: 1 } },
      ]),
    ).toEqual({ maxBreadth: 3, maxBreadthTeamId: "child", maxDepth: 1, maxDepthTeamId: "child" });
  });
});
