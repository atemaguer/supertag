import { createServer, type ServerHttp2Session } from "node:http2";
import { Code, ConnectError, type ConnectRouter, createClient } from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { afterEach, expect, it, vi } from "vitest";
import { registerCoordinationGrpcRoutes } from "../../../apps/cli/src/coordination-grpc.js";
import { TagMessagingError } from "../../core/src/index.js";
import { GrpcCoordinationClient } from "./src/coordination-client.js";
import {
  CoordinationService,
  decodeCoordinationDocument,
  ExecutionAuthorityService,
  encodeCoordinationDocument,
} from "./src/coordination-codec.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function server(routes: (router: ConnectRouter) => void) {
  const listener = createServer(
    connectNodeAdapter({ grpc: true, connect: false, grpcWeb: false, routes }),
  );
  const sessions = new Set<ServerHttp2Session>();
  listener.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return `http://127.0.0.1:${address.port}`;
}
const rpc = (name: string, args: unknown = {}) => ({
  method: "POST",
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }),
});

it("uses the turn's allowed tool set and denies Host credentials, removed tools and unsupported documents", async () => {
  const commands = vi.fn(async (_name, value) => value);
  const baseUrl = await server((router) =>
    registerCoordinationGrpcRoutes(router, {
      async authenticateExecution(token) {
        if (token !== "manager") throw new TagMessagingError(401, "denied");
        return { taskId: "task" } as never;
      },
      async coordinationActions() {
        return ["read_objective", "send_message"];
      },
      commandAsAttempt: commands,
    }),
  );
  const raw = createClient(CoordinationService, createGrpcTransport({ baseUrl }));
  const options = { headers: { authorization: "Bearer manager" }, timeoutMs: 5000 };
  expect((await raw.listTools({}, options)).tools.map((tool) => tool.name)).toEqual([
    "read_objective",
    "send_message",
  ]);
  await expect(
    raw.listTools({}, { ...options, headers: { authorization: "Bearer host-token" } }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    raw.callTool({ name: "assign_task", arguments: encodeCoordinationDocument({}) }, options),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  await expect(
    raw.callTool(
      { name: "send_message", arguments: { version: 9, json: Buffer.from("{}") } },
      options,
    ),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(commands).not.toHaveBeenCalled();
  // The approval tool is never advertised, but a running Attempt may still call it.
  await raw.callTool(
    { name: "request_action_approval", arguments: encodeCoordinationDocument({ action: "push" }) },
    options,
  );
  expect(commands).toHaveBeenCalledWith(
    "request_action_approval",
    { action: "push" },
    {
      taskId: "task",
    },
  );
  commands.mockClear();
  const client = new GrpcCoordinationClient({ baseUrl, token: "manager" });
  const result = await client.fetch(
    "http://unused/internal/v1/coordination/mcp",
    rpc("read_objective", { objectiveId: "objective" }),
  );
  expect(await result.json()).toMatchObject({
    result: { content: [{ type: "text", text: '{"objectiveId":"objective"}' }] },
  });
  expect(commands).toHaveBeenCalledWith(
    "read_objective",
    { objectiveId: "objective" },
    { taskId: "task" },
  );
});

it("shares one gRPC authority renewal for concurrent calls and retains exact mutation input", async () => {
  let renewals = 0;
  const inputs: unknown[] = [];
  const baseUrl = await server((router) => {
    router.service(ExecutionAuthorityService, {
      async rebind(_, context) {
        expect(context.requestHeader.get("authorization")).toBe("Bearer old");
        renewals++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { token: "new" };
      },
    });
    router.service(CoordinationService, {
      callTool(request, context) {
        const input = decodeCoordinationDocument(request.arguments);
        if (context.requestHeader.get("authorization") !== "Bearer new")
          throw new ConnectError("expired", Code.Unauthenticated);
        inputs.push(input);
        return { content: [{ text: JSON.stringify(input) }] };
      },
    });
  });
  const client = new GrpcCoordinationClient({ baseUrl, token: "old" });
  const input = { idempotencyKey: "stable", body: { message: "Original" } };
  const first = client.fetch("http://unused/mcp", rpc("send_message", input));
  const second = client.fetch("http://unused/mcp", rpc("send_message", input));
  input.body.message = "Changed";
  await Promise.all([first, second]);
  expect(renewals).toBe(1);
  expect(inputs).toEqual(
    Array(2).fill({ idempotencyKey: "stable", body: { message: "Original" } }),
  );
});

it("does not let one cancelled caller poison a shared authority renewal", async () => {
  let renewals = 0;
  let expiredCalls = 0;
  let renewalStarted!: () => void;
  let secondExpired!: () => void;
  let releaseRenewal!: () => void;
  const started = new Promise<void>((resolve) => {
    renewalStarted = resolve;
  });
  const bothExpired = new Promise<void>((resolve) => {
    secondExpired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRenewal = resolve;
  });
  const baseUrl = await server((router) => {
    router.service(ExecutionAuthorityService, {
      async rebind() {
        renewals++;
        renewalStarted();
        await released;
        return { token: "new" };
      },
    });
    router.service(CoordinationService, {
      callTool(_, context) {
        if (context.requestHeader.get("authorization") !== "Bearer new") {
          expiredCalls++;
          if (expiredCalls === 2) secondExpired();
          throw new ConnectError("expired", Code.Unauthenticated);
        }
        return { content: [{ text: '{"ok":true}' }] };
      },
    });
  });
  const client = new GrpcCoordinationClient({ baseUrl, token: "old" });
  const cancelled = new AbortController();
  const first = client.fetch("http://unused/mcp", {
    ...rpc("read_objective"),
    signal: cancelled.signal,
  });
  await started;
  const second = client.fetch("http://unused/mcp", rpc("read_objective"));
  await bothExpired;
  cancelled.abort(new Error("first caller cancelled"));
  releaseRenewal();
  await expect(first).rejects.toThrow("first caller cancelled");
  await expect(second.then((response) => response.json())).resolves.toMatchObject({
    result: { content: [{ text: '{"ok":true}' }] },
  });
  expect(renewals).toBe(1);
});

it("acknowledges MCP notifications without touching the Control Plane", async () => {
  const listed = vi.fn(() => ({ tools: [] }));
  const baseUrl = await server((router) => {
    router.service(CoordinationService, { listTools: listed });
  });
  const client = new GrpcCoordinationClient({ baseUrl, token: "manager" });
  const response = await client.fetch("http://unused/mcp", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, reason: "attempt ending" },
    }),
  });
  expect(response.status).toBe(202);
  expect(listed).not.toHaveBeenCalled();
});

it("does not retry a transport-uncertain tool mutation or renew authority on cleanup", async () => {
  let mutations = 0;
  let renewals = 0;
  const baseUrl = await server((router) => {
    router.service(ExecutionAuthorityService, {
      rebind() {
        renewals++;
        return { token: "new" };
      },
    });
    router.service(CoordinationService, {
      callTool() {
        mutations++;
        throw new ConnectError("lost response", Code.Unavailable);
      },
    });
  });
  const client = new GrpcCoordinationClient({ baseUrl, token: "manager" });
  await expect(
    client.fetch("http://unused/mcp", rpc("send_message", { to: "tag", text: "stable" })),
  ).rejects.toMatchObject({ code: Code.Unavailable });
  expect(mutations).toBe(1);
  expect((await client.fetch("http://unused/mcp", { method: "DELETE" })).status).toBe(405);
  expect(renewals).toBe(0);
});

it("requires bounded deadlines and fences requests during internal drain", async () => {
  let draining = false;
  const commands = vi.fn(async () => []);
  const baseUrl = await server((router) =>
    registerCoordinationGrpcRoutes(
      router,
      {
        async authenticateExecution() {
          return { taskId: "task" } as never;
        },
        async coordinationActions() {
          return ["read_objective"];
        },
        commandAsAttempt: commands,
      },
      {
        beginRequest() {
          if (draining) throw new ConnectError("draining", Code.Unavailable);
          return () => {};
        },
      },
    ),
  );
  const raw = createClient(CoordinationService, createGrpcTransport({ baseUrl }));
  await expect(raw.listTools({})).rejects.toMatchObject({ code: Code.InvalidArgument });
  draining = true;
  await expect(raw.listTools({}, { timeoutMs: 5000 })).rejects.toMatchObject({
    code: Code.Unavailable,
  });
  expect(commands).not.toHaveBeenCalled();
});
