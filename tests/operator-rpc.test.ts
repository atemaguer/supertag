import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, createFileRegistry, fromBinary, setExtension } from "@bufbuild/protobuf";
import {
  FileDescriptorProtoSchema,
  MethodOptions_IdempotencyLevel,
  MethodOptionsSchema,
} from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { organizationClient } from "../apps/cli/src/operator-client.ts";
import { createOperatorRpcHandler } from "../apps/cli/src/operator-rpc.ts";
import { operatorAuditTarget } from "../apps/cli/src/operator-rpc-context.ts";
import { type RecordAuditEntryInput, TagMessagingError } from "../packages/core/src/index.ts";
import {
  action,
  audit_action,
  ControlPlanePhase,
  ErrorDetailSchema,
  ErrorReason,
  file_supertag_operator_v1_organization,
  requires_admin_token,
} from "../packages/operator-api/src/index.ts";
import { migrateDatabase } from "../packages/store/src/index.ts";

const ADMIN = "operator-rpc-admin";
const GET_STATUS = "/supertag.operator.v1.OrganizationService/GetStatus";

/** The operator API without a generated client: a JSON POST, as `curl` sends it. */
describe("the Connect operator API over plain HTTP", () => {
  let url = "";
  let close: (() => Promise<void>) | undefined;
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-operator-rpc-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: ADMIN,
      coordinationOperatorCredentials: [
        { token: "coordination-only", operatorId: "reviewer", actions: ["*"] },
      ],
      reply: async () => {},
    });
    url = runtime.url;
    close = runtime.close;
  });

  afterAll(async () => {
    await close?.();
    await rm(directory, { recursive: true, force: true });
  });

  const getStatus = (headers: Record<string, string> = {}) =>
    fetch(`${url}${GET_STATUS}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });

  it("answers an authenticated call with proto3 JSON", async () => {
    const response = await getStatus({ authorization: `Bearer ${ADMIN}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      metadata: {
        id: "control-plane",
        name: "control-plane",
        resourceVersion: expect.stringMatching(/^[0-9a-f]{64}$/u),
        createdAt: expect.stringMatching(/Z$/u),
        updatedAt: expect.stringMatching(/Z$/u),
      },
      phase: "CONTROL_PLANE_PHASE_ACCEPTING",
    });
    expect(body["controllers"]).toEqual(
      expect.arrayContaining([
        { name: "task-dispatch", phase: "CONTROLLER_PHASE_RUNNING" },
        { name: "reply-delivery", phase: "CONTROLLER_PHASE_RUNNING" },
      ]),
    );
  });

  it("refuses a call without a token and reveals nothing else", async () => {
    const response = await getStatus();
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
    expect(body).toMatchObject({
      code: "unauthenticated",
      message: "A valid Control Plane admin token or Operator Token is required",
      details: [{ type: "supertag.operator.v1.ErrorDetail", value: expect.any(String) }],
    });
    expect(JSON.stringify(body)).not.toMatch(/controller|accepting|draining/iu);
  });

  it("refuses a wrong token as unauthenticated", async () => {
    const response = await getStatus({ authorization: "Bearer not-a-token" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthenticated" });
  });

  it("refuses a coordination credential as permission denied", async () => {
    const response = await getStatus({ authorization: "Bearer coordination-only" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "permission_denied" });
  });

  it("calls only the origin of a Control Plane URL that has a path", async () => {
    const status = await organizationClient({ url: `${url}/supertag`, token: ADMIN }).getStatus({});
    expect(status.phase).toBe(ControlPlanePhase.ACCEPTING);
  });

  it("does not serve gRPC over this HTTP/1.1 listener", async () => {
    const response = await fetch(`${url}${GET_STATUS}`, {
      method: "POST",
      headers: { "content-type": "application/grpc", authorization: `Bearer ${ADMIN}` },
      body: new Uint8Array(5),
    });
    expect(response.status).toBe(415);
  });
});

const AUDITED = "/supertag.operator.v1.ProbeService/Mutate";

/** A service declaring the options no shipped RPC uses yet, so the shared checks are exercised. */
function probeService(mutate: { readonly audit?: string; readonly adminOnly?: boolean } = {}) {
  const mutateOptions = create(MethodOptionsSchema);
  setExtension(mutateOptions, action, "probe");
  if (mutate.audit !== undefined) setExtension(mutateOptions, audit_action, mutate.audit);
  if (mutate.adminOnly) setExtension(mutateOptions, requires_admin_token, true);
  const readOptions = create(MethodOptionsSchema, {
    idempotencyLevel: MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS,
  });
  setExtension(readOptions, action, "probe");
  const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
      name: "supertag/operator/v1/probe.proto",
      package: "supertag.operator.v1",
      syntax: "proto3",
      dependency: ["supertag/operator/v1/organization.proto"],
      service: [
        {
          name: "ProbeService",
          method: [
            {
              name: "Mutate",
              inputType: ".supertag.operator.v1.GetStatusRequest",
              outputType: ".supertag.operator.v1.GetStatusRequest",
              options: mutateOptions,
            },
            {
              name: "Read",
              inputType: ".supertag.operator.v1.GetStatusRequest",
              outputType: ".supertag.operator.v1.GetStatusRequest",
              options: readOptions,
            },
          ],
        },
      ],
    }),
    (name) =>
      name === "supertag/operator/v1/organization.proto"
        ? file_supertag_operator_v1_organization
        : undefined,
  );
  const service = registry.getService("supertag.operator.v1.ProbeService");
  if (service === undefined) throw new Error("ProbeService is missing");
  return service;
}

function errorReason(body: { details?: { type: string; value: string }[] }) {
  const detail = body.details?.find(({ type }) => type === "supertag.operator.v1.ErrorDetail");
  return detail === undefined
    ? undefined
    : ErrorReason[fromBinary(ErrorDetailSchema, Buffer.from(detail.value, "base64")).reason];
}

describe("the operator RPC access, audit, and error conventions", () => {
  let url = "";
  let server: Server | undefined;
  let accepting = true;
  let failure: unknown;
  const recorded: RecordAuditEntryInput[] = [];

  beforeAll(async () => {
    const service = probeService({ audit: "probe.mutate", adminOnly: true });
    const handler = createOperatorRpcHandler(
      {
        auditTrail: {
          // A slow store: a call answers only once its entry is stored.
          record: async (entry) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            recorded.push(entry);
          },
        },
        authenticate: async (authorization) => {
          if (authorization === `Bearer ${ADMIN}`)
            return {
              kind: "break-glass",
              principal: { operatorId: "control-plane-break-glass", scopes: { actions: ["*"] } },
            };
          if (authorization === "Bearer stop_operator")
            return {
              kind: "operator-token",
              principal: { operatorId: "token:ci", scopes: { actions: ["*"] } },
            };
          return undefined;
        },
        accepting: () => accepting,
      },
      (router) =>
        router.service(service, {
          mutate: (_request: unknown, context: HandlerContext) => {
            const note = context.values.get(operatorAuditTarget);
            if (note !== undefined) note.target = "Probe/one";
            if (failure !== undefined) throw failure;
            return {};
          },
          read: () => ({}),
        } as never),
    );
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const call = async (path: string, token: string | undefined, body = "{}") => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body,
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        code?: string;
        details?: { type: string; value: string }[];
      },
    };
  };

  it("authenticates before it reads the body", async () => {
    for (const body of ["not json", '{"unknownField":1}']) {
      const refused = await call(AUDITED, undefined, body);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe("unauthenticated");
      expect(errorReason(refused.body)).toBe("UNAUTHENTICATED");
    }
    const malformed = await call(AUDITED, ADMIN, "not json");
    expect(malformed.body.code).toBe("invalid_argument");
  });

  it("refuses an Operator Token for an RPC that requires the admin token", async () => {
    const refused = await call(AUDITED, "stop_operator");
    expect(refused.status).toBe(403);
    expect(errorReason(refused.body)).toBe("PERMISSION_DENIED");
    expect((await call(AUDITED, ADMIN)).status).toBe(200);
  });

  it("records each authenticated call to an audited RPC before answering, and no read", async () => {
    recorded.length = 0;
    await call(AUDITED, ADMIN);
    await call(AUDITED, "stop_operator");
    await call("/supertag.operator.v1.ProbeService/Read", ADMIN);
    await call(AUDITED, undefined);
    expect(recorded).toEqual([
      expect.objectContaining({
        actor: "control-plane-break-glass",
        action: "probe.mutate",
        target: "Probe/one",
        outcome: "succeeded",
        status: 200,
        source: "api",
        method: "POST",
        path: "/supertag.operator.v1.ProbeService/Mutate",
      }),
      expect.objectContaining({
        actor: "token:ci",
        action: "probe.mutate",
        target: "Probe",
        outcome: "failed",
        status: 403,
      }),
    ]);
  });

  it.each([
    [new TagMessagingError(503, "Sessions are unavailable"), "unavailable", "UNAVAILABLE"],
    [new TagMessagingError(413, "Request too large"), "resource_exhausted", "RESOURCE_EXHAUSTED"],
    [new TagMessagingError(429, "Mailbox is full"), "resource_exhausted", "RESOURCE_EXHAUSTED"],
    [new TagMessagingError(405, "Method not allowed"), "invalid_argument", "INVALID_ARGUMENT"],
    [new TagMessagingError(409, "Conflict"), "failed_precondition", "CONFLICT"],
    [new TagMessagingError(500, "database at 10.0.0.1"), "internal", "INTERNAL"],
    [new Error("database at 10.0.0.1"), "internal", "INTERNAL"],
  ])("maps %s to %s with reason %s", async (error, code, reason) => {
    failure = error;
    try {
      const refused = await call(AUDITED, ADMIN);
      expect(refused.body.code).toBe(code);
      expect(errorReason(refused.body)).toBe(reason);
      expect(JSON.stringify(refused.body)).not.toContain("10.0.0.1");
    } finally {
      failure = undefined;
    }
  });

  it("reports draining only from its own drain check", async () => {
    accepting = false;
    try {
      const refused = await call(AUDITED, undefined);
      expect(refused.status).toBe(503);
      expect(errorReason(refused.body)).toBe("DRAINING");
    } finally {
      accepting = true;
    }
  });

  it("refuses to start with an RPC that can change state but declares no audit action", () => {
    const service = probeService();
    expect(() =>
      createOperatorRpcHandler(
        {
          auditTrail: { record: async () => {} },
          authenticate: async () => undefined,
          accepting: () => true,
        },
        (router) => router.service(service, {}),
      ),
    ).toThrow(/Mutate can change state/u);
  });
});
