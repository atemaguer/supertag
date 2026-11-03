import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorker,
  type ExecutionEnvironmentProvider,
  type Harness,
  LocalHarnessExecutionControl,
  type TaskAttemptEvent,
} from "../../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "./file-artifact-store.js";
import { repositoryAttempt } from "./repository-execution.js";

/** Exercises a server-backed interactive Harness without any model or provider credentials. */
export async function runServerHarnessConformance(
  provider: ExecutionEnvironmentProvider,
  directory: string,
) {
  await mkdir(directory, { recursive: true });
  const spec = repositoryAttempt(`server-${Date.now()}`);
  const artifactStore = new FileArtifactStore(join(directory, "artifacts"));
  const controls = { version: 1 as const, operations: ["reply" as const] };
  const harness: Harness = {
    id: "server-fixture",
    async describe() {
      return {
        sessions: { resume: false, export: false, scope: "none" as const },
        id: this.id,
        version: "1",
        inputKinds: ["instruction", "history"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
        control: controls,
      };
    },
    async plan() {
      return {
        runtime: {
          files: [
            {
              path: "server.py",
              content: `import http.server,json,pathlib
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        result=json.dumps({'answer':data['value']*2}).encode()
        pathlib.Path('result.json').write_bytes(result)
        self.send_response(200);self.send_header('Content-Length',str(len(result)));self.end_headers();self.wfile.write(result)
    def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
pathlib.Path('port.txt').write_text(str(server.server_port))
server.serve_forever()
`,
            },
          ],
          mounts: [],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" },
        },
        execution: {
          files: [],
          mounts: [],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" },
        },
        outputs: [{ path: "result.json", mediaType: "application/json" }],
      };
    },
    async resolve({ environments }) {
      const environment = environments.runtime;
      if (!environment.guarantees?.scopedHttp || !environment.connect)
        throw new Error("Server Harness requires scoped HTTP");
      return {
        capabilities: await this.describe(),
        runtime: { name: "python-http-fixture", source: "configured" },
      };
    },
    async start(_plan, environments) {
      const environment = environments.runtime;
      const process = await environment.spawn({
        command: "python3",
        args: ["server.py"],
        cwd: environment.rootDirectory,
        timeoutMs: 30000,
      });
      let port: number | undefined;
      for (let i = 0; i < 100; i++) {
        const text = await environment.read("port.txt").catch(() => "");
        if (text) {
          port = Number(text);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!port || !environment.connect) throw new Error("Server did not become ready");
      const connection = await environment.connect(process, {
        port,
        timeoutMs: 5000,
        maxResponseBytes: 4096,
      });
      let complete: (value: string) => void = () => {};
      const output = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const control = new LocalHarnessExecutionControl({
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        capabilities: controls,
        async dispatch(command, signal) {
          if (command.type !== "reply") return { status: "rejected" };
          const response = await connection.request(
            {
              method: "POST",
              path: "/answer",
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify(command.response)),
            },
            signal,
          );
          if (response.status !== 200) throw new Error("Server rejected reply");
          complete(new TextDecoder().decode(response.body));
          return { status: "accepted" };
        },
      });
      control.registerRequest("number");
      return {
        control,
        async *run(signal) {
          signal?.throwIfAborted();
          yield {
            type: "approval.requested" as const,
            request: { id: "number", description: "Supply the fixture number" },
          };
          yield { type: "output.message" as const, text: await output };
        },
        async close() {
          await control.close();
          await connection.close();
        },
      };
    },
  };
  const worker = createWorker({
    id: "server-worker",
    profiles: [
      {
        ref: spec.workerProfile,
        workerType: "fixture",
        harness: { provider: harness.id },
        execution: { provider: provider.id, lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [provider],
    artifactStore,
  });
  const events: TaskAttemptEvent[] = [];
  for await (const event of worker.execute(spec)) {
    events.push(event);
    if (event.type === "approval.requested") {
      const command = {
        id: "answer-1",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        type: "reply" as const,
        requestId: "number",
        response: { value: 21 },
      };
      const first = await worker.control?.(command),
        duplicate = await worker.control?.(command);
      if (first?.status !== "accepted" || JSON.stringify(first) !== JSON.stringify(duplicate))
        throw new Error("Control acknowledgement did not replay");
    }
  }
  if (events.at(-1)?.type !== "execution.completed")
    throw new Error(`Server Harness failed: ${JSON.stringify(events.at(-1))}`);
  const artifact = events.find((event) => event.type === "artifact.created");
  if (artifact?.type !== "artifact.created") throw new Error("Missing exported server artifact");
  const bytes = await artifactStore.get(artifact.artifact);
  if (JSON.parse(new TextDecoder().decode(bytes)).answer !== 42)
    throw new Error("Independent server artifact verification failed");
  const report = {
    executionEnvironment: provider.id,
    interactiveReply: true,
    duplicateAcknowledgement: true,
    artifact: artifact.artifact,
    verifiedAnswer: 42,
    completed: true,
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
