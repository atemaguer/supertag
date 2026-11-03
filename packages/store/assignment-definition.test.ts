import type { AdmitTaskAssignmentInput } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { parseAssignmentDefinition } from "./src/assignment-definition.js";

const definition: AdmitTaskAssignmentInput = {
  taskId: "assignment",
  objectiveId: "objective",
  teamId: "team",
  requestedByTagId: "owner",
  assignedTagId: "worker",
  instruction: "Build a prototype",
  acceptanceCriteria: ["Tests pass"],
  execution: {},
  authorizationSnapshot: {
    version: 4,
    capturedAt: "2026-01-01T00:00:00.000Z",
    tag: { id: "worker", name: "Worker" },
    origin: { kind: "internal", objectiveId: "objective", requestedByTagId: "owner" },
    requester: { id: "owner", kind: "bot" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  },
  contextPlan: { version: 7, capturedAt: "2026-01-01T00:00:00.000Z", sets: [] },
  workspacePlan: { version: 1, status: "none" },
};

describe("assignment definition fingerprint", () => {
  it("keeps one fingerprint whether artifact selectors are omitted or empty", () => {
    const expected = "46546a5e75ff78289c87c33140c440e4629daaa8ed5e6f8f659fe189a3cc204f";
    expect(parseAssignmentDefinition(definition)).toEqual({
      items: [],
      cost: 0,
      dependencies: [],
      inputArtifacts: [],
      fingerprint: expected,
    });
    expect(
      parseAssignmentDefinition({
        ...definition,
        inputArtifacts: [],
        requiresApproval: false,
        maxCostMinor: 0,
        items: [],
      }).fingerprint,
    ).toBe(expected);
  });

  it("normalizes statement items and treats changed items as a different definition", () => {
    const parsed = parseAssignmentDefinition({ ...definition, items: ["3", "1", "3"] });
    expect(parsed.items).toEqual(["1", "3"]);
    expect(parseAssignmentDefinition({ ...definition, items: ["1", "3"] }).fingerprint).toBe(
      parsed.fingerprint,
    );
    expect(parseAssignmentDefinition({ ...definition, items: ["1"] }).fingerprint).not.toBe(
      parsed.fingerprint,
    );
    expect(parsed.fingerprint).not.toBe(parseAssignmentDefinition(definition).fingerprint);
  });

  it("preserves normalized dependency identity without mutating the caller's definition", () => {
    const dependencies = Object.freeze(["z", "a", "z"]);
    expect(parseAssignmentDefinition({ ...definition, dependencies })).toMatchObject({
      dependencies: ["a", "z"],
      fingerprint: "27e45df9f1a08fa3f35705450a05b660889d10f9866c39f0d826e0ac274b1f35",
    });
    expect(dependencies).toEqual(["z", "a", "z"]);
  });

  it("preserves the appended artifact projection and treats changed selectors as a different definition", () => {
    const inputArtifacts = [{ artifactId: "source", paths: ["report.md"] }];
    const parsed = parseAssignmentDefinition({ ...definition, inputArtifacts });
    expect(parsed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      parseAssignmentDefinition({
        ...definition,
        inputArtifacts: [{ artifactId: "source", paths: ["other.md"] }],
      }).fingerprint,
    ).not.toBe(parsed.fingerprint);
  });

  it("keeps retry-time snapshots outside identity while definition changes invalidate it", () => {
    const fingerprint = parseAssignmentDefinition(definition).fingerprint;
    expect(
      parseAssignmentDefinition({
        ...definition,
        authorizationSnapshot: {
          ...definition.authorizationSnapshot,
          capturedAt: "2026-02-01T00:00:00.000Z",
        },
        contextPlan: { ...definition.contextPlan, capturedAt: "2026-02-01T00:00:00.000Z" },
      }).fingerprint,
    ).toBe(fingerprint);
    expect(
      parseAssignmentDefinition({ ...definition, instruction: "Build another prototype" })
        .fingerprint,
    ).not.toBe(fingerprint);
  });

  it.each([
    { taskId: "bad id" },
    { instruction: " " },
    { acceptanceCriteria: [] },
    { dependencies: ["assignment"] },
    { maxCostMinor: -1 },
    { maxCostMinor: 1.5 },
    { items: ["one"] },
    { items: "1" },
    { inputArtifacts: [{ taskId: "source", uri: "file:///report.md", unexpected: true }] },
    { inputArtifacts: [{ taskId: "source", uri: "file:///report.md", requireAccepted: "yes" }] },
  ])("rejects invalid definitions before database admission: %j", (invalid) => {
    expect(() => parseAssignmentDefinition({ ...definition, ...invalid })).toThrow();
  });
});
