import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import {
  connectExecutionEnvironmentMcpClient,
  connectWorkerMcpClient,
  ExecutionCleanupError,
  type ExecutionContext,
  type HarnessEvent,
  type HarnessPlan,
  InMemorySessionStateStore,
  LocalExecutionEnvironmentProvider,
  type McpClientConnection,
  type ToolInput,
} from "../../sdk/src/index.js";
import { startCodexAppServer } from "./src/app-server.js";

async function fixture(
  mode: string,
  limits?: { maxAgents: number; maxTokens?: number },
  resume = false,
  signal?: AbortSignal,
  onInitialize?: () => void,
  managerTool?: ToolInput,
  environmentOwnedMcp = false,
  timeoutMs = 10000,
  connectDynamicTool?: (input: ToolInput) => Promise<McpClientConnection>,
  dynamicToolInputs?: readonly ToolInput[],
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-server-"));
  const script = join(directory, "server.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
let capacityStarts=0;const mode=${JSON.stringify(mode)};const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params});const reply=(id,result)=>send({id,result});
const usage=(threadId,total,cached=0)=>notify('thread/tokenUsage/updated',{threadId,turnId:'turn',tokenUsage:{total:{inputTokens:total-2,outputTokens:2,cachedInputTokens:cached,totalTokens:total}}});
const done=(threadId,status='completed')=>notify('turn/completed',{threadId,turn:{id:'turn',status}});
function complete(){notify('item/completed',{threadId:'root',item:{type:'agentMessage',id:'a',text:'final answer'}});usage('root',150);done('root');}
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize'){if(mode==='startup-failed')return send({id:m.id,error:{code:-32603,message:'fixture initialization failed'}});if(mode==='hung-initialize')return;return reply(m.id,{codexHome:process.env.CODEX_HOME});}
if(m.method==='initialized')return;
if(m.method==='config/read'){if(mode==='project-config'){fs.writeFileSync('config-checked.txt','checked');return reply(m.id,{layers:[{name:{type:'project'},config:{mcp_servers:{untrusted:{command:'bad'}}},disabledReason:null}]});}return reply(m.id,{layers:[]});}
if(m.method==='thread/read'){if(m.params.includeTurns!==false)process.exit(12);if(mode==='unknown')return;if(mode==='unowned-parent')return reply(m.id,{thread:{id:'unowned',parentThreadId:'outsider'}});if(mode==='wrong-read-id')return reply(m.id,{thread:{id:'different',parentThreadId:'root'}});if(mode==='read-parent')return reply(m.id,{thread:{id:'child',parentThreadId:'root'}});return;}
if(m.method==='thread/resume'&&m.params.threadId==='child'){if(Object.keys(m.params).length!==1)process.exit(10);fs.writeFileSync('subscribed.txt','child');if(mode==='terminal-snapshot'){usage('child',5);fs.writeFileSync('settled.txt','children settled');return reply(m.id,{thread:{id:'child',forkedFromId:null,status:{type:'idle'},turns:[{id:'turn',status:'completed'}]}});}return reply(m.id,{thread:{id:'child',forkedFromId:mode==='forked-child'?'root':null}});}
if(m.method==='thread/start'||m.method==='thread/resume'){if(m.params.ephemeral || m.params.sandbox!=='read-only' || m.params.approvalPolicy!=='never')process.exit(9);if(mode.startsWith('manager-')){if(m.method!=='thread/start')process.exit(19);fs.writeFileSync('dynamic-tools.json',JSON.stringify(m.params.dynamicTools));}if(m.method==='thread/resume'&&!mode.startsWith('resume-without')&&mode!=='resume-stale')usage('root',100);return reply(m.id,{thread:{id:'root'}});}
if(m.method==='turn/start'){if(mode==='turn-failed')return send({id:m.id,error:{code:-32603,message:'fixture turn failed'}});if(m.params.threadId!=='root')process.exit(11);
 reply(m.id,{turn:{id:'turn'}});notify('turn/started',{threadId:'root',turn:{id:'turn',...(mode==='reported-model-cost'?{model:'gpt-5'}:{})}});
 if(mode==='default-model-cost'||mode==='reported-model-cost'){complete();return;}
 if(mode.startsWith('capacity-')){capacityStarts++;fs.writeFileSync('capacity-starts.txt',String(capacityStarts));if((mode==='capacity-once'||mode==='capacity-similar')&&capacityStarts===2){complete();return;}if(mode==='capacity-tool')notify('item/started',{threadId:'root',item:{type:'commandExecution',id:'command'}});if(mode==='capacity-output')notify('item/agentMessage/delta',{threadId:'root',delta:'partial'});if(mode==='capacity-usage')usage('root',1);notify('turn/completed',{threadId:'root',turn:{id:'turn',status:'failed',error:{message:mode==='capacity-quota'?'Usage limit reached':mode==='capacity-similar'?'Provider is temporarily at capacity. Try again later.':'Selected model is at capacity. Please try a different model.'}}});return;}
 if(mode==='manager-flood'){send({id:903,method:'item/tool/call',params:{threadId:'root',turnId:'turn',callId:'manager-call',namespace:'supertag-coordination',tool:'start_session',arguments:{taskId:'task-1'}}});const delta='x'.repeat(65536);for(let i=0;i<63;i++)notify('item/commandExecution/outputDelta',{threadId:'root',itemId:'c',delta});process.stdout.write(JSON.stringify({method:'item/commandExecution/outputDelta',params:{threadId:'root',itemId:'c',delta}})+'\\n',()=>fs.writeFileSync('flooded.txt','4 MiB written'));return;}
 if(mode.startsWith('manager-')){const threadId=mode==='manager-forged-child'?'child':'root';const turnId=mode==='manager-forged-turn'?'other-turn':'turn';const args=mode==='manager-malformed-arguments'?[]:{taskId:'task-1'};send({id:903,method:'item/tool/call',params:{threadId,turnId,callId:'manager-call',namespace:'supertag-coordination',tool:'start_session',arguments:args}});return;}
 if(['unknown','unowned-parent','wrong-read-id'].includes(mode)){notify('thread/tokenUsage/updated',{threadId:'unowned',tokenUsage:{total:{}}});complete();return;}
 if(mode==='forked-child'){notify('thread/started',{thread:{id:'child',parentThreadId:'root'}});return;}
 if(mode==='limit'){notify('item/completed',{threadId:'root',item:{type:'collabAgentToolCall',senderThreadId:'root',tool:'spawnAgent',receiverThreadIds:['one','two']}});return;}
 if(mode==='denials'){send({id:901,method:'item/commandExecution/requestApproval',params:{threadId:'root'}});return;}
 if(mode.includes('budget-reminder')){usage('root',80000);usage('root',85000);return;}
 if(mode==='budget-low-headroom'){usage('root',99000);notify('item/completed',{threadId:'root',item:{type:'agentMessage',id:'a',text:'final answer'}});done('root');return;}
 if(mode==='commands'){notify('item/started',{threadId:'root',item:{type:'commandExecution',id:'c1',command:'pnpm test:verify',status:'inProgress'}});notify('item/completed',{threadId:'root',item:{type:'commandExecution',id:'c1',command:'pnpm test:verify',status:'completed',exitCode:1}});complete();return;}
 if(mode==='large-usage'){usage('root',300000,250000);notify('item/completed',{threadId:'root',item:{type:'agentMessage',id:'a',text:'final answer'}});done('root');return;}
 if(mode==='resume'||mode==='resume-without-baseline'){complete();return;}
 if(mode==='resume-stale'){usage('root',50);return;}
 if(mode==='resume-without-usage'){notify('item/completed',{threadId:'root',item:{type:'agentMessage',id:'a',text:'final answer'}});done('root');return;}
 if(mode.startsWith('endless-progress')){setInterval(()=>notify('item/agentMessage/delta',{threadId:'root',delta:'still working'}),10);return;}
 notify('item/agentMessage/delta',{threadId:'root',delta:'active'});return;
}
if(m.method==='turn/steer'){
 if(mode.includes('budget-reminder')){fs.appendFileSync('budget-reminders.jsonl',JSON.stringify(m.params)+'\\n');if(mode==='budget-reminder-rejected')send({id:m.id,error:{code:-32600,message:'turn already finishing'}});else reply(m.id,{turnId:'turn'});notify('item/completed',{threadId:'root',item:{type:'agentMessage',id:'a',text:'final answer'}});done('root');return;}
 if(mode==='terminal-before-steer-ack'){complete();setTimeout(()=>reply(m.id,{turnId:'turn'}),30);return;}
 if(mode==='unanswered-steer'){complete();return;}
 if(m.params.expectedTurnId!=='turn')process.exit(8);reply(m.id,{turnId:'turn'});
 if(mode==='child-question'){notify('thread/started',{thread:{id:'child',source:{subAgent:{thread_spawn:{parent_thread_id:'root'}}}}});notify('turn/started',{threadId:'child',turn:{id:'turn'}});complete();}
 send({id:900,method:'item/tool/requestUserInput',params:{threadId:mode==='child-question'?'child':'root',turnId:'turn',questions:[{id:'choice',question:'Which option?',header:'Choice',options:null,isSecret:false,isOther:true}]}});return;
}
if(m.method==='turn/interrupt'){reply(m.id,{});done('root','interrupted');return;}
if(m.id===900){if(m.result.answers.choice.answers[0]!=='approved answer')process.exit(7);
 if(mode==='interactive'){complete();return;}
 else if(mode!=='child-question'){if(mode==='early-status'||mode==='read-parent')notify('thread/status/changed',{threadId:'child',status:{type:'active'}});if(mode!=='read-parent')notify('thread/started',{thread:mode==='direct-parent'?{id:'child',parentThreadId:'root',source:'exec'}:{id:'child',source:{subAgent:{thread_spawn:{parent_thread_id:'root'}}}}});complete();}
 if(mode==='terminal-snapshot')return;setTimeout(()=>{usage('child',5);done('child');fs.writeFileSync('settled.txt','children settled');},40);return;}
if(m.id===901){if(m.result.decision!=='decline')process.exit(6);send({id:902,method:'account/chatgptAuthTokens/refresh',params:{}});return;}
if(m.id===902){if(!m.error)process.exit(5);complete();return;}
if(m.id===903){fs.writeFileSync('dynamic-response.json',JSON.stringify(m.result));if(mode==='manager-duplicate'){send({id:904,method:'item/tool/call',params:{threadId:'root',turnId:'turn',callId:'manager-call',namespace:'supertag-coordination',tool:'start_session',arguments:{taskId:'task-1'}}});return;}complete();return;}
});
`,
  );
  const attempt = repositoryAttempt(`appserver-${mode}`);
  const profile = {
    ref: attempt.workerProfile,
    workerType: "supertag",
    harness: { provider: "codex" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
  const context: ExecutionContext = {
    ...(signal ? { signal } : {}),
    attempt,
    profile,
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: managerTool ? [managerTool] : [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const plan: HarnessPlan = {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  };
  const provider = new LocalExecutionEnvironmentProvider();
  const environment = await provider.provision({ task: attempt, profile, plan });
  await environment.prepare(plan);
  if (mode === "late-usage") {
    let controller: ReadableStreamDefaultController<{ stream: "stdout"; text: string }>;
    const output = new ReadableStream<{ stream: "stdout"; text: string }>({
      start(value) {
        controller = value;
      },
    });
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.close();
      resolveDone();
    };
    const send = (value: unknown) =>
      controller.enqueue({ stream: "stdout", text: `${JSON.stringify(value)}\n` });
    environment.spawn = async () => ({
      output,
      write: async (bytes) => {
        const message = JSON.parse(new TextDecoder().decode(bytes));
        const id = message.id;
        switch (message.method) {
          case "initialize":
            send({ id, result: { codexHome: "/tmp/codex-test" } });
            break;
          case "config/read":
            send({ id, result: { layers: [] } });
            break;
          case "thread/start":
            send({ id, result: { thread: { id: "root" } } });
            break;
          case "turn/start":
            send({ id, result: { turn: { id: "turn" } } });
            send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
            send({
              method: "item/completed",
              params: {
                threadId: "root",
                item: { type: "agentMessage", id: "a", text: "final answer" },
              },
            });
            send({
              method: "turn/completed",
              params: { threadId: "root", turn: { id: "turn", status: "completed" } },
            });
            setTimeout(
              () =>
                send({
                  method: "thread/tokenUsage/updated",
                  params: {
                    threadId: "root",
                    turnId: "turn",
                    tokenUsage: {
                      total: {
                        inputTokens: 148,
                        outputTokens: 2,
                        cachedInputTokens: 0,
                        totalTokens: 150,
                      },
                    },
                  },
                }),
              25,
            );
            break;
        }
      },
      endInput: async () => close(),
      kill: close,
      wait: async () => {
        await done;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
  }
  if (onInitialize) {
    const spawn = environment.spawn.bind(environment);
    environment.spawn = async (spec, signal) => {
      const handle = await spawn(spec, signal);
      return {
        ...handle,
        write: async (bytes) => {
          await handle.write?.(bytes);
          if (new TextDecoder().decode(bytes).includes('"method":"initialize"')) onInitialize();
        },
      };
    };
  }
  if (mode === "endless-progress-uncertain-cleanup") {
    const spawn = environment.spawn.bind(environment);
    environment.spawn = async (...args) => {
      const handle = await spawn(...args);
      return {
        ...handle,
        wait: async () => {
          await handle.wait().catch(() => undefined);
          throw new ExecutionCleanupError("Process-tree cleanup could not be confirmed");
        },
      };
    };
  }
  if (mode === "spawn-failed") {
    environment.spawn = async () => {
      throw new Error("fixture spawn failed");
    };
  }
  if (mode === "missing-streams") {
    const spawn = environment.spawn.bind(environment);
    environment.spawn = async (...args) => {
      const { output: _output, ...handle } = await spawn(...args);
      return handle;
    };
  }
  let execution: Awaited<ReturnType<typeof startCodexAppServer>>;
  try {
    execution = await startCodexAppServer({
      request: {
        prompt: "work",
        workspace: environment.rootDirectory,
        timeoutMs,
        command: "codex",
        mcpServers: [],
        toolInputs: managerTool ? [managerTool] : [],
        runtimeActions: [],
        ...(resume ? { resumeThreadId: "root" } : {}),
      },
      environment,
      context,
      ...(environmentOwnedMcp && managerTool
        ? {
            connectDynamicTool: (input: ToolInput) =>
              connectExecutionEnvironmentMcpClient(environment, input, {
                nodeCommand: process.execPath,
              }),
          }
        : {}),
      ...(connectDynamicTool ? { connectDynamicTool } : {}),
      ...(dynamicToolInputs ? { dynamicToolInputs } : {}),
      command: process.execPath,
      args: [script],
      processEnvironment: { CODEX_HOME: environment.resolvePath(".codex") },
      ...(limits ? { limits } : {}),
      ...(resume && !mode.startsWith("resume-without")
        ? {
            usageBaselines: {
              root: { inputTokens: 98, outputTokens: 2, cachedInputTokens: 0, totalTokens: 100 },
            },
          }
        : {}),
    });
  } catch (error) {
    await environment.dispose("failed");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    execution,
    environment,
    attempt,
    cleanup: async () => {
      try {
        await execution.close();
      } finally {
        // This case verifies event ordering. Closing the fake server confirms its process exit;
        // removing its isolated root avoids platform process inventory in restricted test hosts.
        if (mode === "late-usage")
          await rm(environment.rootDirectory, { recursive: true, force: true });
        else await environment.dispose("completed");
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function environmentManagerTool(): ToolInput {
  const server = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "environment-manager", version: "1" } } });
  if (message.method === "tools/list")
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "start_session", description: "Assign from the environment", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } }] } });
  if (message.method === "tools/call")
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: process.env.ENVIRONMENT_MARKER + ":" + message.params.arguments.taskId }] } });
});
`;
  return {
    id: "environment-manager",
    required: true,
    kind: "tool",
    audience: "manager",
    capability: {
      id: "environment-manager",
      provider: "test",
      operations: [
        {
          name: "start_session",
          effect: "write",
          actions: ["sessions:start"],
          resourceArgumentPolicies: [
            {
              match: "scope",
              prefix: "task:",
              components: [{ arguments: ["taskId"] }],
            },
          ],
        },
      ],
      authorization: {
        provider: "test",
        resources: [{ surfaceAccountId: "environment", scope: "task:task-1" }],
      },
    },
    binding: {
      kind: "mcp-stdio",
      name: "supertag-coordination",
      command: process.execPath,
      args: ["-e", server],
      runtimeEnvironment: { ENVIRONMENT_MARKER: "environment-owned" },
    },
  };
}

async function managerToolFixture(responseText = "assigned", advertiseAssign = true) {
  const calls: unknown[] = [];
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const protocol = new McpProtocolServer(
      { name: "manager-tool-test", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertiseAssign
        ? [
            {
              name: "start_session",
              description: "Assign an admitted task",
              inputSchema: {
                type: "object",
                properties: { taskId: { type: "string" } },
                required: ["taskId"],
                additionalProperties: false,
              },
            },
          ]
        : [],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params.arguments);
      return { content: [{ type: "text", text: responseText }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await protocol.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void protocol.close();
    });
  });
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test MCP address");
  const input: ToolInput = {
    id: "supertag-coordination",
    required: true,
    kind: "tool",
    audience: "manager",
    capability: {
      id: "supertag-coordination",
      provider: "supertag",
      operations: [
        {
          name: "start_session",
          effect: "write",
          actions: ["sessions:start"],
          inputSchema: { type: "object" },
          resourceArgumentPolicies: [
            {
              match: "scope",
              prefix: "task:",
              components: [{ arguments: ["taskId"] }],
            },
          ],
        },
        {
          name: "update_objective",
          effect: "write",
          actions: ["objectives:update"],
          inputSchema: { type: "object" },
        },
      ],
      authorization: {
        provider: "supertag",
        resources: [{ surfaceAccountId: "control-plane", scope: "task:task-1" }],
      },
    },
    binding: {
      kind: "mcp-http",
      name: "supertag-coordination",
      url: `http://127.0.0.1:${address.port}/mcp`,
      runtimeHeaders: { authorization: "Bearer manager-only" },
    },
  };
  return {
    calls,
    input,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

it("publishes the dynamically authorized manager subset and dispatches only for the active root turn", async () => {
  const manager = await managerToolFixture();
  const f = await fixture("manager-success", undefined, false, undefined, undefined, manager.input);
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(manager.calls).toEqual([{ taskId: "task-1" }]);
    expect(
      JSON.parse(await readFile(f.environment.resolvePath("dynamic-response.json"), "utf8")),
    ).toEqual({ contentItems: [{ type: "inputText", text: "assigned" }], success: true });
    expect(events.filter((event) => event.type.startsWith("tool.call."))).toMatchObject([
      { type: "tool.call.started", call: { operation: "start_session" } },
      { type: "tool.call.completed", call: { operation: "start_session" } },
    ]);
    expect(
      JSON.parse(await readFile(f.environment.resolvePath("dynamic-tools.json"), "utf8")),
    ).toEqual([
      {
        type: "namespace",
        name: "supertag-coordination",
        description: "Manager-only supertag operations admitted by SuperTag",
        tools: [
          {
            type: "function",
            name: "start_session",
            description: "Assign an admitted task",
            inputSchema: {
              type: "object",
              properties: { taskId: { type: "string" } },
              required: ["taskId"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
  } finally {
    await f.cleanup();
    await manager.close();
  }
});

it("dispatches a Codex dynamic tool through an execution-environment-owned MCP client", async () => {
  const input = environmentManagerTool();
  const f = await fixture("manager-success", undefined, false, undefined, undefined, input, true);
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(
      JSON.parse(await readFile(f.environment.resolvePath("dynamic-response.json"), "utf8")),
    ).toEqual({
      contentItems: [{ type: "inputText", text: "environment-owned:task-1" }],
      success: true,
    });
    expect(events.filter((event) => event.type.startsWith("tool.call."))).toMatchObject([
      { type: "tool.call.started", call: { operation: "start_session" } },
      { type: "tool.call.completed", call: { operation: "start_session" } },
    ]);
  } finally {
    await f.cleanup();
  }
});

it("keeps reading Codex output while a dynamic tool call waits", async () => {
  // The call completes only once Codex has written 4 MiB after requesting it. A pump that
  // awaited the call would stop reading, and backpressure would then block Codex on its pipe.
  let root: string | undefined;
  const callTool = vi.fn(async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (root && (await readFile(join(root, "flooded.txt"), "utf8").catch(() => undefined)))
        return { content: [{ type: "text", text: "assigned after flood" }] };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Codex output stalled while the dynamic tool call waited");
  });
  const f = await fixture(
    "manager-flood",
    undefined,
    false,
    undefined,
    undefined,
    environmentManagerTool(),
    false,
    10000,
    async () => ({
      client: "worker-host",
      tools: [{ name: "start_session", inputSchema: { type: "object" } }],
      callTool,
      close: async () => {},
    }),
  );
  root = f.environment.rootDirectory;
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(callTool).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await readFile(f.environment.resolvePath("dynamic-response.json"), "utf8")),
    ).toEqual({
      contentItems: [{ type: "inputText", text: "assigned after flood" }],
      success: true,
    });
    expect(events.filter((event) => event.type.startsWith("tool.call."))).toMatchObject([
      { type: "tool.call.started", call: { operation: "start_session" } },
      { type: "tool.call.completed", call: { operation: "start_session" } },
    ]);
  } finally {
    await f.cleanup();
  }
}, 15_000);

it("rejects calls to Control Plane coordination operations omitted by dynamic authority", async () => {
  const manager = await managerToolFixture();
  const connected = await connectWorkerMcpClient(manager.input);
  try {
    expect(connected.tools.map((tool) => tool.name)).toEqual(["start_session"]);
    await expect(connected.callTool("update_objective", {})).rejects.toThrow(
      "Tool update_objective is not admitted for this Task",
    );
    expect(manager.calls).toEqual([]);
  } finally {
    await connected.close();
    await manager.close();
  }
});

it("keeps ordinary MCP operation sets fail-closed when an operation is missing", async () => {
  const manager = await managerToolFixture();
  const generic: ToolInput = {
    ...manager.input,
    id: "ordinary-manager-tools",
    capability: {
      ...manager.input.capability,
      id: "ordinary-manager-tools",
      provider: "ordinary-provider",
    },
    binding: { ...manager.input.binding, name: "ordinary-manager-tools" },
  };
  try {
    await expect(connectWorkerMcpClient(generic)).rejects.toThrow(
      "Required Worker-owned MCP tools are unavailable: update_objective",
    );
  } finally {
    await manager.close();
  }
});

it("fails closed when dynamic Control Plane authority advertises no operations", async () => {
  const manager = await managerToolFixture("unused", false);
  try {
    await expect(connectWorkerMcpClient(manager.input)).rejects.toThrow(
      "Required Worker-owned MCP tools are unavailable: start_session, update_objective",
    );
  } finally {
    await manager.close();
  }
});

it.each([
  ["manager-forged-child", "active root turn"],
  ["manager-forged-turn", "active root turn"],
  ["manager-malformed-arguments", "arguments"],
  ["manager-duplicate", "Duplicate dynamic tool call"],
])("rejects %s dynamic tool requests before a second side effect", async (mode, message) => {
  const manager = await managerToolFixture();
  const f = await fixture(mode, undefined, false, undefined, undefined, manager.input);
  try {
    await expect(
      (async () => {
        for await (const _ of f.execution.run()) {
        }
      })(),
    ).rejects.toThrow(message);
    expect(manager.calls).toHaveLength(mode === "manager-duplicate" ? 1 : 0);
  } finally {
    await f.cleanup();
    await manager.close();
  }
});

it("bounds manager tool output before writing it to the Codex process", async () => {
  const manager = await managerToolFixture("x".repeat(1_048_576));
  const f = await fixture(
    "manager-oversize",
    undefined,
    false,
    undefined,
    undefined,
    manager.input,
  );
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(manager.calls).toEqual([{ taskId: "task-1" }]);
    expect(
      JSON.parse(await readFile(f.environment.resolvePath("dynamic-response.json"), "utf8")),
    ).toEqual({
      contentItems: [{ type: "inputText", text: "SuperTag coordination call failed" }],
      success: false,
    });
    expect(
      events.filter((event) => event.type.startsWith("tool.call.")).map((event) => event.type),
    ).toEqual(["tool.call.started", "tool.call.failed"]);
  } finally {
    await f.cleanup();
    await manager.close();
  }
});

it("steers and answers a root-thread question with native subagents disabled", async () => {
  const f = await fixture("interactive", { maxAgents: 0, maxTokens: 500 });
  const events: HarnessEvent[] = [];
  try {
    for await (const event of f.execution.run()) {
      events.push(event);
      if (event.type === "output.delta") {
        const authorizeInput = vi.fn(async () => false);
        expect(
          (
            await f.execution.control?.send(
              {
                id: "revoked-teammate",
                taskId: f.attempt.taskId,
                attemptId: f.attempt.attemptId,
                type: "input",
                text: "must never reach Codex",
                advisory: true,
                requiresInputAuthorization: true,
              },
              { authorizeInput },
            )
          )?.status,
        ).toBe("rejected");
        expect(authorizeInput).toHaveBeenCalledTimes(1);
      }
      if (event.type === "output.delta")
        expect(
          (
            await f.execution.control?.send({
              id: "steer",
              taskId: f.attempt.taskId,
              attemptId: f.attempt.attemptId,
              type: "input",
              text: "focus",
            })
          )?.status,
        ).toBe("accepted");
      if (event.type === "approval.requested")
        expect(
          (
            await f.execution.control?.send({
              id: "answer",
              taskId: f.attempt.taskId,
              attemptId: f.attempt.attemptId,
              type: "reply",
              requestId: event.request.id,
              response: { answers: { choice: { answers: ["approved answer"] } } },
            })
          )?.status,
        ).toBe("accepted");
    }
    expect(f.execution.session).toEqual({ harnessId: "codex", id: "root" });
    expect(f.execution.threadIds).toEqual(["root"]);
    expect(events.filter((e) => e.type === "output.message")).toEqual([
      { type: "output.message", text: "final answer", final: true },
    ]);
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 150, complete: true },
    });
  } finally {
    await f.cleanup();
  }
});
it.each(["child-question", "terminal-snapshot", "direct-parent", "early-status", "read-parent"])(
  "fails closed when %s attempts to introduce a native child",
  async (mode) => {
    const f = await fixture(mode, { maxAgents: 0, maxTokens: 500 });
    try {
      await expect(
        (async () => {
          for await (const event of f.execution.run()) {
            if (event.type === "output.delta")
              await f.execution.control?.send({
                id: "steer",
                taskId: f.attempt.taskId,
                attemptId: f.attempt.attemptId,
                type: "input",
                text: "focus",
              });
            if (event.type === "approval.requested")
              await f.execution.control?.send({
                id: "answer",
                taskId: f.attempt.taskId,
                attemptId: f.attempt.attemptId,
                type: "reply",
                requestId: event.request.id,
                response: { answers: { choice: { answers: ["approved answer"] } } },
              });
          }
        })(),
      ).rejects.toThrow("native agent limit exceeded");
    } finally {
      await f.cleanup();
    }
  },
  15_000,
);
it("an interrupt acknowledgement never becomes a successful result", async () => {
  const f = await fixture("interrupt");
  const events: HarnessEvent[] = [];
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run()) {
          events.push(event);
          if (event.type === "output.delta")
            expect(
              (
                await f.execution.control?.send({
                  id: "cancel",
                  taskId: f.attempt.taskId,
                  attemptId: f.attempt.attemptId,
                  type: "interrupt",
                })
              )?.status,
            ).toBe("accepted");
        }
      })(),
    ).rejects.toThrow("interrupted");
    expect(events.some((e) => e.type === "output.message")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it.each(["unknown", "limit", "unowned-parent", "wrong-read-id", "forked-child"])(
  "fails closed for %s native child execution",
  async (mode) => {
    const f = await fixture(mode, { maxAgents: 0, maxTokens: 500 });
    try {
      await expect(
        (async () => {
          for await (const _ of f.execution.run()) {
          }
        })(),
      ).rejects.toThrow(
        mode === "forked-child" || mode === "limit"
          ? "agent limit"
          : mode === "wrong-read-id"
            ? "different thread identity"
            : "unattributed",
      );
    } finally {
      await f.cleanup();
    }
  },
  15000,
);
it("denies native sandbox escalation and unknown credential requests", async () => {
  const f = await fixture("denials");
  try {
    const events = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
  } finally {
    await f.cleanup();
  }
});
it.each(["default-model-cost", "reported-model-cost"])(
  "estimates native usage without a requested model (%s)",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const events = [];
      for await (const event of f.execution.run()) events.push(event);
      expect(events.filter((event) => event.type === "usage.updated").at(-1)).toMatchObject({
        usage: { reportedCost: { amountMinor: 1, currency: "USD", estimated: true } },
      });
    } finally {
      await f.cleanup();
    }
  },
);

it("records usage published just after the terminal turn notification", async () => {
  const f = await fixture("late-usage");
  try {
    const events = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(events.filter((event) => event.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 150, reportedCost: { estimated: true } },
    });
  } finally {
    await f.cleanup();
  }
});

it("subtracts the persisted baseline on native resume instead of charging lifetime usage", async () => {
  const f = await fixture("resume", { maxAgents: 0, maxTokens: 100 }, true);
  try {
    const events = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 50, complete: true },
    });
    expect(f.execution.threadUsage["root"]?.totalTokens).toBe(150);
  } finally {
    await f.cleanup();
  }
});

it("rejects active project configuration before starting a native turn", async () => {
  await expect(fixture("project-config")).rejects.toThrow("active project or user configuration");
});

it("cancels a hung initialization through the owning environment", async () => {
  const controller = new AbortController();
  let initialized = false;
  const started = Date.now();
  await expect(
    fixture("hung-initialize", undefined, false, controller.signal, () => {
      initialized = true;
      controller.abort(new Error("initialization cancelled"));
    }),
  ).rejects.toThrow();
  expect(initialized).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
}, 3000);

it("retains observed usage when the token budget interrupts execution", async () => {
  const f = await fixture("resume", { maxAgents: 0, maxTokens: 25 }, true);
  const events: HarnessEvent[] = [];
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run()) events.push(event);
      })(),
    ).rejects.toMatchObject({ name: "ExecutionBudgetExceededError" });
    expect(events.filter((event) => event.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 50, complete: true },
    });
    expect(events.some((event) => event.type === "output.message")).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("keeps the completed result when advisory input races terminal execution", async () => {
  const f = await fixture("terminal-before-steer-ack");
  try {
    let acknowledgement: Promise<unknown> | undefined;
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) {
      events.push(event);
      if (event.type === "output.delta")
        acknowledgement = f.execution.control?.send({
          id: "team-input:racing",
          taskId: f.attempt.taskId,
          attemptId: f.attempt.attemptId,
          type: "input",
          text: "Team coordination from a teammate",
          advisory: true,
        });
    }
    // Uncertain, so the item falls back to a digest; the Attempt's result stands.
    expect(await acknowledgement).toMatchObject({ status: "unknown" });
    expect(events.some((event) => event.type === "output.message")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("finishes a completed turn without waiting for an unanswered advisory steer", async () => {
  const f = await fixture("unanswered-steer");
  try {
    let acknowledgement: Promise<unknown> | undefined;
    const events: HarnessEvent[] = [];
    const started = Date.now();
    for await (const event of f.execution.run()) {
      events.push(event);
      if (event.type === "output.delta")
        acknowledgement = f.execution.control?.send({
          id: "team-input:unanswered",
          taskId: f.attempt.taskId,
          attemptId: f.attempt.attemptId,
          type: "input",
          text: "Team coordination from a teammate",
          advisory: true,
        });
    }
    // The steer RPC would wait for its 10 s acknowledgement timeout; finishing must not.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
    expect(acknowledgement).toBeDefined();
    await f.execution.close();
    expect(await acknowledgement).toMatchObject({ status: "unknown" });
  } finally {
    await f.cleanup();
  }
}, 15_000);

it("does not complete or promote Session state when a steer acknowledgement races terminal execution", async () => {
  const f = await fixture("terminal-before-steer-ack");
  try {
    expect(f.execution.control?.capabilities.inputMode).toBe("steer");
    let acknowledgement: Promise<unknown> | undefined;
    const events: HarnessEvent[] = [];
    await expect(
      (async () => {
        for await (const event of f.execution.run()) {
          events.push(event);
          if (event.type === "output.delta")
            acknowledgement = f.execution.control?.send({
              id: "racing-steer",
              taskId: f.attempt.taskId,
              attemptId: f.attempt.attemptId,
              type: "input",
              text: "Process this before finishing",
            });
        }
      })(),
    ).rejects.toThrow("steer acceptance is uncertain");
    expect(await acknowledgement).toMatchObject({ status: "unknown" });
    expect(events.some((event) => event.type === "output.message")).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("reports native shell commands as they start and end", async () => {
  const f = await fixture("commands", { maxAgents: 0 });
  const events: HarnessEvent[] = [];
  try {
    for await (const event of f.execution.run()) events.push(event);
    expect(events.filter((event) => event.type === "command.updated")).toEqual([
      {
        type: "command.updated",
        command: { id: "c1", command: "pnpm test:verify", status: "running" },
      },
      {
        type: "command.updated",
        command: { id: "c1", command: "pnpm test:verify", status: "failed" },
      },
    ]);
  } finally {
    await f.cleanup();
  }
});

it("keeps root usage accounting without an implicit aggregate token cap", async () => {
  const f = await fixture("large-usage", { maxAgents: 0 });
  const events: HarnessEvent[] = [];
  try {
    for await (const event of f.execution.run()) events.push(event);
    expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
    expect(events.filter((event) => event.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 300_000, cachedInputTokens: 250_000, complete: true },
    });
    expect(f.execution.threadUsage["root"]?.totalTokens).toBe(300_000);
    expect(f.execution.threadUsage["child"]).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

it("still interrupts an explicit root token cap including cached input", async () => {
  const f = await fixture("large-usage", { maxAgents: 0, maxTokens: 200_000 });
  const events: HarnessEvent[] = [];
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run()) events.push(event);
      })(),
    ).rejects.toThrow("token budget");
    expect(events.filter((event) => event.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 300_000, cachedInputTokens: 250_000, complete: true },
    });
    expect(events.some((event) => event.type === "output.message")).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("rejects a positive native-agent limit before starting Codex app-server", async () => {
  await expect(fixture("interactive", { maxAgents: 1 })).rejects.toThrow(
    "native subagents are disabled",
  );
});

it("bounds the entire app-server turn even while progress keeps arriving", async () => {
  const started = Date.now();
  const f = await fixture(
    "endless-progress",
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    false,
    1000,
  );
  const events: HarnessEvent[] = [];
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run()) events.push(event);
      })(),
    ).rejects.toThrow("Codex app-server timed out after 1000ms");
    expect(events.some((event) => event.type === "output.delta")).toBe(true);
    expect(Date.now() - started).toBeLessThan(3500);
    await f.execution.close();
    // Disposal checks owned process-tree cleanup; it must not report live execution.
    await f.environment.dispose("failed");
  } finally {
    await f.cleanup();
  }
}, 5000);

it("preserves cleanup uncertainty when an app-server deadline expires", async () => {
  const f = await fixture(
    "endless-progress-uncertain-cleanup",
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    false,
    1000,
  );
  try {
    await expect(
      (async () => {
        for await (const _event of f.execution.run()) {
          /* consume progress until the deadline */
        }
      })(),
    ).rejects.toMatchObject({
      name: "ExecutionCleanupError",
      message: expect.stringContaining("Codex app-server timed out after 1000ms"),
      cause: expect.any(AggregateError),
    });
  } finally {
    await f.cleanup().catch(async (error) => {
      if (!(error instanceof ExecutionCleanupError)) throw error;
      await f.environment.dispose("failed");
    });
  }
}, 5000);

it("applies the same absolute deadline to app-server initialization", async () => {
  const started = Date.now();
  await expect(
    fixture("hung-initialize", undefined, false, undefined, undefined, undefined, false, 500),
  ).rejects.toThrow("Codex app-server timed out after 500ms");
  expect(Date.now() - started).toBeLessThan(2500);
}, 4000);

it("bounds a hung custom MCP connector and closes a connection that arrives after timeout", async () => {
  let provide: ((connection: McpClientConnection) => void) | undefined;
  const opening = new Promise<McpClientConnection>((resolve) => {
    provide = resolve;
  });
  const started = Date.now();
  const close = vi.fn(async () => {});
  await expect(
    fixture(
      "manager-timeout",
      undefined,
      false,
      undefined,
      undefined,
      environmentManagerTool(),
      false,
      100,
      () => opening,
    ),
  ).rejects.toMatchObject({
    name: "ExecutionCleanupError",
    message: expect.stringContaining("connection cleanup could be confirmed"),
  });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(close).not.toHaveBeenCalled();
  provide?.({ client: "worker-host", tools: [], callTool: async () => ({}), close });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
}, 4000);

it.each([
  ["startup-failed", "Codex RPC rejected the request"],
  ["spawn-failed", "fixture spawn failed"],
  ["missing-streams", "requires environment-owned streaming input and output"],
  ["duplicate-namespace", "Dynamic tool namespaces must be unique"],
])("retains %s alongside MCP cleanup uncertainty", async (mode, originalMessage) => {
  const cleanupError = new Error("fixture MCP session deletion failed");
  const close = vi.fn(async () => {
    throw cleanupError;
  });
  const input = environmentManagerTool();
  const connect = vi.fn(
    async (): Promise<McpClientConnection> => ({
      client: "worker-host",
      tools: [],
      callTool: async () => ({}),
      close,
    }),
  );
  const failure = await fixture(
    mode,
    undefined,
    false,
    undefined,
    undefined,
    input,
    false,
    5_000,
    connect,
    mode === "duplicate-namespace" ? [input, input] : undefined,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ExecutionCleanupError);
  expect(failure).toMatchObject({
    message: expect.stringContaining(originalMessage),
    cause: expect.any(AggregateError),
  });
  expect((failure as Error).message).toContain(cleanupError.message);
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "preserves the original turn failure when MCP cleanup fails=%s",
  async (cleanupFails) => {
    const cleanupError = new Error("fixture MCP session deletion failed");
    const close = vi.fn(async () => {
      if (cleanupFails) throw cleanupError;
    });
    const f = await fixture(
      "turn-failed",
      undefined,
      false,
      undefined,
      undefined,
      environmentManagerTool(),
      false,
      5_000,
      async () => ({
        client: "worker-host",
        tools: [],
        callTool: async () => ({}),
        close,
      }),
    );
    try {
      const failure = await (async () => {
        for await (const _ of f.execution.run()) {
          /* consume until the RPC failure */
        }
      })().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Codex RPC rejected the request");
      if (cleanupFails) {
        expect(failure).toBeInstanceOf(ExecutionCleanupError);
        expect((failure as Error).message).toContain(cleanupError.message);
        const cause = (failure as Error).cause as AggregateError;
        expect(cause).toBeInstanceOf(AggregateError);
        expect(cause.errors[0]).toMatchObject({ message: "Codex RPC rejected the request" });
      } else {
        expect(failure).not.toBeInstanceOf(ExecutionCleanupError);
        expect((failure as Error).message).toBe("Codex RPC rejected the request");
      }
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup().catch((error) => {
        if (!cleanupFails || !(error instanceof ExecutionCleanupError)) throw error;
      });
    }
  },
);

it("bounds resumed execution conservatively when interruption left no saved usage baseline", async () => {
  const f = await fixture("resume-without-baseline", { maxAgents: 0, maxTokens: 200 }, true);
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 150, complete: false },
    });
    expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
    expect(f.execution.threadUsage["root"]?.totalTokens).toBe(150);
  } finally {
    await f.cleanup();
  }
});
it("does not subtract the first resumed report and bypass a token ceiling", async () => {
  const f = await fixture("resume-without-baseline", { maxAgents: 0, maxTokens: 100 }, true);
  const events: HarnessEvent[] = [];
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run()) events.push(event);
      })(),
    ).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("unverifiable Attempt usage"),
    });
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: { totalTokens: 150, complete: false },
    });
    expect(events.some((e) => e.type === "output.message")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it("still rejects budget verification when no resumed usage was reported", async () => {
  const f = await fixture("resume-without-usage", { maxAgents: 0, maxTokens: 200 }, true);
  try {
    await expect(
      (async () => {
        for await (const _event of f.execution.run()) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("cannot be verified");
  } finally {
    await f.cleanup();
  }
});

it("rejects a resumed counter below the saved baseline instead of clamping away usage", async () => {
  const f = await fixture("resume-stale", { maxAgents: 0, maxTokens: 200 }, true);
  try {
    await expect(
      (async () => {
        for await (const _event of f.execution.run()) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("precede the saved baseline");
  } finally {
    await f.cleanup();
  }
});

it.each(["budget-reminder", "budget-reminder-rejected", "resume-without-budget-reminder"])(
  "sends one bounded budget advisory without making its delivery a completion requirement: %s",
  async (mode) => {
    const f = await fixture(mode, { maxAgents: 0, maxTokens: 100000 }, mode.startsWith("resume"));
    try {
      const events: HarnessEvent[] = [];
      for await (const event of f.execution.run()) events.push(event);
      const lines = (await readFile(f.environment.resolvePath("budget-reminders.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      const reminder = JSON.parse(lines[0] ?? "{}");
      expect(reminder).toMatchObject({ threadId: "root", expectedTurnId: "turn" });
      expect(reminder.input[0].text).toContain("80000 of 100000");
      expect(reminder.input[0].text).toContain("20000 remain");
      expect(reminder.input[0].text).toContain(
        mode.startsWith("resume") ? "conservative and incomplete" : "Accounting is complete",
      );
      expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
    } finally {
      await f.cleanup();
    }
  },
);

for (const [mode, starts, success] of [
  ["capacity-once", 2, true],
  ["capacity-similar", 2, true],
  ["capacity-persistent", 3, false],
  ["capacity-tool", 1, false],
  ["capacity-output", 1, false],
  ["capacity-usage", 1, false],
  ["capacity-quota", 1, false],
] as const) {
  it(`bounds capacity recovery without replaying work: ${mode}`, async () => {
    const f = await fixture(mode);
    const events: HarnessEvent[] = [];
    try {
      const run = async () => {
        for await (const event of f.execution.run()) events.push(event);
      };
      if (success) {
        await run();
        expect(events.some((event) => event.type === "output.message")).toBe(true);
        const states = events.flatMap((event) =>
          event.type === "agent.updated" ? [event.agent.status] : [],
        );
        expect(states.slice(-3)).toEqual(["failed", "running", "completed"]);
        expect(
          events.some(
            (event) =>
              event.type === "progress.updated" &&
              event.progress.summary.includes("retrying request 1 of 2"),
          ),
        ).toBe(true);
      } else await expect(run()).rejects.toThrow();
      expect(await readFile(f.environment.resolvePath("capacity-starts.txt"), "utf8")).toBe(
        String(starts),
      );
    } finally {
      await f.cleanup();
    }
  });
}

it("cancels capacity backoff without starting another turn", async () => {
  const controller = new AbortController();
  const f = await fixture("capacity-persistent");
  try {
    await expect(
      (async () => {
        for await (const event of f.execution.run(controller.signal)) {
          if (event.type === "agent.updated" && event.agent.status === "failed")
            controller.abort(new Error("cancel capacity retry"));
        }
      })(),
    ).rejects.toThrow("cancel capacity retry");
    expect(await readFile(f.environment.resolvePath("capacity-starts.txt"), "utf8")).toBe("1");
  } finally {
    await f.cleanup();
  }
});

it("capacity backoff retains the original execution deadline", async () => {
  const f = await fixture(
    "capacity-persistent",
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    false,
    500,
  );
  try {
    await expect(
      (async () => {
        for await (const _event of f.execution.run()) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("timed out after 500ms");
    expect(
      Number(await readFile(f.environment.resolvePath("capacity-starts.txt"), "utf8")),
    ).toBeLessThan(3);
  } finally {
    await f.cleanup();
  }
});

it("skips advisory input when a late report leaves little completion headroom", async () => {
  const f = await fixture("budget-low-headroom", { maxAgents: 0, maxTokens: 100000 });
  try {
    const events: HarnessEvent[] = [];
    for await (const event of f.execution.run()) events.push(event);
    await expect(
      readFile(f.environment.resolvePath("budget-reminders.jsonl"), "utf8"),
    ).rejects.toThrow();
    expect(events.at(-1)).toEqual({ type: "output.message", text: "final answer", final: true });
  } finally {
    await f.cleanup();
  }
});
