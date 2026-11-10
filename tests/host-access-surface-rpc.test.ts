import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import {
  accessClient,
  hostClient,
  organizationClient,
  surfaceClient,
} from "../apps/cli/src/operator-client.ts";
import {
  AuthKeySchema,
  ErrorDetailSchema,
  ListSurfaceAccountsResponseSchema,
  SetKind,
  SurfaceAccountPhase,
  SurfaceProvider,
} from "../packages/operator-api/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { issueOperatorToken } from "./support/operator-access.ts";

const ADMIN = "host-access-surface-admin";
const SCOPED = "host-access-surface-scoped";
const SLACK = { provider: SurfaceProvider.SLACK, account: "T0SURFACE" } as const;

describe("HostService, AccessService, SurfaceService and OrganizationService", () => {
  let directory = "";
  let url = "";
  let operatorToken = "";
  let store: DrizzleStore;
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-host-access-surface-"));
    const databasePath = join(directory, "state.db");
    await migrateSqlite(databasePath);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: ADMIN,
      workletTransport: "remote",
      coordinationOperatorCredentials: [
        { token: SCOPED, operatorId: "scoped", actions: ["*"], objectiveIds: ["only-this"] },
      ],
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      stateDirectory: join(directory, "server"),
      reply: async () => {},
    });
    url = runtime.url;
    close = () => runtime.close();
    store = new DrizzleStore({ url: `file:${databasePath}` });
    await store.connect();
    operatorToken = await issueOperatorToken(url, ADMIN, "teammate");
    for (const name of ["answerer", "other"]) await store.createTag({ name });
    await store.createTagContextSet({ name: "research" });
    await store.createTagPermissionSet({ name: "release" });
  });

  afterAll(async () => {
    await store?.disconnect();
    await close();
    await rm(directory, { recursive: true, force: true });
  });

  const admin = () => ({ url, token: ADMIN });
  const refusal = async (call: Promise<unknown>) => {
    const error = await call.then(
      () => undefined,
      (caught: unknown) => ConnectError.from(caught),
    );
    if (error === undefined) throw new Error("the call succeeded");
    return {
      code: error.code,
      fields: error
        .findDetails(ErrorDetailSchema)
        .flatMap((detail) => detail.fields.map((field) => field.path)),
    };
  };

  it("refuses a scoped coordination credential, even one scoped to Objectives", async () => {
    const scoped = { url, token: SCOPED };
    for (const call of [
      hostClient(scoped).listWorkerHosts({}),
      hostClient(scoped).enrollWorkerHost({ id: "scoped-host" }),
      hostClient(scoped).listAuthKeys({}),
      accessClient(scoped).listOperatorTokens({}),
      surfaceClient(scoped).listSurfaceAccounts({}),
      organizationClient(scoped).getOrganization({}),
      organizationClient(scoped).getSpend({}),
      organizationClient(scoped).listAuditEntries({}),
      organizationClient(scoped).getMetrics({}),
    ])
      expect((await refusal(call)).code).toBe(Code.PermissionDenied);
    await expect(store.findWorkerHostById("scoped-host")).resolves.toBeUndefined();
  });

  it("refuses an anonymous caller before reading the request", async () => {
    for (const call of [
      hostClient({ url }).getWorkerHost({ id: "x" }),
      accessClient({ url }).getOperatorToken({ name: "teammate" }),
      surfaceClient({ url }).getSurfaceAccount({ name: "x" }),
    ])
      expect((await refusal(call)).code).toBe(Code.Unauthenticated);
  });

  it("serves AccessService to the admin token alone", async () => {
    const teammate = accessClient({ url, token: operatorToken });
    for (const call of [
      teammate.listOperatorTokens({}),
      teammate.getOperatorToken({ name: "teammate" }),
      teammate.createOperatorToken({ name: "another" }),
      teammate.revokeOperatorToken({ name: "teammate" }),
    ])
      expect((await refusal(call)).code).toBe(Code.PermissionDenied);
    await expect(
      accessClient(admin()).getOperatorToken({ name: "teammate" }),
    ).resolves.toMatchObject({ metadata: { name: "teammate" }, operatorId: "token:teammate" });
    // An Operator Token manages everything else.
    await expect(
      hostClient({ url, token: operatorToken }).listWorkerHosts({}),
    ).resolves.toBeDefined();
  });

  it("speaks the Connect JSON protocol that curl sends", async () => {
    const post = (method: string, body: unknown) =>
      fetch(`${url}/supertag.operator.v1.${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const token = await post("AccessService/GetOperatorToken", { name: "teammate" });
    expect(token.status).toBe(200);
    await expect(token.json()).resolves.toMatchObject({
      phase: "OPERATOR_TOKEN_PHASE_ACTIVE",
      operatorId: "token:teammate",
    });
    const missing = await post("SurfaceService/GetSurfaceAccount", { name: "slack:nothing" });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "not_found" });
    const accounts = await post("SurfaceService/ListSurfaceAccounts", { pageSize: 1 });
    expect(accounts.status).toBe(200);
  });

  it("sets up a Surface Account in place and never returns its secrets", async () => {
    const surfaces = surfaceClient(admin());
    const setUp = () =>
      surfaces.setUpSurface({
        provider: SurfaceProvider.SLACK,
        externalAccountId: SLACK.account,
        displayName: "Surface Slack",
        authMethod: "slack-bot-token",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-surface-value", appToken: "xapp-surface-value" },
      });
    const first = await setUp();
    const again = await setUp();
    expect(again.metadata?.id).toBe(first.metadata?.id);
    expect(again).toMatchObject({
      metadata: { name: `slack:${SLACK.account}` },
      phase: SurfaceAccountPhase.CONNECTED,
      configuration: { transport: "socket" },
    });
    expect(again.secrets).toBeUndefined();
    const read = await surfaces.getSurfaceAccount({ name: `slack:${SLACK.account}` });
    expect(read.metadata?.id).toBe(first.metadata?.id);
    expect(
      toJsonString(ListSurfaceAccountsResponseSchema, await surfaces.listSurfaceAccounts({})),
    ).not.toContain("xoxb");
    expect(await refusal(surfaces.setUpSurface({ externalAccountId: "" }))).toEqual({
      code: Code.InvalidArgument,
      fields: ["provider", "external_account_id", "display_name", "auth_method"],
    });
  });

  it("adds, removes and activates locations idempotently", async () => {
    const surfaces = surfaceClient(admin());
    const location = { ...SLACK, channelId: "c0answer" };
    const added = await surfaces.addTagLocation({ tag: "answerer", location });
    expect(added).toMatchObject({
      tag: "answerer",
      provider: SurfaceProvider.SLACK,
      location: "C0ANSWER",
      accountDisplayName: "Surface Slack",
      changed: true,
    });
    await expect(surfaces.addTagLocation({ tag: "answerer", location })).resolves.toMatchObject({
      changed: false,
    });
    // A location has one Tag.
    expect(await refusal(surfaces.addTagLocation({ tag: "other", location }))).toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(
      await refusal(
        surfaces.addTagLocation({ tag: "answerer", location: { ...location, chatId: "x" } }),
      ),
    ).toEqual({ code: Code.InvalidArgument, fields: ["location.chat_id"] });
    expect(
      await refusal(surfaces.addTagLocation({ tag: "answerer", location: { ...SLACK } })),
    ).toEqual({ code: Code.InvalidArgument, fields: ["location.channel_id"] });
    expect(
      await refusal(
        surfaces.addTagLocation({ tag: "answerer", location: { ...location, account: "nope" } }),
      ),
    ).toEqual({ code: Code.FailedPrecondition, fields: ["location.account"] });
    expect(await refusal(surfaces.addTagLocation({ tag: "missing", location }))).toEqual({
      code: Code.NotFound,
      fields: ["tag"],
    });

    for (const kind of [SetKind.CONTEXT_SET, SetKind.PERMISSION_SET]) {
      const set = kind === SetKind.CONTEXT_SET ? "research" : "release";
      for (let repeat = 0; repeat < 2; repeat += 1)
        await expect(
          surfaces.activateSet({ kind, set, tag: "answerer", location }),
        ).resolves.toMatchObject({ kind, set, tag: "answerer", location: "C0ANSWER" });
      await expect(
        surfaces.deactivateSet({ kind, set, tag: "answerer", location }),
      ).resolves.toMatchObject({ set });
    }
    await surfaces.activateSet({
      kind: SetKind.CONTEXT_SET,
      set: "research",
      tag: "answerer",
      location,
    });
    expect(
      await refusal(
        surfaces.activateSet({
          kind: SetKind.CONTEXT_SET,
          set: "absent",
          tag: "answerer",
          location,
        }),
      ),
    ).toEqual({ code: Code.NotFound, fields: ["set"] });
    expect(
      await refusal(
        surfaces.activateSet({
          kind: SetKind.CONTEXT_SET,
          set: "research",
          tag: "other",
          location,
        }),
      ),
    ).toMatchObject({ code: Code.FailedPrecondition });

    // The CLI prints what it always printed.
    const cli = new ControlPlaneClient(admin());
    await expect(
      cli.runTagCommand("remove", ["answerer", "slack", "--channel-id", "C0ANSWER"]),
    ).resolves.toBe("Removed answerer from slack C0ANSWER on Surface Slack.\n");
    await expect(surfaces.removeTagLocation({ tag: "answerer", location })).resolves.toMatchObject({
      changed: false,
    });
    // Removing the location deactivated its sets.
    expect(await store.listTagContextActivations()).toEqual([]);
    await expect(
      cli.runTagCommand("remove", ["answerer", "slack", "--channel-id", "C0ANSWER"]),
    ).rejects.toThrow("answerer is not configured on slack C0ANSWER for Surface Slack");
    await expect(
      cli.runTagCommand("add", ["answerer", "slack", "--channel-id", "C0ANSWER"]),
    ).resolves.toBe("Added answerer to slack C0ANSWER on Surface Slack.\n");
    await expect(
      cli.runTagCommand("context", [
        "activate",
        "answerer",
        "research",
        "slack",
        "--channel-id",
        "C0ANSWER",
      ]),
    ).resolves.toBe("Activated research for slack C0ANSWER.\n");
    await expect(
      cli.runTagCommand("add", ["missing", "slack", "--channel-id", "C0ANSWER"]),
    ).rejects.toThrow('Tag "missing" does not exist. Create it with: supertag create tag missing');
    await expect(
      cli.runTagCommand("add", ["answerer", "slack", "--channel-id", "C1", "--account", "nope"]),
    ).rejects.toThrow('No connected slack account matches --account "nope"');
    await expect(
      cli.runTagCommand("add", ["answerer", "lark", "--chat-id", "chat"]),
    ).rejects.toThrow("No connected lark account exists. Run supertag setup surface lark.");
    await expect(
      cli.runTagCommand("add", ["answerer", "slack", "--channel-id", " "]),
    ).rejects.toThrow("--channel-id is required");
    const missingName = 'missing "tag"; $(echo nope)';
    await expect(
      cli.runTagCommand("add", [missingName, "slack", "--channel-id", "C1"]),
    ).rejects.toThrow(`Create it with: supertag create tag ${JSON.stringify(missingName)}`);
  });

  it("reads Auth Keys with their Tags' names and refuses unknown Tags", async () => {
    const hosts = hostClient(admin());
    expect(await refusal(hosts.createAuthKey({ name: "pool", tags: ["absent"] }))).toEqual({
      code: Code.NotFound,
      fields: ["tags"],
    });
    expect(await refusal(hosts.createAuthKey({ name: "pool", tags: [] }))).toEqual({
      code: Code.InvalidArgument,
      fields: ["tags"],
    });
    const created = await hosts.createAuthKey({ name: "pool", tags: ["answerer", "answerer"] });
    expect(created.authKey).toMatchObject({ tags: ["answerer"], metadata: { name: "pool" } });
    const page = await hosts.listAuthKeys({ pageSize: 1 });
    expect(page.authKeys.map((key) => key.metadata?.name)).toEqual(["pool"]);
    expect(page.nextPageToken).toBe("");
    expect(toJsonString(AuthKeySchema, await hosts.getAuthKey({ name: "pool" }))).not.toContain(
      created.secret,
    );
  });
});
