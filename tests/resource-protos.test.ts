import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  type ResourceView,
  resourceMessage,
  resourceView,
} from "../apps/cli/src/resource-protos.ts";
import { ResourceSchema } from "../packages/operator-api/src/index.ts";

const at = "2026-11-01T09:30:00.120Z";
const metadata = (id: string, name: string) => ({
  id,
  name,
  resourceVersion: `${id}-version`,
  createdAt: at,
  updatedAt: at,
});

/** Each kind as the Control Plane builds it, with every optional field it can carry. */
const views: readonly ResourceView[] = [
  {
    apiVersion: "supertag/v1",
    kind: "Tag",
    metadata: metadata("tag-1", "builder"),
    spec: {
      roles: ["Engineer"],
      workerHosts: ["laptop"],
      runsOn: ["harness:codex"],
      execution: { harness: "codex", model: ["gpt-5", "gpt-5-mini"], effort: ["low", "high"] },
      locations: [
        {
          provider: "github",
          account: "acme",
          repoId: "R_1",
          permissionSets: ["deploy"],
          workspaces: ["app", "docs"],
        },
        { provider: "lark", account: "cli_1", chatId: "oc_1", contextSets: ["guides"] },
        { provider: "linear", account: "org-1", teamId: "team-1" },
        { provider: "slack", account: "T1", channelId: "C1" },
        { provider: "teams", account: "tenant", teamId: "t", channelId: "c" },
      ],
      acceptsMessagesFrom: ["reviewer"],
    },
    status: {
      phase: "retired",
      retiredAt: at,
      execution: { harness: "codex" },
      locations: [{ provider: "slack", account: "Acme", target: "channel:C1", enabled: false }],
    },
  },
  {
    apiVersion: "supertag/v1",
    kind: "Tag",
    metadata: metadata("tag-2", "plain"),
    spec: { roles: [], workerHosts: [], runsOn: [], locations: [], acceptsMessagesFrom: [] },
    status: { phase: "active", locations: [] },
  },
  {
    apiVersion: "supertag/v1",
    kind: "Role",
    metadata: metadata("role-1", "Engineer"),
    spec: {
      purpose: "Ship reviewed changes.",
      instructions: "",
      contextSets: ["guides"],
      permissionSets: [],
      execution: { effort: ["medium"] },
    },
    status: { phase: "active", assignedTags: ["builder"] },
  },
  {
    apiVersion: "supertag/v1",
    kind: "PermissionSet",
    metadata: metadata("set-1", "deploy"),
    spec: {
      approvers: ["operator:admin"],
      permissions: [
        {
          id: "p-1",
          permissionSetId: "set-1",
          action: "chat:write",
          approval: "required",
          createdBy: "admin",
          createdAt: at,
          target: "surface",
          surfaceAccountId: "account-1",
          scope: "channel:C1",
          reference: "C1",
        },
        {
          id: "p-2",
          permissionSetId: "set-1",
          action: "commands:execute",
          createdAt: at,
          target: "runtime",
        },
        {
          id: "p-3",
          permissionSetId: "set-1",
          action: "linear/*",
          createdAt: at,
          target: "mcp",
          resource: "team:ENG",
        },
      ],
    },
    status: { phase: "active", bindings: ["route-1"] },
  },
  {
    apiVersion: "supertag/v1",
    kind: "ContextSet",
    metadata: metadata("context-1", "guides"),
    spec: {
      items: [
        {
          id: "item-1",
          contextSetId: "context-1",
          itemKey: "skill:review",
          type: "supertag/skill",
          version: 1,
          required: true,
          config: { reference: "review", nested: { depth: [1, 2] } },
          createdBy: "admin",
          createdAt: at,
        },
      ],
    },
    status: { phase: "active", bindings: [] },
  },
  {
    apiVersion: "supertag/v1",
    kind: "Volume",
    metadata: metadata("volume-1", "datasets"),
    spec: { source: "s3://bucket/prefix", credential: "datasets" },
    status: { phase: "active" },
  },
  {
    apiVersion: "supertag/v1",
    kind: "Workspace",
    metadata: metadata("workspace-1", "app"),
    spec: {
      source: "git@github.com:acme/app.git",
      ref: "main",
      setup: "pnpm install",
      mcp: ["linear"],
      skills: ["review"],
      skillCatalog: { repository: "acme/skills", path: "skills", revision: "v1", skills: ["a"] },
      mounts: [
        { volume: "datasets", path: "/data", access: "read-write", strategy: "mount" },
        { volume: "cache", path: "/cache", access: "read-only", strategy: "copy", maxBytes: 1024 },
      ],
      delivery: "pull-request",
    },
    status: {
      phase: "active",
      workerHosts: [{ id: "laptop", connectionStatus: "connected" }],
      environments: [
        {
          workerHostId: "laptop",
          connectionStatus: "connected",
          provider: "local",
          prepared: { digest: "sha256:abc", provider: "local", trustedCommit: "c0ffee", at },
        },
        {
          workerHostId: "sandbox",
          connectionStatus: "disconnected",
          provider: "e2b",
          refusal: "needs a source",
        },
      ],
    },
  },
  {
    apiVersion: "supertag/v1",
    kind: "WorkerProfile",
    metadata: metadata("laptop:codex:default@1", "default@1"),
    spec: { ref: { id: "default", revision: "1" } },
    status: {
      phase: "unavailable",
      workerHostId: "laptop",
      workletId: "worklet-1",
      workerId: "codex",
    },
  },
  {
    apiVersion: "supertag/v1",
    kind: "SurfaceAccount",
    metadata: metadata("account-1", "acme-slack"),
    spec: {
      provider: "slack",
      externalAccountId: "T1",
      displayName: "Acme",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: { env: "SLACK_BOT" }, appToken: { secretRef: "slack-app" } },
    },
    status: { phase: "connected", lastVerifiedAt: at },
  },
];

describe("ResourceService resources", () => {
  it.each(views.map((view) => [`${view.kind}/${view.metadata.name}`, view] as const))(
    "carry %s to the CLI as the view the Control Plane built, field for field and in order",
    (_name, view) => {
      const wire = fromBinary(
        ResourceSchema,
        toBinary(ResourceSchema, create(ResourceSchema, resourceMessage(view))),
      );
      const read = resourceView(wire, true);
      expect(JSON.stringify(read)).toBe(JSON.stringify(view));
    },
  );

  it("leaves a Workspace's environments out unless it was read by name", () => {
    const workspace = views.find((view) => view.kind === "Workspace") as ResourceView;
    const read = resourceView(create(ResourceSchema, resourceMessage(workspace)), false);
    expect(read.kind === "Workspace" && read.status.environments).toBeUndefined();
  });

  it("carries a manifest beside the resource", () => {
    const manifest = { apiVersion: "supertag/v1", kind: "Volume", metadata: { name: "datasets" } };
    const volume = views.find((view) => view.kind === "Volume") as ResourceView;
    expect(create(ResourceSchema, resourceMessage(volume, manifest)).manifest).toEqual(manifest);
  });
});
