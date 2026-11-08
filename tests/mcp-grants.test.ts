import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  placeTask,
  taskPlacementLabels,
  workspaceMcpServers,
} from "../packages/control-plane/src/label-placement.ts";
import { capturePermissionBundle } from "../packages/control-plane/src/roles.ts";
import {
  approvalActionsMatch,
  approvalRequirementFor,
  approvalRequirementsFromPermissions,
  mcpGrantActionMatches,
  mcpPlacementLabels,
  mcpToolPatternMatches,
  parseApprovalActionDescriptor,
  parseMcpGrantAction,
  parseMcpGrantResource,
  restrictApprovalRequirements,
} from "../packages/core/src/index.ts";
import { decodeTaskAttemptSpec } from "../packages/runtime/transport/src/attempt-codec.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { repositoryAttempt } from "./support/repository-execution.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MCP grant actions", () => {
  it.each([
    ["get_issue", "get_issue", true],
    ["get_issue", "get_issue_details", false],
    ["get_issue", "Get_Issue", false],
    ["get_*", "get_", true],
    ["get_*", "get_issue", true],
    ["get_*", "GET_issue", false],
    ["*", "anything.at-all_1", true],
    ["*_issue", "get_issue", true],
    ["*_issue", "get_issue_", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "aXbYc", true],
    ["a*b*c", "acb", false],
    ["get.*", "get.issue", true],
    ["get.*", "getXissue", false],
    // Tool names outside the specification's characters never match, even `*`.
    ["*", "get issue", false],
    ["*", "get/issue", false],
    ["*", "get_іssue", false],
    ["*", "get_issue\u0000", false],
    ["*", "", false],
    ["get_issue", "get_issuе", false],
  ])("pattern %j against tool %j is %s", (pattern, tool, expected) => {
    expect(mcpToolPatternMatches(pattern, tool)).toBe(expected);
  });

  it("matches the server exactly", () => {
    expect(mcpGrantActionMatches("sentry/get_issue", "sentry", "get_issue")).toBe(true);
    expect(mcpGrantActionMatches("sentry/get_issue", "sentry2", "get_issue")).toBe(false);
    expect(mcpGrantActionMatches("sentry/*", "Sentry", "get_issue")).toBe(false);
    expect(mcpGrantActionMatches("sentry/*/x", "sentry", "get_issue")).toBe(false);
  });

  it.each([
    "sentry",
    "sentry/",
    "/get_issue",
    "*/get_issue",
    "Sentry/get_issue",
    "sentry/get issue",
    "sentry/get/issue",
    "sentry/get?issue",
    "sentry/[a-z]*",
    "sentry/get_іssue",
    "supertag-coordination/read_session",
    `sentry/${"a".repeat(129)}`,
  ])("rejects action %j", (action) => {
    expect(() => parseMcpGrantAction(action)).toThrow();
  });

  it("validates resources as kind:value without spaces or wildcards", () => {
    expect(parseMcpGrantResource("repository:acme/api")).toBe("repository:acme/api");
    expect(parseMcpGrantResource("channel:C0123")).toBe("channel:C0123");
    for (const resource of [
      "acme/api",
      "repository:",
      "repository:acme/*",
      "repository: acme/api",
      "Repository:acme/api",
      "repository:acme/аpi",
      "repository:acme\napi",
    ])
      expect(() => parseMcpGrantResource(resource), resource).toThrow();
  });

  it("names the placement labels of the servers a Task's grants use", () => {
    expect(
      mcpPlacementLabels([
        { action: "sentry/get_issue" },
        { action: "notion/*" },
        { action: "sentry/update_issue" },
      ]),
    ).toEqual(["mcp:notion", "mcp:sentry"]);
    expect(taskPlacementLabels(["macos"], { mcp: [{ action: "sentry/*" }] })).toEqual([
      "macos",
      "mcp:sentry",
    ]);
    expect(taskPlacementLabels(["macos"], {})).toEqual(["macos"]);
    expect(taskPlacementLabels(["macos"], { mcp: [{ action: "sentry/*" }] }, ["sentry"])).toEqual([
      "macos",
    ]);
    expect(workspaceMcpServers({ mcp: [{ action: "sentry/*" }] }, ["sentry", "notion"])).toEqual([
      "sentry",
    ]);
  });

  it("checks a Workspace server against each candidate host on its own", async () => {
    const grants = { mcp: [{ action: "sentry/get_issue" }] };
    const plan = { version: 1, status: "workspace", workspace: "app", mcp: ["sentry"] } as never;
    const place = (bound: string[], hosts: { id: string; labels: string[] }[]) =>
      placeTask(
        bound,
        taskPlacementLabels([], grants, ["sentry"]),
        { ...(plan as object), source: "https://example.com/app.git" } as never,
        async () =>
          hosts.map((host) => ({
            ...host,
            enrollmentStatus: "active" as const,
            labels: [...host.labels, "workspace:app"],
          })) as never,
        workspaceMcpServers(grants, ["sentry"]),
      );
    // Another host declaring sentry no longer holds the Task on a host that does not.
    await expect(
      place(
        ["laptop"],
        [
          { id: "laptop", labels: [] },
          { id: "server", labels: ["mcp:sentry"] },
        ],
      ),
    ).resolves.toMatchObject({ status: "eligible", tiers: [{ allowedWorkerHostIds: ["laptop"] }] });
    await expect(
      place(
        ["laptop", "server"],
        [
          { id: "laptop", labels: [] },
          { id: "server", labels: ["mcp:sentry"] },
        ],
      ),
    ).resolves.toMatchObject({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["laptop", "server"] }],
    });
    // A candidate that declares the server uses its own, so its lapsed login holds it there.
    await expect(
      place(
        ["laptop", "server"],
        [
          { id: "laptop", labels: [] },
          { id: "server", labels: ["mcp-login:sentry"] },
        ],
      ),
    ).resolves.toMatchObject({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["laptop"] }],
    });
    await expect(
      place(["server"], [{ id: "server", labels: ["mcp-login:sentry"] }]),
    ).resolves.toMatchObject({
      status: "unmet",
      missingLabels: ["mcp:sentry"],
      mcpLogins: ["sentry"],
    });
  });

  it("places a Task only on a bound host that provides its granted servers", async () => {
    const hosts = [
      { id: "laptop", enrollmentStatus: "active" as const, labels: ["mcp:notion"] },
      { id: "server", enrollmentStatus: "active" as const, labels: ["mcp:sentry", "mcp:notion"] },
    ];
    const plan = { status: "none" } as never;
    await expect(
      placeTask(
        ["laptop", "server"],
        taskPlacementLabels([], { mcp: [{ action: "sentry/get_issue" }] }),
        plan,
        async () => hosts as never,
      ),
    ).resolves.toMatchObject({ status: "eligible", tiers: [{ allowedWorkerHostIds: ["server"] }] });
    await expect(
      placeTask(
        ["laptop"],
        taskPlacementLabels([], { mcp: [{ action: "sentry/get_issue" }] }),
        plan,
        async () => hosts as never,
      ),
    ).resolves.toMatchObject({ status: "unmet", missingLabels: ["mcp:sentry"] });
  });
});

describe("MCP approval requirements", () => {
  const requirements = approvalRequirementsFromPermissions(
    [{ id: "set", name: "triage", approvers: ["tag:lead"] }],
    [
      { permissionSetId: "set", target: "mcp", action: "sentry/update_*", approval: "required" },
      {
        permissionSetId: "set",
        target: "mcp",
        action: "github/merge_pull_request",
        resource: "repository:acme/api",
        approval: "required",
      },
      { permissionSetId: "set", target: "mcp", action: "sentry/get_issue" },
    ],
  );

  it("freezes each approval: required grant with its resource", () => {
    expect(requirements).toEqual([
      {
        target: "mcp",
        action: "github/merge_pull_request",
        resource: "repository:acme/api",
        permissionSets: ["triage"],
        approvers: ["tag:lead"],
      },
      {
        target: "mcp",
        action: "sentry/update_*",
        permissionSets: ["triage"],
        approvers: ["tag:lead"],
      },
    ]);
    expect(restrictApprovalRequirements(requirements, []).approvals).toEqual(requirements);
  });

  it("covers concrete calls by glob and resource, and calls whose resource is unknown", () => {
    const find = (action: string, resource?: string) =>
      approvalRequirementFor(requirements, {
        target: "mcp",
        action,
        ...(resource === undefined ? {} : { resource }),
      });
    expect(find("sentry/update_issue")).toMatchObject({ action: "sentry/update_*" });
    expect(find("sentry/get_issue")).toBeUndefined();
    expect(find("sentry/Update_issue")).toBeUndefined();
    expect(find("github/merge_pull_request", "repository:acme/api")).toBeDefined();
    expect(find("github/merge_pull_request", "repository:acme/web")).toBeUndefined();
    expect(find("github/merge_pull_request")).toBeDefined();
  });

  it("parses MCP action descriptors and keeps their resource in matching", () => {
    const action = parseApprovalActionDescriptor({
      target: "mcp",
      action: "github/merge_pull_request",
      resource: "repository:acme/api",
      toolName: "merge_pull_request",
    });
    expect(action).toEqual({
      target: "mcp",
      action: "github/merge_pull_request",
      resource: "repository:acme/api",
      toolName: "merge_pull_request",
    });
    expect(approvalActionsMatch(action, { ...action, resource: "repository:acme/web" })).toBe(
      false,
    );
    expect(approvalActionsMatch(action, { target: "mcp", action: action.action })).toBe(false);
    for (const invalid of [
      { target: "mcp", action: "github/*" },
      { target: "mcp", action: "github/merge_pull_request", resource: "repository:*" },
      { target: "mcp", action: "github/merge_pull_request", scope: "repository:1" },
      { target: "runtime", action: "commands:execute", resource: "repository:acme/api" },
    ])
      expect(() => parseApprovalActionDescriptor(invalid), JSON.stringify(invalid)).toThrow();
  });
});

describe("stored MCP permissions", () => {
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-grants-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const value = new DrizzleStore({ url });
    await value.connect();
    cleanups.push(() => value.disconnect());
    return value;
  }

  it("stores grants once, with and without a resource, and freezes them into a bundle", async () => {
    const s = await store();
    const set = await s.createTagPermissionSet({ name: "triage" });
    const add = (action: string, extra: Record<string, unknown> = {}) =>
      s.addTagPermission({ permissionSetId: set.id, target: "mcp", action, ...extra });
    const first = await add("sentry/get_issue");
    expect(await add("sentry/get_issue")).toEqual(first);
    const scoped = await add("github/create_pull_request", { resource: "repository:acme/api" });
    expect(scoped).toMatchObject({ target: "mcp", resource: "repository:acme/api" });
    expect(await add("github/create_pull_request", { resource: "repository:acme/api" })).toEqual(
      scoped,
    );
    await add("github/create_pull_request");
    await add("sentry/update_*", { approval: "required" });
    await expect(add("Sentry/get_issue")).rejects.toThrow();
    await expect(add("sentry/get issue")).rejects.toThrow();
    await expect(add("sentry/x", { resource: "repository:acme/*" })).rejects.toThrow();
    const stored = await s.listTagPermissions({ permissionSetId: set.id });
    expect(stored.filter((permission) => permission.target === "mcp")).toHaveLength(4);
    expect(
      stored.find((permission) => permission.action === "sentry/get_issue"),
    ).not.toHaveProperty("resource");

    const bundle = await capturePermissionBundle(s, [set.id]);
    expect(bundle.mcp).toEqual([
      { action: "github/create_pull_request" },
      { action: "github/create_pull_request", resource: "repository:acme/api" },
      { action: "sentry/get_issue" },
      { action: "sentry/update_*" },
    ]);
    expect(bundle.resources).toEqual([]);
    expect(bundle.approvals).toEqual([
      { target: "mcp", action: "sentry/update_*", permissionSets: ["triage"], approvers: [] },
    ]);
  });
});

describe("Task Attempt wire format", () => {
  it("accepts MCP grants and MCP approval requirements and rejects malformed ones", () => {
    const spec = repositoryAttempt("test");
    const withMcp = (mcp: unknown, approvals?: unknown) => ({
      ...spec,
      authorization: {
        ...spec.authorization,
        mcp,
        ...(approvals === undefined ? {} : { approvals }),
      },
    });
    expect(
      decodeTaskAttemptSpec(
        withMcp(
          [{ action: "sentry/*" }, { action: "github/x", resource: "repository:acme/api" }],
          [
            {
              target: "mcp",
              action: "sentry/update_*",
              permissionSets: ["triage"],
              approvers: [],
            },
          ],
        ),
      ),
    ).toBeDefined();
    expect(() => decodeTaskAttemptSpec(withMcp([{ resource: "x:y" }]))).toThrow();
    expect(() => decodeTaskAttemptSpec(withMcp([{ action: "a/b", resource: "" }]))).toThrow();
    expect(() => decodeTaskAttemptSpec(withMcp("sentry/*"))).toThrow();
  });
});
