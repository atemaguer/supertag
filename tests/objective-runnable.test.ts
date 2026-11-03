import { describe, expect, it } from "vitest";
import {
  type ObjectiveRunnableFacts,
  objectiveRunnableCondition,
} from "../packages/control-plane/src/objective-runnable.js";
import { parseObjectiveStatus } from "../packages/core/src/index.js";

const at = "2030-01-01T00:00:00.000Z";
const host = (
  id: string,
  connectionStatus: "connected" | "disconnected",
  workspaces: string[] = [],
) => ({
  id,
  enrollmentStatus: "active" as const,
  connectionStatus,
  workerSnapshot: { workspaces },
});
const facts = (overrides: Partial<ObjectiveRunnableFacts> = {}): ObjectiveRunnableFacts => ({
  objective: { status: "working", workspaces: [] },
  owner: { id: "tag-1", name: "planner" },
  boundHostIds: ["laptop"],
  hosts: [host("laptop", "connected")],
  directHosts: [],
  ...overrides,
});

describe("Runnable condition", () => {
  it("shows a provider refusal before an Attempt starts", () => {
    const result = objectiveRunnableCondition(
      facts({
        objective: { status: "working", workspaces: ["app"] },
        cloneableWorkspaces: ["app"],
        hosts: [
          {
            ...host("laptop", "connected"),
            workerSnapshot: {
              workers: [{ profileCapabilities: [{ workspaceRefusal: "e2b lacks setup image" }] }],
            },
          },
        ],
      }),
      at,
    );
    expect(result.status).toBe(false);
    expect(result.reasons).toContain("Worker Host laptop: e2b lacks setup image");
  });
  it("is true when a bound host is connected and declares every named Workspace", () => {
    expect(objectiveRunnableCondition(facts(), at)).toEqual({
      type: "Runnable",
      status: true,
      reasons: [],
    });
    expect(
      objectiveRunnableCondition(
        facts({
          objective: { status: "working", workspaces: ["app"] },
          hosts: [host("laptop", "connected"), host("builder", "disconnected", ["app"])],
          boundHostIds: ["laptop", "builder"],
        }),
        at,
      ).status,
    ).toBe(true);
  });

  it("explains an owner with no host, a disconnected host, and a missing checkout", () => {
    expect(objectiveRunnableCondition(facts({ boundHostIds: [] }), at).reasons).toEqual([
      "Tag planner has no Worker Host, so its Tasks cannot run. Create an Auth Key and join a host with it: supertag create auth-key NAME --tag planner",
    ]);
    expect(
      objectiveRunnableCondition(
        facts({
          objective: { status: "working", workspaces: ["app"] },
          hosts: [host("laptop", "disconnected"), host("other", "connected", ["app"])],
        }),
        at,
      ).reasons,
    ).toEqual([
      "No Worker Host bound to Tag planner is connected (laptop). Its Tasks wait until one connects.",
      "No Worker Host bound to Tag planner declares a checkout of Workspace app. Connect one with: supertag connect worklet --workspace app=PATH",
    ]);
    // A revoked host does not count, while an embedded host reports itself directly.
    expect(
      objectiveRunnableCondition(
        facts({ hosts: [{ ...host("laptop", "connected"), enrollmentStatus: "revoked" }] }),
        at,
      ).status,
    ).toBe(false);
    expect(
      objectiveRunnableCondition(
        facts({
          objective: { status: "working", workspaces: ["app"] },
          hosts: [],
          directHosts: [{ id: "laptop", workspaces: ["app"] }],
        }),
        at,
      ).status,
    ).toBe(true);
  });

  it("explains when no bound host carries the owner's runsOn labels", () => {
    const labelled = (id: string, labels: string[]) => ({ ...host(id, "connected"), labels });
    expect(
      objectiveRunnableCondition(
        facts({
          runsOn: ["macos", "gpu"],
          boundHostIds: ["laptop", "server"],
          hosts: [labelled("laptop", ["macos"]), labelled("server", ["gpu", "linux"])],
        }),
        at,
      ).reasons,
    ).toEqual([
      "No Worker Host bound to Tag planner has labels: macos, gpu. Its Tasks wait until one does. Add labels with: supertag connect worklet --label LABEL, or change the Tag's runsOn.",
    ]);
    expect(
      objectiveRunnableCondition(
        facts({ runsOn: ["mcp:sentry"], hosts: [labelled("laptop", ["mcp:github"])] }),
        at,
      ).reasons,
    ).toContain(
      "Missing MCP server: sentry. Add it to a bound host service's mcp map in supertag.yaml.",
    );
    expect(
      objectiveRunnableCondition(
        facts({ runsOn: ["gpu"], hosts: [labelled("laptop", ["gpu", "macos"])] }),
        at,
      ).status,
    ).toBe(true);
    // A labelled host that lacks the checkout still leaves the Workspace unserved.
    expect(
      objectiveRunnableCondition(
        facts({
          objective: { status: "working", workspaces: ["app"] },
          runsOn: ["gpu"],
          boundHostIds: ["laptop", "server"],
          hosts: [
            labelled("laptop", ["gpu"]),
            { ...host("server", "connected", ["app"]), labels: ["workspace:app"] },
          ],
        }),
        at,
      ).reasons,
    ).toEqual([
      "No Worker Host bound to Tag planner declares a checkout of Workspace app. Connect one with: supertag connect worklet --workspace app=PATH",
    ]);
    expect(
      objectiveRunnableCondition(
        facts({
          runsOn: ["gpu"],
          hosts: [],
          directHosts: [{ id: "laptop", labels: ["gpu"] }],
        }),
        at,
      ).status,
    ).toBe(true);
  });

  it("reports limits that refuse new Tasks", () => {
    expect(
      objectiveRunnableCondition(
        facts({ objective: { status: "working", budgetLimitMinor: 0 } }),
        at,
      ).reasons,
    ).toEqual(["The budget is 0, so no Task can be allocated. Raise it with --budget-minor."]);
    expect(
      objectiveRunnableCondition(
        facts({ objective: { status: "working", deadline: "2029-12-31T00:00:00.000Z" } }),
        at,
      ).reasons,
    ).toEqual(["Objective is past its deadline; new Tasks are refused."]);
    expect(
      objectiveRunnableCondition(facts({ objective: { status: "completed" } }), at).reasons,
    ).toEqual(["Objective is completed; new Tasks are refused."]);
  });
});

describe("owner assessment for review", () => {
  it("accepts a summary with ready_for_review and still rejects it elsewhere", () => {
    expect(
      parseObjectiveStatus({
        status: "ready_for_review",
        expectedRevision: 2,
        completionSummary: " Ready: all checks pass. ",
      }),
    ).toEqual({
      status: "ready_for_review",
      expectedRevision: 2,
      completionSummary: "Ready: all checks pass.",
    });
    expect(parseObjectiveStatus({ status: "ready_for_review", expectedRevision: 2 })).toEqual({
      status: "ready_for_review",
      expectedRevision: 2,
    });
    expect(() =>
      parseObjectiveStatus({ status: "blocked", expectedRevision: 2, completionSummary: "x" }),
    ).toThrow("completionSummary is only valid when completing");
  });
});

describe("Runnable condition with clone support", () => {
  const cloneHost = {
    id: "runner",
    enrollmentStatus: "active" as const,
    connectionStatus: "connected" as const,
    workerSnapshot: {
      workers: [{ capabilities: [{ id: "supertag.workspace.clone", version: 1 }] }],
    },
  };
  it("counts a host that can clone a Workspace with a source", () => {
    const base = {
      objective: { status: "working" as const, workspaces: ["app"] },
      boundHostIds: ["runner"],
      hosts: [cloneHost],
    };
    expect(
      objectiveRunnableCondition(facts({ ...base, cloneableWorkspaces: ["app"] }), at).status,
    ).toBe(true);
    expect(objectiveRunnableCondition(facts(base), at).reasons).toEqual([
      "No Worker Host bound to Tag planner declares a checkout of Workspace app. Connect one with: supertag connect worklet --workspace app=PATH",
    ]);
  });
  it("counts a prepared Workspace provider when the Workspace has a source", () => {
    const providerHost = {
      ...cloneHost,
      workerSnapshot: {
        workers: [{ capabilities: [{ id: "supertag.workspace.environment", version: 1 }] }],
      },
    };
    expect(
      objectiveRunnableCondition(
        facts({
          objective: { status: "working", workspaces: ["app"] },
          boundHostIds: ["runner"],
          hosts: [providerHost],
          cloneableWorkspaces: ["app"],
        }),
        at,
      ).status,
    ).toBe(true);
  });
});

describe("recorded harness sign-in failures", () => {
  const workers = ["claude-code", "codex"].map((harness) => ({
    id: harness,
    profileCapabilities: [{ harness }],
  }));
  const observations = ["claude-code", "codex"].map((harness) => ({
    workerHostId: "laptop",
    workerId: harness,
    harness,
    status: "failed" as const,
    failureKind: "harness",
    startedAt: at,
    error: harness === "claude-code" ? "Please run /login" : "Please run codex login",
  }));
  const ready = (signInAttempts = observations, harness?: string) =>
    facts({
      hosts: [{ ...host("laptop", "connected"), workerSnapshot: { workers } }],
      signInAttempts,
      ...(harness ? { harness } : {}),
    });

  it("does not report runnable when every eligible harness last failed sign-in", () => {
    const condition = objectiveRunnableCondition(ready(), at);
    expect(condition.status).toBe(false);
    expect(condition.reasons.join(" ")).toContain("sign-in");
    expect(condition.reasons.join(" ")).toContain("Please run /login");
  });

  it("recognizes the Codex adapter's missing credential failure", () => {
    expect(
      objectiveRunnableCondition(
        ready(
          observations.map((entry) => ({
            ...entry,
            error:
              "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
          })),
          "codex",
        ),
        at,
      ).status,
    ).toBe(false);
  });

  it.each(["workspace-setup", "workspace-integrity", "mcp", "unknown"])(
    "does not block on %s authentication errors",
    (failureKind) => {
      expect(
        objectiveRunnableCondition(
          ready(
            observations.map((entry) => ({
              ...entry,
              failureKind,
              error: "Authentication failed: Please run codex login",
            })),
          ),
          at,
        ).status,
      ).toBe(true);
    },
  );

  it("keeps an untried alternative available and respects the selected harness", () => {
    expect(objectiveRunnableCondition(ready(observations.slice(0, 1)), at).status).toBe(true);
    expect(
      objectiveRunnableCondition(ready(observations.slice(0, 1), "claude-code"), at).status,
    ).toBe(false);
  });

  it("does not let an older failure override a later successful attempt", () => {
    const current = ready();
    expect(
      objectiveRunnableCondition(
        {
          ...current,
          signInAttempts: [
            ...observations,
            {
              workerHostId: "laptop",
              workerId: "claude-code",
              harness: "claude-code",
              status: "completed",
              error: undefined,
              startedAt: "2030-01-02T00:00:00.000Z",
            },
          ],
        },
        at,
      ).status,
    ).toBe(true);
  });

  it("checks embedded hosts and excludes hosts missing placement labels", () => {
    const current = ready();
    expect(
      objectiveRunnableCondition(
        { ...current, hosts: [], directHosts: [{ id: "laptop", workerSnapshot: { workers } }] },
        at,
      ).status,
    ).toBe(false);
    expect(
      objectiveRunnableCondition(
        {
          ...current,
          runsOn: ["allowed"],
          hosts: [
            {
              ...current.hosts[0],
              ...host("laptop", "connected"),
              labels: ["allowed"],
              workerSnapshot: { workers },
            },
            { ...host("other", "connected"), labels: [], workerSnapshot: { workers } },
          ],
          boundHostIds: ["laptop", "other"],
        },
        at,
      ).status,
    ).toBe(false);
  });

  it("does not count a host without the required Workspace as an alternative", () => {
    const current = ready();
    expect(
      objectiveRunnableCondition(
        {
          ...current,
          objective: { status: "working", workspaces: ["app"] },
          boundHostIds: ["laptop", "other"],
          hosts: [
            { ...host("laptop", "connected"), workerSnapshot: { workspaces: ["app"], workers } },
            { ...host("other", "connected"), workerSnapshot: { workers } },
          ],
        },
        at,
      ).status,
    ).toBe(false);
  });

  it("does not count a harness forbidden to run the Objective's commands as an alternative", () => {
    const current = ready(observations.filter((entry) => entry.harness === "codex"));
    expect(
      objectiveRunnableCondition(
        {
          ...current,
          objective: { status: "working", runtimeActions: ["commands:execute"] },
          hosts: [
            {
              ...host("laptop", "connected"),
              workerSnapshot: {
                workers: [
                  {
                    id: "claude-code",
                    profileCapabilities: [
                      {
                        harness: "claude-code",
                        capabilities: [{ id: "supertag.commands.unsandboxed", version: 1 }],
                      },
                    ],
                  },
                  {
                    id: "codex",
                    profileCapabilities: [
                      {
                        harness: "codex",
                        capabilities: [{ id: "supertag.commands.execute", version: 1 }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        at,
      ).status,
    ).toBe(false);
  });

  it("does not reuse another host or Worker's sign-in failure", () => {
    expect(
      objectiveRunnableCondition(
        ready(observations.map((entry) => ({ ...entry, workerHostId: "other" }))),
        at,
      ).status,
    ).toBe(true);
    expect(
      objectiveRunnableCondition(
        ready(observations.map((entry) => ({ ...entry, workerId: "other" }))),
        at,
      ).status,
    ).toBe(true);
  });

  it("ignores disconnected alternatives and unrelated failures", () => {
    const current = ready();
    expect(
      objectiveRunnableCondition(
        {
          ...current,
          hosts: [
            ...current.hosts,
            {
              ...host("offline", "disconnected"),
              workerSnapshot: { workers },
            },
          ],
          boundHostIds: ["laptop", "offline"],
        },
        at,
      ).status,
    ).toBe(false);
    expect(
      objectiveRunnableCondition(
        ready(observations.map((entry) => ({ ...entry, error: "Connection timed out" }))),
        at,
      ).status,
    ).toBe(true);
  });
});
