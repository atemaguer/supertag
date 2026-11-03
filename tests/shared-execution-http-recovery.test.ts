import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { startSharedExecutionServer } from "../packages/runtime/environments/shared-execution/src/server.js";
import { repositoryAttempt } from "./support/repository-execution.js";

const adminToken = "http-recovery-test-administrator";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  while (cleanups.length) {
    try {
      await cleanups.pop()?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "HTTP recovery fixture cleanup failed");
});
async function options() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-http-recovery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return {
    rootDirectory: join(directory, "workspace"),
    statePath: join(directory, "state.json"),
    environmentId: "http-recovery",
    adminToken,
  };
}
async function request(url: string, path: string, token: string, method = "GET", body?: object) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function grant(url: string, id: string, ttlMs = 60000) {
  const token = `http-test-access-credential-long-enough-${id}`;
  await request(url, `/v1/accesses/${id}`, adminToken, "PUT", {
    taskId: id,
    attemptId: id,
    tagId: "tag",
    accessToken: token,
    ttlMs,
  });
  return token;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function startChild(config: Awaited<ReturnType<typeof options>> & { port?: number }) {
  const module = new URL(
    "../packages/runtime/environments/shared-execution/src/server.ts",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const {startSharedExecutionServer}=await import(${JSON.stringify(module)}); const server=await startSharedExecutionServer(JSON.parse(process.env.TEST_EXECUTION_OPTIONS)); process.send({url:server.url});`,
    ],
    {
      env: { ...process.env, TEST_EXECUTION_OPTIONS: JSON.stringify(config) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  cleanups.push(() => kill(child));
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8192);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const result = await Promise.race([
      once(child, "message").then(([message]) => message as { url: string }),
      once(child, "exit").then(() => {
        throw new Error(
          `Execution fixture exited before readiness: ${stderr.replaceAll(adminToken, "[REDACTED]")}`,
        );
      }),
    ]);
    return { child, url: result.url };
  } finally {
    clearTimeout(timeout);
  }
}

it("keeps a command uncertain after service SIGKILL and never repeats its accepted write", async () => {
  const config = await options();
  let service = await startChild(config);
  const token = await grant(service.url, "interrupted");
  const body = {
    kind: "process.start",
    command: process.execPath,
    environment: {},
    args: [
      "-e",
      "const fs=require('fs');fs.writeFileSync('child.pid',String(process.pid));fs.appendFileSync('effect.txt','x');console.log('written');setInterval(()=>{},1000)",
    ],
  };
  let processPid: number | undefined;
  cleanups.push(async () => {
    if (processPid)
      try {
        process.kill(-processPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
  });
  const receipt = await request(service.url, "/v1/operations/write-once", token, "POST", body);
  await expect
    .poll(async () => {
      processPid =
        Number(await readFile(join(config.rootDirectory, "child.pid"), "utf8").catch(() => "0")) ||
        undefined;
      return readFile(join(config.rootDirectory, "effect.txt"), "utf8").catch(() => "");
    })
    .toBe("x");
  await expect
    .poll(
      async () =>
        (await request(service.url, `/v1/processes/${receipt.processId}`, token)).chunks.length,
    )
    .toBeGreaterThan(0);
  const port = Number(new URL(service.url).port);
  await kill(service.child);
  service = await startChild({ ...config, port });
  const retry = await request(service.url, "/v1/operations/write-once", token, "POST", body);
  expect(retry).toMatchObject({ status: "uncertain", processId: receipt.processId });
  expect(retry.error).toContain("restarted before operation completion was observed");
  const observed = await request(service.url, `/v1/processes/${receipt.processId}`, token);
  expect(observed.status).toBe("uncertain");
  expect(observed.chunks.map((chunk: { text: string }) => chunk.text).join("")).toBe("written\n");
  expect(await readFile(join(config.rootDirectory, "effect.txt"), "utf8")).toBe("x");
  await expect(
    request(service.url, "/v1/operations/write-once", token, "POST", {
      ...body,
      args: ["-e", "process.exit(0)"],
    }),
  ).rejects.toThrow(/409/);
}, 15000);

it("retries a dropped staging acknowledgement across restart and detects another access's edit", async () => {
  const config = await options();
  let owner = await startSharedExecutionServer(config);
  cleanups.push(() => owner.close());
  const operationPaths: string[] = [];
  let dropped = false;
  let proxyError: unknown;
  const proxy = createServer(async (incoming, response) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const result = await owner.dispatch({
        method: incoming.method ?? "GET",
        url: incoming.url ?? "/",
        headers: { authorization: incoming.headers.authorization },
        ...(body ? { body } : {}),
      });
      if (body?.kind === "file.stage") {
        operationPaths.push(incoming.url ?? "");
        if (!dropped) {
          dropped = true;
          const other = await grant(owner.url, "other-editor");
          await request(owner.url, "/v1/operations/newer-edit", other, "POST", {
            ...body,
            kind: "file.write",
            exclusive: false,
            contentBase64: Buffer.from("newer shared edit").toString("base64"),
          });
          await owner.close();
          owner = await startSharedExecutionServer(config);
          response.destroy();
          return;
        }
      }
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      proxyError = error;
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const provider = new SharedExecutionEnvironmentProvider({
    baseUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    adminToken,
    environmentId: config.environmentId,
  });
  const task = repositoryAttempt("fixture");
  const environment = await provider.provision({
    task,
    plan: {
      files: [],
      mounts: [],
      secretBindings: [],
      environmentVariables: {},
      network: { mode: "unrestricted" },
    },
    profile: {
      ref: task.workerProfile,
      workerType: "fixture",
      harness: { provider: "fixture" },
      execution: { provider: provider.id, lifetime: { scope: "attempt" } },
    },
  });
  await expect(
    environment.prepare({
      files: [{ path: "shared.txt", content: "original edit" }],
      mounts: [],
      secretBindings: [],
      environmentVariables: {},
      network: { mode: "unrestricted" },
    }),
  ).rejects.toThrow("differs from required input");
  expect(dropped).toBe(true);
  expect(proxyError).toBeUndefined();
  expect(operationPaths).toHaveLength(2);
  expect(operationPaths[1]).toBe(operationPaths[0]);
  expect(await environment.read("shared.txt")).toBe("newer shared edit");
  await environment.dispose("completed");
});

it("preserves revoked access across HTTP service restart while independent access remains usable", async () => {
  const config = await options();
  let owner = await startSharedExecutionServer(config);
  cleanups.push(() => owner.close());
  const revoked = await grant(owner.url, "revoked");
  const survivor = await grant(owner.url, "survivor");
  const write = {
    kind: "file.write",
    path: "shared.txt",
    contentBase64: Buffer.from("before").toString("base64"),
  };
  await request(owner.url, "/v1/operations/before", revoked, "POST", write);
  await request(owner.url, "/v1/accesses/revoked", adminToken, "DELETE");
  await owner.close();
  owner = await startSharedExecutionServer(config);
  await expect(request(owner.url, "/v1/operations/before", revoked, "POST", write)).rejects.toThrow(
    /401.*revoked/,
  );
  await expect(request(owner.url, "/v1/operations/after", revoked, "POST", write)).rejects.toThrow(
    /401.*revoked/,
  );
  await request(owner.url, "/v1/operations/survivor", survivor, "POST", {
    ...write,
    exclusive: false,
    contentBase64: Buffer.from("after").toString("base64"),
  });
  expect(await readFile(join(config.rootDirectory, "shared.txt"), "utf8")).toBe("after");
  await expect(request(owner.url, "/v1/accesses/revoked", revoked, "POST")).resolves.toMatchObject({
    status: "released",
    accessId: "revoked",
  });
  await expect(request(owner.url, "/v1/accesses/revoked", revoked, "POST")).resolves.toMatchObject({
    status: "released",
  });
  await expect(
    request(owner.url, "/v1/operations/forbidden-after-release", revoked, "POST", write),
  ).rejects.toThrow(/401.*revoked/);
});

it("allows expired credentials to release only their own access without restoring execution authority", async () => {
  const config = await options();
  const owner = await startSharedExecutionServer(config);
  cleanups.push(() => owner.close());
  const token = await grant(owner.url, "expires", 1000);
  const other = await grant(owner.url, "other");
  const body = {
    kind: "process.start",
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    environment: {},
  };
  const receipt = await request(owner.url, "/v1/operations/running", token, "POST", body);
  await expect
    .poll(async () =>
      request(owner.url, "/v1/operations/running", token).then(
        () => "active",
        (error) => error.message,
      ),
    )
    .toMatch(/401.*expired/);
  for (const operation of [
    { kind: "file.read", path: "missing.txt", maximumBytes: 100 },
    { kind: "file.write", path: "forbidden.txt", contentBase64: "eA==" },
    body,
  ])
    await expect(
      request(owner.url, `/v1/operations/expired-${operation.kind}`, token, "POST", operation),
    ).rejects.toThrow(/401.*expired/);
  await expect(request(owner.url, `/v1/processes/${receipt.processId}`, token)).rejects.toThrow(
    /401.*expired/,
  );
  await expect(request(owner.url, "/v1/accesses/other", token, "POST")).rejects.toThrow(
    /403.*only itself/,
  );
  await expect(request(owner.url, "/v1/accesses/expires", other, "POST")).rejects.toThrow(
    /403.*only itself/,
  );
  await expect(
    request(owner.url, "/v1/accesses/expires", "not-the-issued-credential", "POST"),
  ).rejects.toThrow(/401/);
  await expect(request(owner.url, "/v1/accesses/expires", token, "POST")).resolves.toMatchObject({
    status: "released",
    accessId: "expires",
  });
  await expect(request(owner.url, "/v1/accesses/expires", token, "POST")).resolves.toMatchObject({
    status: "released",
  });
  await expect
    .poll(async () => (await (await fetch(`${owner.url}/healthz`)).json()).activeProcesses)
    .toBe(0);
  await expect(
    request(owner.url, "/v1/operations/after-expired-release", token, "POST", body),
  ).rejects.toThrow(/401.*revoked/);
  await expect(
    request(owner.url, "/v1/operations/other-still-authorized", other, "POST", {
      kind: "file.write",
      path: "other.txt",
      contentBase64: "eA==",
    }),
  ).resolves.toMatchObject({ status: "completed" });
});

it("rejects cleanup credentials from a replaced environment incarnation", async () => {
  const config = await options();
  let owner = await startSharedExecutionServer({ ...config, incarnationId: "old" });
  cleanups.push(() => owner.close());
  const token = await grant(owner.url, "old-access");
  await owner.close();
  owner = await startSharedExecutionServer({ ...config, incarnationId: "replacement" });
  await expect(request(owner.url, "/v1/accesses/old-access", token, "POST")).rejects.toThrow(
    /409.*incarnation was replaced/,
  );
});

it("shares pending disposal and retries an unacknowledged release instead of reporting false success", async () => {
  const config = await options();
  const owner = await startSharedExecutionServer(config);
  cleanups.push(() => owner.close());
  const releasePaths: string[] = [];
  let proxyError: unknown;
  const proxy = createServer(async (incoming, response) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const result = await owner.dispatch({
        method: incoming.method ?? "GET",
        url: incoming.url ?? "/",
        headers: { authorization: incoming.headers.authorization },
        ...(body ? { body } : {}),
      });
      if (incoming.method === "POST" && incoming.url?.startsWith("/v1/accesses/")) {
        releasePaths.push(incoming.url);
        if (releasePaths.length === 1) {
          response.destroy();
          return;
        }
      }
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      proxyError = error;
      response.destroy();
    }
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
  });
  const provider = new SharedExecutionEnvironmentProvider({
    baseUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    adminToken,
    environmentId: config.environmentId,
  });
  const task = repositoryAttempt("disposal");
  const plan = {
    files: [],
    mounts: [],
    secretBindings: [],
    environmentVariables: {},
    network: { mode: "unrestricted" as const },
  };
  const environment = await provider.provision({
    task,
    plan,
    profile: {
      ref: task.workerProfile,
      workerType: "fixture",
      harness: { provider: "fixture" },
      execution: { provider: provider.id, lifetime: { scope: "attempt" } },
    },
  });
  const first = await Promise.allSettled([environment.dispose(), environment.dispose()]);
  expect(first.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(releasePaths).toHaveLength(1);
  await expect(environment.read("blocked-after-dispose.txt")).rejects.toThrow(/closed/);
  await expect(
    environment.spawn({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
  ).rejects.toThrow(/closed/);
  await expect(environment.dispose()).resolves.toBeUndefined();
  expect(releasePaths).toHaveLength(2);
  expect(releasePaths[1]).toBe(releasePaths[0]);
  await environment.dispose();
  expect(releasePaths).toHaveLength(2);
  expect(proxyError).toBeUndefined();
});
