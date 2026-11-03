import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it } from "vitest";
import { SharedExecutionGrpcClient } from "./src/grpc-client.js";
import { startSharedExecutionGrpcServer } from "./src/grpc-server.js";
import {
  type SharedExecutionRequest,
  type SharedExecutionResponse,
  startSharedExecutionServer,
} from "./src/server.js";

const admin = "grpc-test-administrator-credential";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
async function fixture(
  intercept?: (request: SharedExecutionRequest, response: SharedExecutionResponse) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-"));
  const options = {
    rootDirectory: join(directory, "workspace"),
    statePath: join(directory, "state.json"),
    environmentId: "grpc-test",
    adminToken: admin,
  };
  let owner = await startSharedExecutionServer(options);
  const service = {
    async dispatch(request: SharedExecutionRequest) {
      const response = await owner.dispatch(request);
      await intercept?.(request, response);
      return response;
    },
  };
  let frontend = await startSharedExecutionGrpcServer({ service });
  const client = new SharedExecutionGrpcClient(frontend.url, 1000);
  cleanups.push(async () => {
    await frontend.close();
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    client,
    options,
    service,
    async reconnect() {
      const port = Number(new URL(frontend.url).port);
      await frontend.close();
      frontend = await startSharedExecutionGrpcServer({ service, port });
    },
    async restartOwner() {
      await owner.close();
      owner = await startSharedExecutionServer(options);
    },
    async grant(id = randomUUID()) {
      const token = `grant-${randomUUID()}`;
      await client.request(`/v1/accesses/${id}`, {
        method: "PUT",
        token: admin,
        body: { taskId: "task", attemptId: id, tagId: "tag", ttlMs: 60000, accessToken: token },
      });
      return { id, token };
    },
  };
}
const start = (code: string) => ({
  kind: "process.start",
  command: process.execPath,
  args: ["-e", code],
  environment: {},
});
async function consume(
  client: SharedExecutionGrpcClient,
  id: string,
  token: string,
  onSnapshot?: () => Promise<void>,
) {
  const chunks: { sequence: number; text: string }[] = [];
  let terminal: Record<string, unknown> | undefined;
  for await (const snapshot of client.watch(id, 0, token)) {
    chunks.push(...(snapshot["chunks"] as typeof chunks));
    terminal = snapshot;
    await onSnapshot?.();
  }
  return { chunks, terminal };
}

it("recovers a lost acknowledgement without repeating the side effect and rejects conflicting ownership", async () => {
  let drop = true;
  const f = await fixture(async (request, response) => {
    if (drop && request.url === "/v1/operations/once" && response.status === 200) {
      drop = false;
      throw new ConnectError("lost acknowledgement", Code.Unavailable);
    }
  });
  const access = await f.grant();
  const body = start("require('fs').appendFileSync('once.txt','x'); console.log('done')");
  const call = () =>
    f.client.request("/v1/operations/once", { method: "POST", token: access.token, body });
  await expect(call()).rejects.toMatchObject({ code: Code.Unavailable });
  const receipt = (await call()) as { processId: string };
  const result = await consume(f.client, receipt.processId, access.token);
  expect(result.terminal?.["status"]).toBe("completed");
  expect(await readFile(join(f.options.rootDirectory, "once.txt"), "utf8")).toBe("x");
  await expect(
    f.client.request("/v1/operations/once", { token: access.token }),
  ).resolves.toMatchObject({ processId: receipt.processId, status: "completed" });
  await expect(
    f.client.request("/v1/operations/once", {
      method: "POST",
      token: access.token,
      body: start("process.exit(1)"),
    }),
  ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  const stranger = await f.grant();
  await expect(
    f.client.request("/v1/operations/once", { token: stranger.token }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(consume(f.client, receipt.processId, stranger.token)).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("resumes a broken stream without gaps or duplicates while its process keeps running", async () => {
  const f = await fixture();
  const access = await f.grant();
  const receipt = (await f.client.request("/v1/operations/stream", {
    method: "POST",
    token: access.token,
    body: start(
      "require('fs').appendFileSync('effect.txt','x'); let n=0; const timer=setInterval(()=>{console.log(++n); if(n===15) clearInterval(timer)},40)",
    ),
  })) as { processId: string };
  let reconnected = false;
  const result = await consume(f.client, receipt.processId, access.token, async () => {
    if (!reconnected) {
      reconnected = true;
      await f.reconnect();
    }
  });
  expect(result.chunks.map((c) => c.sequence)).toEqual(result.chunks.map((_, i) => i + 1));
  expect(result.chunks.map((c) => c.text).join("")).toBe(
    Array.from({ length: 15 }, (_, i) => `${i + 1}\n`).join(""),
  );
  expect(result.terminal?.["status"]).toBe("completed");
  expect(await readFile(join(f.options.rootDirectory, "effect.txt"), "utf8")).toBe("x");
});

it("cancelling a watch leaves accepted work alive; release affects only its access", async () => {
  const f = await fixture();
  const access = await f.grant();
  const other = await f.grant();
  const running = (await f.client.request("/v1/operations/long", {
    method: "POST",
    token: access.token,
    body: start("setInterval(()=>{},1000)"),
  })) as { processId: string };
  const survivor = (await f.client.request("/v1/operations/survivor", {
    method: "POST",
    token: other.token,
    body: start("setTimeout(()=>console.log('survived'),350)"),
  })) as { processId: string };
  const controller = new AbortController();
  for await (const _snapshot of f.client.watch(
    running.processId,
    0,
    access.token,
    controller.signal,
  )) {
    controller.abort();
    break;
  }
  await expect(
    f.client.request("/v1/operations/long", { token: access.token }),
  ).resolves.toMatchObject({ status: "running" });
  await f.client.request(`/v1/accesses/${access.id}`, { method: "POST", token: access.token });
  await expect(
    f.client.request("/v1/operations/long", { token: access.token }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  const completed = await consume(f.client, survivor.processId, other.token);
  expect(completed.terminal?.["result"]).toMatchObject({ exitCode: 0, stdout: "survived\n" });
});

it("returns durable receipts after owner restart and refuses to replay unfinished file work", async () => {
  const f = await fixture();
  const access = await f.grant();
  const body = {
    kind: "file.write",
    path: "saved.txt",
    contentBase64: Buffer.from("saved").toString("base64"),
  };
  await f.client.request("/v1/operations/saved", { method: "POST", token: access.token, body });
  const state = JSON.parse(await readFile(f.options.statePath, "utf8"));
  state.operations.saved.status = "accepted";
  delete state.operations.saved.result;
  await writeFile(f.options.statePath, JSON.stringify(state));
  await f.restartOwner();
  await expect(
    f.client.request("/v1/operations/saved", { method: "POST", token: access.token, body }),
  ).resolves.toMatchObject({ status: "uncertain" });
  expect(await readFile(join(f.options.rootDirectory, "saved.txt"), "utf8")).toBe("saved");
});

it("streams bounded pages and rejects a cursor ahead of the journal", async () => {
  const f = await fixture();
  const access = await f.grant();
  const receipt = (await f.client.request("/v1/operations/large", {
    method: "POST",
    token: access.token,
    body: start("process.stdout.write('x'.repeat(900000))"),
  })) as { processId: string };
  await delay(100);
  const result = await consume(f.client, receipt.processId, access.token);
  expect(result.chunks.map((c) => c.text).join("").length).toBe(900000);
  expect(result.terminal?.["result"]).toMatchObject({ exitCode: 0 });
  await expect(
    (async () => {
      for await (const _ of f.client.watch(receipt.processId, 999999, access.token)) {
        /* drain */
      }
    })(),
  ).rejects.toMatchObject({ code: Code.FailedPrecondition });
});

it("rejects invalid process limits before spawn and reserves capacity before concurrent starts", async () => {
  const f = await fixture();
  const access = await f.grant();
  await expect(
    f.client.request("/v1/operations/invalid", {
      method: "POST",
      token: access.token,
      body: {
        ...start("require('fs').writeFileSync('unexpected.txt','x');setInterval(()=>{},1000)"),
        timeoutMs: 0,
      },
    }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  await delay(50);
  await expect(readFile(join(f.options.rootDirectory, "unexpected.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const requests = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      f.client.request(`/v1/operations/capacity-${i}`, {
        method: "POST",
        token: access.token,
        body: start("setInterval(()=>{},1000)"),
      }),
    ),
  );
  expect(requests.filter((r) => r.status === "fulfilled")).toHaveLength(8);
  expect(requests.filter((r) => r.status === "rejected")).toHaveLength(4);
});

it("preserves split UTF-8 characters and bounds replacement text from invalid bytes", async () => {
  const f = await fixture();
  const access = await f.grant();
  const unicode = (await f.client.request("/v1/operations/unicode", {
    method: "POST",
    token: access.token,
    body: start(
      "process.stdout.write(Buffer.from([240,159]));setTimeout(()=>process.stdout.write(Buffer.from([152,128])),40)",
    ),
  })) as { processId: string };
  const result = await consume(f.client, unicode.processId, access.token);
  expect(result.chunks.map((chunk) => chunk.text).join("")).toBe("😀");
  expect(result.terminal?.["result"]).toMatchObject({ stdout: "😀", exitCode: 0 });
  const invalid = (await f.client.request("/v1/operations/invalid-utf8", {
    method: "POST",
    token: access.token,
    body: start("process.stdout.write(Buffer.alloc(400000,255))"),
  })) as { processId: string };
  const bounded = await consume(f.client, invalid.processId, access.token);
  expect(bounded.terminal?.["status"]).toBe("failed");
  expect(bounded.terminal?.["error"]).toMatch(/output exceeded bound/);
  const text = bounded.chunks.map((chunk) => chunk.text).join("");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
  expect(bounded.terminal?.["result"]).toMatchObject({ stdout: text });
});

it("resumes an exact missing-status stream failure from its acknowledged cursor", async () => {
  const cursors: number[] = [];
  let droppedAt: number | undefined;
  let starts = 0;
  const f = await fixture(async (request) => {
    if (request.method === "POST" && request.url === "/v1/operations/missing-status") starts++;
    if (!request.url.startsWith("/v1/processes/")) return;
    const cursor = Number(new URL(request.url, "http://localhost").searchParams.get("cursor"));
    cursors.push(cursor);
    if (cursor > 0 && droppedAt === undefined) {
      droppedAt = cursors.length - 1;
      throw new ConnectError("protocol error: missing status", Code.Internal);
    }
  });
  const access = await f.grant();
  const receipt = (await f.client.request("/v1/operations/missing-status", {
    method: "POST",
    token: access.token,
    body: start(
      "require('fs').appendFileSync('missing-status-effect.txt','x'); let n=0; const timer=setInterval(()=>{console.log(++n); if(n===8) clearInterval(timer)},40)",
    ),
  })) as { processId: string };
  const result = await consume(f.client, receipt.processId, access.token);
  expect(droppedAt).toBeDefined();
  if (droppedAt === undefined) throw new Error("Stream failure was not injected");
  expect(cursors[droppedAt + 1]).toBe(cursors[droppedAt]);
  expect(result.chunks.map((chunk) => chunk.sequence)).toEqual(result.chunks.map((_, i) => i + 1));
  expect(result.chunks.map((chunk) => chunk.text).join("")).toBe(
    Array.from({ length: 8 }, (_, i) => `${i + 1}\n`).join(""),
  );
  expect(result.terminal?.["status"]).toBe("completed");
  expect(starts).toBe(1);
  expect(await readFile(join(f.options.rootDirectory, "missing-status-effect.txt"), "utf8")).toBe(
    "x",
  );
});

it.each([
  ["protocol error: missing status", 4],
  ["unrelated internal failure", 1],
  ["protocol error: missing status with unrelated detail", 1],
] as const)("bounds read-only retries for %s", async (message, expectedWatches) => {
  let watches = 0;
  let starts = 0;
  const f = await fixture(async (request) => {
    if (request.method === "POST" && request.url === "/v1/operations/retry-bound") starts++;
    if (request.url.startsWith("/v1/processes/")) {
      watches++;
      throw new ConnectError(message, Code.Internal);
    }
  });
  const access = await f.grant();
  const receipt = (await f.client.request("/v1/operations/retry-bound", {
    method: "POST",
    token: access.token,
    body: start("console.log('once')"),
  })) as { processId: string };
  await expect(consume(f.client, receipt.processId, access.token)).rejects.toMatchObject({
    code: Code.Internal,
    rawMessage: message,
  });
  expect(watches).toBe(expectedWatches);
  expect(starts).toBe(1);
});
