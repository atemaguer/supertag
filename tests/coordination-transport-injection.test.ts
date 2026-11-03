import { describe, expect, it } from "vitest";
import {
  collectTaskAttemptEvents,
  connectWorkerMcpClient,
  createWorker,
  type Harness,
  type HarnessPlan,
  LocalExecutionEnvironmentProvider,
  startMcpPolicyProxy,
} from "../packages/runtime/sdk/src/index.js";
import { repositoryAttempt } from "./support/repository-execution.js";

describe("Worker-owned coordination transport", () => {
  it.each(["worker-host", "policy-proxy"] as const)(
    "keeps %s MCP on the injected per-Attempt transport",
    async (mode) => {
      const calls: string[] = [];
      const empty = (): HarnessPlan["execution"] => ({
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      });
      const harness: Harness = {
        id: "coordination-test",
        async describe() {
          return {
            sessions: { resume: false, export: false, scope: "none" as const },
            id: "coordination-test",
            version: "1",
            inputKinds: ["instruction", "tool"],
            streaming: true,
            cancellation: true,
            sessionPersistence: "none",
            toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
            mcpClients: [{ client: "worker-host", transports: ["mcp-http"] }],
          };
        },
        async plan() {
          return { runtime: empty(), execution: empty() };
        },
        async start(_plan, _environments, context) {
          const input = context.tools.find((tool) => tool.id === "supertag-coordination");
          if (!input) throw new Error("Missing coordination tool");
          const proxy = mode === "policy-proxy" ? await startMcpPolicyProxy(input) : undefined;
          const connection = await connectWorkerMcpClient(
            proxy
              ? {
                  ...input,
                  binding: {
                    kind: "mcp-http",
                    name: "supertag-coordination",
                    url: proxy.url,
                    runtimeHeaders: proxy.headers,
                  },
                }
              : input,
          );
          return {
            async *run() {
              expect(await connection.callTool("read_objective", {})).toMatchObject({
                content: [{ type: "text", text: context.attempt.attemptId }],
              });
              yield { type: "output.message", text: "coordinated" };
            },
            async close() {
              await connection.close();
              await proxy?.close();
            },
          };
        },
      };
      const worker = createWorker({
        id: "coordination-test",
        profiles: [
          {
            ref: { id: "repository", revision: "1" },
            workerType: "test",
            harness: { provider: harness.id },
            execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
          },
        ],
        harnesses: [harness],
        environments: [new LocalExecutionEnvironmentProvider()],
        coordinationFetch: (spec) => async (_url, init) => {
          const rpc = JSON.parse(String(init?.body ?? "{}"));
          if (rpc.id === undefined) return new Response(null, { status: 202 });
          let result: unknown = {};
          if (rpc.method === "initialize")
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            };
          if (rpc.method === "tools/list")
            result = { tools: [{ name: "read_objective", inputSchema: { type: "object" } }] };
          if (rpc.method === "tools/call") {
            calls.push(spec.attemptId);
            result = { content: [{ type: "text", text: spec.attemptId }] };
          }
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
        },
      });
      for (const id of ["first", "second"]) {
        const spec = {
          ...repositoryAttempt(id),
          coordination: {
            controlPlaneUrl: "http://127.0.0.1:1",
            token: `token-${id}`,
            scope: "surface" as const,
          },
        };
        const events = await collectTaskAttemptEvents(worker.execute(spec));
        expect(events.at(-1)?.type).toBe("execution.completed");
      }
      expect(calls).toEqual(["first-attempt", "second-attempt"]);
    },
  );
});
