import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { Codex, type ThreadItem } from "@openai/codex-sdk";

interface Bootstrap {
  target: string;
  token: string;
  executionId: string;
  generation: number;
  scenario: string;
  codexPath: string;
  timeoutSeconds?: number;
}

interface Identity {
  executionId: string;
  generation: number;
}

interface Offer {
  prompt: string;
  scenario: string;
  workspace: string;
  model: string;
  reasoningEffort: string;
  taskId?: string;
}

interface AdapterFrame {
  identity: Identity;
  hello?: { protocolVersion: number; language: string };
  ready?: Record<string, never>;
  started?: Record<string, never>;
  outcome?: {
    id: string;
    text: string;
    throughSequence: number;
    commit: string;
    nativeSessionId: string;
  };
  quiesced?: { lastSequence: number };
  closed?: Record<string, never>;
}

interface WorkerFrame {
  identity: Identity;
  body: string;
  welcome?: { protocolVersion: number };
  offer?: Offer;
  receipt?: { outcomeId: string; accepted: boolean };
}

interface HarnessEvent {
  identity: Identity;
  sequence: number;
  text: string;
  kind: string;
  payloadJson: string;
}

interface EventAck {
  throughSequence: number;
}

interface BridgeClient extends grpc.Client {
  attach(
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientDuplexStream<AdapterFrame, WorkerFrame>;
  publishEvents(
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientDuplexStream<HarnessEvent, EventAck>;
}

const execute = promisify(execFile);

async function bootstrap(): Promise<Bootstrap> {
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      const value = JSON.parse(line) as Bootstrap;
      if (
        typeof value.target !== "string" ||
        typeof value.token !== "string" ||
        typeof value.executionId !== "string" ||
        !Number.isSafeInteger(value.generation) ||
        typeof value.scenario !== "string" ||
        typeof value.codexPath !== "string" ||
        !isAbsolute(value.codexPath) ||
        (value.timeoutSeconds !== undefined &&
          (!Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds <= 0))
      ) {
        throw new Error("Invalid bootstrap");
      }
      return value;
    }
    throw new Error("Missing bootstrap");
  } finally {
    lines.close();
    process.stdin.destroy();
  }
}

function environment(keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function clip(text: string, limit = 16 * 1024): string {
  const bytes = Buffer.from(text);
  return bytes.length <= limit
    ? text
    : `${bytes.subarray(0, limit - 16).toString("utf8")}\n[truncated]`;
}

function payload(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= 96 * 1024) return serialized;
  return JSON.stringify({ truncated: true, preview: clip(serialized, 8 * 1024) });
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Producer did not stop")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(config: Bootstrap): Promise<void> {
  const definition = loadSync(fileURLToPath(new URL("./harness.proto", import.meta.url)), {
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(definition) as unknown as {
    supertag: {
      harness: {
        spike: {
          HarnessBridge: new (target: string, credentials: grpc.ChannelCredentials) => BridgeClient;
        };
      };
    };
  };
  const client = new descriptor.supertag.harness.spike.HarnessBridge(
    config.target,
    grpc.credentials.createInsecure(),
  );
  const identity = { executionId: config.executionId, generation: config.generation };
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${config.token}`);
  const timeoutMs = (config.timeoutSeconds ?? 600) * 1_000;
  const options = { deadline: Date.now() + timeoutMs };
  const control = client.attach(metadata, options);
  const controller = new AbortController();
  let events: grpc.ClientDuplexStream<HarnessEvent, EventAck> | undefined;
  let offer: Offer | undefined;
  let producer: Promise<void> | undefined;
  let pendingAck: { sequence: number; resolve: (accepted: boolean) => void } | undefined;
  let sequence = 0;
  let stopping = false;
  let cancelled = false;
  let quiesced = false;
  let closed = false;
  let cleaningUp = false;
  let outcomeSent = false;
  let receivedReceipt = false;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });

  function fail(): void {
    if (!cleaningUp) rejectFailure(new Error("Live Codex adapter failed"));
  }

  async function send(body: Omit<AdapterFrame, "identity">): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      control.write({ identity, ...body }, (error?: Error | null) => {
        if (error) reject(new Error("Control stream write failed"));
        else resolve();
      });
    });
  }

  async function publish(
    kind: string,
    text: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (stopping) return;
    if (!events || pendingAck) throw new Error("Invalid event stream state");
    sequence += 1;
    await new Promise<boolean>((resolve) => {
      pendingAck = { sequence, resolve };
      events?.write(
        { identity, sequence, kind, text: clip(text), payloadJson: payload(details) },
        (error?: Error | null) => {
          if (error) fail();
        },
      );
    });
  }

  async function publishItem(item: ThreadItem, stage: string): Promise<void> {
    switch (item.type) {
      case "agent_message":
        if (stage === "item.completed") {
          await publish("assistant", item.text, { id: item.id, stage, text: clip(item.text) });
        }
        break;
      case "command_execution":
        await publish("command", `${item.status}: ${clip(item.command, 2 * 1024)}`, {
          id: item.id,
          stage,
          command: clip(item.command, 8 * 1024),
          status: item.status,
          exitCode: item.exit_code,
          output: clip(item.aggregated_output, 64 * 1024),
        });
        break;
      case "file_change":
        if (stage === "item.completed") {
          await publish("file_change", `File changes ${item.status}`, {
            id: item.id,
            stage,
            status: item.status,
            changes: item.changes.slice(0, 128).map((change) => ({
              path: clip(change.path, 512),
              kind: change.kind,
            })),
            truncated: item.changes.length > 128,
          });
        }
        break;
      default:
        // Reasoning, MCP metadata, and provider errors never cross this boundary.
        break;
    }
  }

  async function produce(work: Offer): Promise<void> {
    const shellEnvironment = environment([
      "HOME",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
    ]);
    const nativeEnvironment = {
      ...shellEnvironment,
      ...environment(["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"]),
    };
    if (!nativeEnvironment.CODEX_HOME) throw new Error("Isolated Codex home required");
    const codex = new Codex({
      codexPathOverride: config.codexPath,
      env: nativeEnvironment,
      config: {
        agents: { enabled: false },
        features: {
          multi_agent: false,
          multi_agent_v2: false,
          enable_fanout: false,
          apps: false,
          enable_mcp_apps: false,
          plugins: false,
          plugin_sharing: false,
          skill_mcp_dependency_install: false,
          browser_use: false,
          browser_use_external: false,
          computer_use: false,
          in_app_browser: false,
        },
        shell_environment_policy: { inherit: "none", set: shellEnvironment },
      },
    });
    const thread = codex.startThread({
      model: work.model,
      modelReasoningEffort: "medium",
      workingDirectory: work.workspace,
      additionalDirectories: [join(work.workspace, ".git")],
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      networkAccessEnabled: false,
    });
    let completed = false;
    let finalResponse = "";
    try {
      const streamed = await thread.runStreamed(work.prompt, { signal: controller.signal });
      for await (const event of streamed.events) {
        // Drain the SDK iterator after abort so its native child closes before Quiesced.
        if (stopping) continue;
        if (event.type === "error" || event.type === "turn.failed") {
          throw new Error("Codex turn failed");
        }
        if (event.type === "turn.started" || event.type === "turn.completed") {
          completed = event.type === "turn.completed";
          await publish("status", event.type, { stage: event.type });
        } else if ("item" in event) {
          if (event.type === "item.completed" && event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }
          await publishItem(event.item, event.type);
        }
      }
      if (stopping) return;
      if (!completed || !finalResponse.trim() || !thread.id) {
        throw new Error("Codex turn ended without a final result");
      }
      const { stdout } = await execute("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: work.workspace,
        env: shellEnvironment,
        timeout: 10_000,
        maxBuffer: 4_096,
        signal: controller.signal,
      });
      if (stopping) return;
      const commit = stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid Git result");
      outcomeSent = true;
      await send({
        outcome: {
          id: "final",
          text: clip(finalResponse, 96 * 1024),
          throughSequence: sequence,
          commit,
          nativeSessionId: thread.id,
        },
      });
    } catch {
      if (!stopping) throw new Error("Codex execution failed");
    }
  }

  async function stopProducer(): Promise<void> {
    stopping = true;
    controller.abort();
    pendingAck?.resolve(false);
    pendingAck = undefined;
    if (producer) await bounded(producer, 10_000);
  }

  async function readControl(): Promise<void> {
    for await (const frame of control as AsyncIterable<WorkerFrame>) {
      if (
        frame.identity?.executionId !== identity.executionId ||
        frame.identity.generation !== identity.generation
      ) {
        throw new Error("Incorrect Worker identity");
      }
      switch (frame.body) {
        case "welcome":
          if (events || frame.welcome?.protocolVersion !== 1) {
            throw new Error("Invalid protocol negotiation");
          }
          events = client.publishEvents(metadata, options);
          events.on("error", fail);
          events.on("end", () => {
            if (!closed) fail();
          });
          events.on("data", (ack: EventAck) => {
            if (stopping || cleaningUp) return;
            if (!pendingAck || pendingAck.sequence !== ack.throughSequence) {
              fail();
              return;
            }
            const pending = pendingAck;
            pendingAck = undefined;
            pending.resolve(true);
          });
          break;
        case "offer":
          if (
            !events ||
            offer ||
            !frame.offer ||
            frame.offer.scenario !== config.scenario ||
            !isAbsolute(frame.offer.workspace) ||
            frame.offer.model !== "gpt-6.1-sol" ||
            frame.offer.reasoningEffort !== "medium"
          ) {
            throw new Error("Invalid Codex work offer");
          }
          offer = frame.offer;
          await send({ ready: {} });
          break;
        case "begin":
          if (!offer || producer || stopping) throw new Error("Unexpected Begin");
          await send({ started: {} });
          producer = produce(offer).catch(fail);
          break;
        case "receipt":
          if (
            !outcomeSent ||
            receivedReceipt ||
            frame.receipt?.outcomeId !== "final" ||
            (!frame.receipt.accepted && !cancelled)
          ) {
            throw new Error("Invalid outcome receipt");
          }
          receivedReceipt = true;
          break;
        case "cancel":
        case "quiesce":
          if (quiesced || (frame.body === "quiesce" && !outcomeSent)) {
            throw new Error("Unexpected quiescence request");
          }
          cancelled = frame.body === "cancel";
          await stopProducer();
          quiesced = true;
          await send({ quiesced: { lastSequence: sequence } });
          break;
        case "close":
          if (!quiesced || closed || (outcomeSent && !receivedReceipt)) {
            throw new Error("Unexpected Close");
          }
          await send({ closed: {} });
          closed = true;
          control.end();
          events?.end();
          break;
        default:
          throw new Error("Unknown Worker control message");
      }
    }
    if (!closed) throw new Error("Worker disconnected before shutdown");
  }

  const timer = setTimeout(fail, timeoutMs);
  process.once("SIGINT", fail);
  process.once("SIGTERM", fail);
  const controlReader = readControl();
  // The initial Hello write can fail before the outer race starts observing this reader.
  void controlReader.catch(() => undefined);
  try {
    await send({ hello: { protocolVersion: 1, language: "typescript" } });
    await Promise.race([controlReader, failure]);
  } finally {
    cleaningUp = true;
    clearTimeout(timer);
    process.off("SIGINT", fail);
    process.off("SIGTERM", fail);
    control.cancel();
    events?.cancel();
    client.close();
    await stopProducer();
    await controlReader.catch(() => undefined);
  }
}

try {
  await run(await bootstrap());
} catch {
  // SDK stderr and malformed bootstrap JSON may contain native credentials.
  process.stderr.write("Live TypeScript Codex adapter failed\n");
  process.exitCode = 1;
}
