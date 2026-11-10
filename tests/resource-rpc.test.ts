import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { resourceClient } from "../apps/cli/src/operator-client.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import {
  ErrorDetailSchema,
  ErrorReason,
  ManifestOutcome,
  PlanAction,
  ResourceKind,
} from "../packages/operator-api/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const ADMIN = "resource-rpc-admin";
const SCOPED = "resource-rpc-coordination";

const manifest = (kind: string, name: string, spec: object = {}) => ({
  apiVersion: "supertag/v1",
  kind,
  metadata: { name },
  spec,
});
const document = (value: object, secrets: Record<string, string> = {}) => ({
  manifest: JSON.parse(JSON.stringify(value)),
  secrets,
});

/** The refusal a call fails with: its code, reason, message and fields. */
async function refusal(call: Promise<unknown>) {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ConnectError);
  const connect = error as ConnectError;
  const detail = connect.findDetails(ErrorDetailSchema)[0];
  return {
    code: connect.code,
    reason: detail?.reason,
    message: connect.rawMessage,
    fields: (detail?.fields ?? []).map(({ path, description, manager }) => ({
      path,
      description,
      manager,
    })),
  };
}

describe("ResourceService", () => {
  let directory: string;
  let close: () => Promise<void>;
  let url: string;
  let resources: ReturnType<typeof resourceClient>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-resource-rpc-"));
    const database = join(directory, "state.db");
    await migrateSqlite(database);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${database}`,
      adminToken: ADMIN,
      stateDirectory: directory,
      coordinationOperatorCredentials: [{ token: SCOPED, operatorId: "scoped", actions: ["*"] }],
      reply: async () => {},
    });
    close = runtime.close;
    url = runtime.url;
    resources = resourceClient({ url, token: ADMIN });
  });

  afterEach(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });

  it("applies in dependency order, again without change, and reads what it applied", async () => {
    const input = [
      document(manifest("Tag", "builder", { roles: ["Engineer"] })),
      document(manifest("Role", "Engineer", { purpose: "Ship.", permissionSets: ["tools"] })),
      document(manifest("PermissionSet", "tools", { permissions: [] })),
    ];
    const first = await resources.applyManifests({ documents: input, applySet: "team" });
    expect(first.complete).toBe(true);
    expect(
      first.results.map(({ document, outcome, action }) => [document, outcome, action]),
    ).toEqual([
      [2, ManifestOutcome.APPLIED, PlanAction.CREATE],
      [1, ManifestOutcome.APPLIED, PlanAction.CREATE],
      [0, ManifestOutcome.APPLIED, PlanAction.CREATE],
    ]);
    // A retry changes nothing more.
    const again = await resources.applyManifests({ documents: input, applySet: "team" });
    expect(again.results.map((result) => result.action)).toEqual([
      PlanAction.UNCHANGED,
      PlanAction.UNCHANGED,
      PlanAction.UNCHANGED,
    ]);
    const tag = await resources.getResource({
      kind: ResourceKind.TAG,
      name: "builder",
      manifest: true,
    });
    expect(tag.resource.case).toBe("tag");
    expect(tag.manifest).toEqual({
      apiVersion: "supertag/v1",
      kind: "Tag",
      metadata: { name: "builder" },
      spec: {
        roles: ["Engineer"],
        workerHosts: [],
        runsOn: [],
        locations: [],
        acceptsMessagesFrom: [],
      },
    });
    const { plans } = await resources.diffManifests({ documents: input, applySet: "team" });
    expect(plans.map((plan) => plan.action)).toEqual([
      PlanAction.UNCHANGED,
      PlanAction.UNCHANGED,
      PlanAction.UNCHANGED,
    ]);
  });

  it("takes an input over 1 MB in one call, and guides the CLI past its 16 MB limit", async () => {
    const role = (name: string, size: number) =>
      document(manifest("Role", name, { purpose: "Review.", instructions: "x".repeat(size) }));
    // Each Role's instructions stay under their 32 KiB limit; together they are over 1 MB.
    const input = Array.from({ length: 40 }, (_, index) => role(`role-${index}`, 30_000));
    const { plans } = await resources.diffManifests({ documents: input });
    expect(plans.every((plan) => plan.action === PlanAction.CREATE)).toBe(true);
    const applied = await resources.applyManifests({ documents: input });
    expect(applied.complete).toBe(true);

    const file = join(directory, "large.yaml");
    await writeFile(
      file,
      `apiVersion: supertag/v1\nkind: Role\nmetadata: { name: large }\nspec:\n  purpose: Review.\n  instructions: ${"x".repeat(16_500_000)}\n`,
    );
    const client = new ControlPlaneClient({ url, token: ADMIN });
    for (const command of ["apply", "diff"])
      await expect(runResourceCommand(client, command, ["-f", file])).rejects.toThrow(
        "The input is larger than the 16 MB the Control Plane takes in one apply or diff",
      );
  });

  it("enforces the same UTF-8 Role instruction limit in diff and apply", async () => {
    const role = (instructions: string) =>
      document(manifest("Role", "reviewer", { purpose: "Review.", instructions }));
    const atLimit = "é".repeat(16_384);
    const { plans } = await resources.diffManifests({ documents: [role(atLimit)] });
    expect(plans[0]?.action).toBe(PlanAction.CREATE);

    const tooLarge = { documents: [role(`${atLimit}é`)] };
    for (const request of [
      () => resources.diffManifests(tooLarge),
      () => resources.applyManifests(tooLarge),
    ]) {
      expect(await refusal(request())).toMatchObject({
        code: Code.InvalidArgument,
        message: expect.stringContaining("Role instructions exceed 32 KiB"),
      });
    }
    expect((await resources.listResources({ kind: ResourceKind.ROLE })).resources).toEqual([]);
  });

  it("pages a listing and refuses kinds it does not list", async () => {
    await resources.applyManifests({
      documents: ["a", "b", "c"].map((name) =>
        document(manifest("ContextSet", name, { items: [] })),
      ),
    });
    const first = await resources.listResources({ kind: ResourceKind.CONTEXT_SET, pageSize: 2 });
    expect(first.resources).toHaveLength(2);
    const rest = await resources.listResources({
      kind: ResourceKind.CONTEXT_SET,
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(rest.resources).toHaveLength(1);
    expect(rest.nextPageToken).toBe("");
    for (const request of [
      { kind: ResourceKind.UNSPECIFIED },
      { kind: ResourceKind.OBJECTIVE },
      { kind: ResourceKind.WORKER_PROFILE, manifest: true },
      { kind: ResourceKind.TAG, pageToken: "not-a-token" },
    ])
      expect((await refusal(resources.listResources(request))).code).toBe(Code.InvalidArgument);
    expect(
      await refusal(resources.getResource({ kind: ResourceKind.TAG, name: "missing" })),
    ).toMatchObject({
      code: Code.NotFound,
      reason: ErrorReason.NOT_FOUND,
      message: 'Tag "missing" does not exist',
    });
  });

  it("refuses an invalid input, naming each document, and applies nothing", async () => {
    const refused = await refusal(
      resources.applyManifests({
        documents: [
          { ...document(manifest("Tag", "builder", { roles: ["Ghost"] })), source: "tags.yaml" },
          document(manifest("Task", "task-1")),
        ],
      }),
    );
    expect(refused).toEqual({
      code: Code.InvalidArgument,
      reason: ErrorReason.INVALID_ARGUMENT,
      message: "Nothing was applied. Invalid manifests:\n  documents[1]: Task is observed state",
      fields: [
        {
          path: "documents[1]",
          description: "documents[1]: Task is observed state",
          manager: "",
        },
      ],
    });
    const missing = await refusal(
      resources.applyManifests({
        documents: [
          { ...document(manifest("Tag", "builder", { roles: ["Ghost"] })), source: "tags.yaml" },
        ],
      }),
    );
    expect(missing.message).toBe(
      "Nothing was applied. Invalid manifests:\n  tags.yaml: Tag/builder references Role Ghost, which is neither in this input nor on the Control Plane",
    );
    expect(missing.fields.map((field) => field.path)).toEqual(["documents[0]"]);
    expect((await resources.listResources({ kind: ResourceKind.TAG })).resources).toEqual([]);
  });

  it("refuses fields another manager owns, naming the manager, unless forced", async () => {
    const role = (purpose: string) =>
      document(manifest("Role", "Engineer", { purpose, permissionSets: [] }));
    await resources.applyManifests({ documents: [role("Ship.")], applySet: "first" });
    const refused = await refusal(
      resources.applyManifests({ documents: [role("Review.")], applySet: "second" }),
    );
    expect(refused).toMatchObject({
      code: Code.FailedPrecondition,
      reason: ErrorReason.CONFLICT,
      message:
        "Nothing was applied. The input changes fields another manager owns:\n  Role/Engineer: spec.purpose is owned by first",
      fields: [{ path: "documents[0].spec.purpose", manager: "first" }],
    });
    const { plans } = await resources.diffManifests({
      documents: [role("Review.")],
      applySet: "second",
    });
    expect(plans[0]?.conflicts).toMatchObject([{ path: "spec.purpose", manager: "first" }]);
    const forced = await resources.applyManifests({
      documents: [role("Review.")],
      applySet: "second",
      forceConflicts: true,
    });
    expect(forced.complete).toBe(true);
  });

  it("reports a partial apply: what applied, what failed and why, and what was not applied", async () => {
    await new ControlPlaneClient({ url, token: ADMIN }).setupSurface({
      provider: "slack",
      externalAccountId: "T_RPC",
      displayName: "RPC Slack",
      authMethod: "slack-bot-token",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    const location = { locations: [{ provider: "slack", channelId: "C0SHARED" }] };
    await resources.applyManifests({ documents: [document(manifest("Tag", "holder", location))] });
    // Only the write finds that another Tag already answers in the channel.
    const applied = await resources.applyManifests({
      documents: [
        document(
          manifest("Volume", "datasets", { source: "file:///srv/data", credential: "data" }),
        ),
        document(manifest("Tag", "builder", location)),
        document(manifest("Objective", "ship", { owner: "builder", outcome: "Ship it." })),
      ],
      applySet: "team",
      prune: true,
    });
    expect(applied.complete).toBe(false);
    expect(applied.pruned).toEqual([]);
    expect(applied.results.map(({ name, outcome }) => [name, outcome])).toEqual([
      ["datasets", ManifestOutcome.APPLIED],
      ["builder", ManifestOutcome.FAILED],
      ["ship", ManifestOutcome.NOT_APPLIED],
    ]);
    expect(applied.results[1]?.failureMessage).toContain("already routes to Tag holder");
    expect(applied.results[1]?.failure?.reason).toBe(ErrorReason.INVALID_ARGUMENT);
  });

  it("refuses requests it cannot serve, and secrets on a plan", async () => {
    for (const request of [
      { documents: [] },
      { documents: [document(manifest("Tag", "a"))], prune: true },
      { documents: [document(manifest("Tag", "a"))], applySet: "Not A Set" },
      { documents: [document(manifest("Tag", "a"))], imperative: true, applySet: "team" },
      {
        documents: [document(manifest("Objective", "o", { owner: "a", outcome: "x" }))],
        imperative: true,
      },
      { documents: [document(manifest("Tag", "a"), { token: "value" })] },
    ])
      expect((await refusal(resources.applyManifests(request))).code).toBe(Code.InvalidArgument);
    const account = manifest("SurfaceAccount", "acme-slack", {
      provider: "slack",
      configuration: { transport: "socket" },
      secrets: { botToken: { env: "BOT" }, appToken: { env: "APP" } },
    });
    expect(
      await refusal(
        resources.diffManifests({
          documents: [document(account, { botToken: "b", appToken: "a" })],
        }),
      ),
    ).toMatchObject({ code: Code.InvalidArgument, fields: [{ path: "documents[0].secrets" }] });
  });

  it("deletes once, and refuses kinds that are not deleted and callers that may not", async () => {
    await resources.applyManifests({ documents: [document(manifest("Tag", "builder"))] });
    const planned = await resources.deleteResource({
      kind: ResourceKind.TAG,
      name: "builder",
      dryRun: true,
    });
    expect(planned.dryRun).toBe(true);
    await resources.deleteResource({ kind: ResourceKind.TAG, name: "builder" });
    expect(
      (await refusal(resources.deleteResource({ kind: ResourceKind.TAG, name: "builder" }))).code,
    ).toBe(Code.NotFound);
    for (const kind of [
      ResourceKind.OBJECTIVE,
      ResourceKind.WORKER_PROFILE,
      ResourceKind.UNSPECIFIED,
    ])
      expect((await refusal(resources.deleteResource({ kind, name: "x" }))).code).toBe(
        Code.InvalidArgument,
      );
    const scoped = resourceClient({ url, token: SCOPED });
    expect((await refusal(scoped.listResources({ kind: ResourceKind.TAG }))).code).toBe(
      Code.PermissionDenied,
    );
  });
});
