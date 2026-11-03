import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.ts";
import {
  type ExecutionEnvironment,
  type ExecutionEnvironmentSpec,
  LocalExecutionEnvironmentProvider,
  type ProcessHandle,
} from "./src/index.ts";

function spec(): ExecutionEnvironmentSpec {
  return {
    task: repositoryAttempt("http"),
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "test",
      harness: { provider: "test" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
    },
    plan: {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
    },
  };
}
async function server(
  environment: ExecutionEnvironment,
): Promise<{ handle: ProcessHandle; port: number }> {
  const handle = await environment.spawn({
    command: process.execPath,
    args: [
      "-e",
      `const http=require('node:http');const server=http.createServer((q,s)=>{if(q.url==='/large'){s.end('x'.repeat(4096));return}if(q.url==='/redirect'){s.writeHead(302,{location:'http://example.com/'});s.end();return}if(q.url==='/slow'){setTimeout(()=>s.end('late'),30000);return}const chunks=[];q.on('data',c=>chunks.push(c));q.on('end',()=>{s.setHeader('x-test','owned');s.end(Buffer.concat(chunks).length?Buffer.concat(chunks):Buffer.from('ready'))})});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`,
    ],
    streamOutput: true,
  });
  if (!handle.output) throw new Error("Missing server output");
  let output = "";
  for await (const chunk of handle.output) {
    output += chunk.text;
    if (output.includes("\n")) return { handle, port: Number(output.trim()) };
  }
  throw new Error("Server failed before listening");
}
// Local disposal must inspect the host process tree. Some sandboxed macOS runners
// deny /bin/ps entirely, so these live process cases cannot establish ownership there.
const canInspectProcesses = (() => {
  try {
    execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pid="], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canInspectProcesses)("environment-owned HTTP connections", () => {
  it("reaches only the owned server, preserves binary bodies, and does not follow redirects", async () => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec());
    try {
      expect(env.guarantees).toMatchObject({
        filesystemIsolation: "none",
        networkPolicy: "none",
        scopedHttp: true,
      });
      const { handle, port } = await server(env);
      if (!env.connect) throw new Error("Missing connect");
      const connection = await env.connect(handle, { port, maxResponseBytes: 1024 });
      expect(
        await connection.request({ path: "/", method: "POST", body: new Uint8Array([0, 255, 7]) }),
      ).toMatchObject({
        status: 200,
        body: new Uint8Array([0, 255, 7]),
        headers: { "x-test": "owned" },
      });
      expect((await connection.request({ path: "/redirect" })).status).toBe(302);
      await expect(connection.request({ path: "/large" })).rejects.toThrow("byte bound");
      expect(() => connection.request({ path: "http://example.com" })).toThrow("origin-relative");
      expect(() => connection.request({ path: "/", headers: { Host: "example.com" } })).toThrow(
        "provider-owned",
      );
      await connection.close();
      expect(() => connection.request({ path: "/" })).toThrow("closed");
    } finally {
      await env.dispose("completed");
    }
  });
  it("rejects foreign handles and unrelated host listeners without sending HTTP data", async () => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec());
    let requests = 0;
    const unrelated = createServer((_request, response) => {
      requests++;
      response.end("private host service");
    });
    await new Promise<void>((resolve) => unrelated.listen(0, "127.0.0.1", resolve));
    try {
      const { handle } = await server(env);
      const address = unrelated.address();
      if (!address || typeof address === "string" || !env.connect)
        throw new Error("Missing socket");
      await expect(env.connect({ ...handle }, { port: address.port })).rejects.toThrow(
        "owned by this environment",
      );
      await expect(env.connect(handle, { port: address.port })).rejects.toThrow("not owned");
      expect(requests).toBe(0);
    } finally {
      await env.dispose("completed");
      await new Promise<void>((resolve, reject) =>
        unrelated.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("aborts an in-flight local request without killing its server and revokes handles after disposal", async () => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec());
    try {
      const { handle, port } = await server(env);
      if (!env.connect) throw new Error("Missing connect");
      const connection = await env.connect(handle, { port });
      const controller = new AbortController();
      const pending = connection.request({ path: "/slow" }, controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      controller.abort(new Error("cancel request"));
      await rejected;
      expect(new TextDecoder().decode((await connection.request({ path: "/" })).body)).toBe(
        "ready",
      );
      await env.dispose("completed");
      expect(() => connection.request({ path: "/" })).toThrow();
    } finally {
      await env.dispose("completed");
    }
  });
});
