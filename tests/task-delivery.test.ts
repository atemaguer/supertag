import { describe, expect, it } from "vitest";
import {
  taskDelivery,
  workspaceBranchHeadPin,
  workspaceBranchPin,
  workspacePatchName,
  workspacePullRequestReference,
} from "../packages/core/src/index.ts";

const BRANCH = "supertag/ship-sso/build";
const plan = (delivery: "branch" | "patch" | "pull-request") => ({
  version: 1 as const,
  status: "workspace" as const,
  workspace: "app",
  branch: BRANCH,
  delivery,
});
const result = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  payload: {
    result: {
      summary: "Done",
      decisions: [],
      changes: [
        {
          summary: `Workspace app: branch ${BRANCH} at 0123456789ab with 3 changed files since fedcba987654`,
          reference: `git:${BRANCH}@0123456789abcdef0123456789abcdef01234567`,
        },
      ],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [],
      ...overrides,
    },
  },
});
const progress = {
  type: "progress.updated",
  payload: {
    progress: {
      summary: `Committed workspace app changes to ${BRANCH}`,
      items: [
        { id: "workspace-branch", text: `Branch: ${BRANCH}`, status: "completed" },
        { id: "workspace-base", text: "Base: fedcba9876543210fedcba9876543210fedcba98" },
      ],
    },
  },
};

describe("Task delivery", () => {
  it("pins only Worker workspace manifests and displays the allocated branch", () => {
    const recorded = {
      type: "runtime-inputs.resolved",
      payload: {
        manifest: {
          inputs: [
            {
              kind: "workspace",
              resource: {
                provenance: { provider: "supertag-workspace", workspace: "app", branch: BRANCH },
              },
            },
          ],
        },
      },
    };
    expect(workspaceBranchPin([progress, result()], "app")).toBeUndefined();
    expect(workspaceBranchPin([recorded], "elsewhere")).toBeUndefined();
    expect(workspaceBranchPin([recorded], "app")).toBe(BRANCH);
    expect(workspaceBranchHeadPin([recorded, progress], "app")).toBeUndefined();
    expect(
      taskDelivery({
        workspacePlan: { ...plan("branch"), branch: "supertag/ship-sso/build-before-collision" },
        events: [recorded, progress, result()],
      })?.workspace,
    ).toMatchObject({ branch: BRANCH, head: "0123456789abcdef0123456789abcdef01234567" });
  });

  it("pins only a full Worker-recorded head for the recorded branch", () => {
    const head = "a".repeat(40);
    const recorded = {
      type: "runtime-inputs.resolved",
      payload: {
        manifest: {
          inputs: [
            {
              kind: "workspace",
              resource: {
                provenance: { provider: "supertag-workspace", workspace: "app", branch: BRANCH },
              },
            },
          ],
        },
      },
    };
    const progressFor = (branch: string, commit: string) => ({
      type: "progress.updated",
      payload: {
        progress: {
          items: [
            { id: "workspace-branch", text: `Branch: ${branch}` },
            { id: "workspace-base", text: `Base: ${"b".repeat(40)}` },
            { id: "workspace-head", text: `Head: ${commit}` },
          ],
        },
      },
    });
    expect(workspaceBranchHeadPin([recorded, progressFor(BRANCH, head)], "app")).toBe(head);
    expect(workspaceBranchHeadPin([progressFor(BRANCH, head)], "app")).toBeUndefined();
    expect(
      workspaceBranchHeadPin([recorded, progressFor("supertag/other/task", head)], "app"),
    ).toBeUndefined();
    expect(
      workspaceBranchHeadPin([recorded, progressFor(BRANCH, "abc1234")], "app"),
    ).toBeUndefined();
  });

  it("is absent until a result is recorded", () => {
    expect(taskDelivery({ workspacePlan: plan("branch"), events: [progress] })).toBeUndefined();
  });

  it("reads a branch delivery's head, base, and changed files", () => {
    expect(taskDelivery({ workspacePlan: plan("branch"), events: [progress, result()] })).toEqual({
      workspace: {
        name: "app",
        delivery: "branch",
        branch: BRANCH,
        head: "0123456789abcdef0123456789abcdef01234567",
        changedFiles: 3,
        base: "fedcba9876543210fedcba9876543210fedcba98",
      },
      patches: [],
      outputs: [],
    });
  });

  it("separates patch artifacts from other outputs and reads the pull request", () => {
    const delivered = taskDelivery({
      workspacePlan: plan("pull-request"),
      events: [
        result({
          artifacts: [
            { artifactId: "art-1", paths: [workspacePatchName(BRANCH), "outputs/report.md"] },
          ],
          references: [
            workspacePullRequestReference({
              repository: "acme/app",
              number: 7,
              url: "https://github.com/acme/app/pull/7",
            }),
          ],
        }),
        {
          type: "workspace.pull-request.ready",
          payload: { url: "https://github.com/acme/app/pull/7" },
        },
      ],
    });
    expect(delivered?.patches).toEqual([
      { artifactId: "art-1", path: "supertag-ship-sso-build.patch" },
    ]);
    expect(delivered?.outputs).toEqual([{ artifactId: "art-1", paths: ["outputs/report.md"] }]);
    expect(delivered?.pullRequest).toMatchObject({ number: 7, state: "ready" });
  });

  it("falls back to the stored result and ignores Tasks without anything to deliver", () => {
    const stored = result().payload.result;
    expect(
      taskDelivery({ workspacePlan: plan("branch"), result: stored, events: [] })?.workspace,
    ).toMatchObject({ head: "0123456789abcdef0123456789abcdef01234567" });
    expect(
      taskDelivery({
        workspacePlan: { status: "none" },
        result: { ...stored, changes: [] },
        events: [],
      }),
    ).toBeUndefined();
  });
});
