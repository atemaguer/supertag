import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

interface Bootstrap {
  target: string;
  token: string;
  executionId: string;
  generation: number;
  scenario: string;
}

interface Identity {
  executionId: string;
  generation: number;
}

interface AdapterFrame {
  identity: Identity;
  hello?: { protocolVersion: number; language: string };
  ready?: Record<string, never>;
  started?: Record<string, never>;
  outcome?: { id: string; text: string; throughSequence: number };
  quiesced?: { lastSequence: number };
  closed?: Record<string, never>;
}

interface WorkerFrame {
  identity: Identity;
  body: string;
  welcome?: { protocolVersion: number };
  offer?: { prompt: string; scenario: string };
  receipt?: { outcomeId: string; accepted: boolean };
}

interface HarnessEvent {
  identity: Identity;
  sequence: number;
  text: string;
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
        typeof value.scenario !== "string"
      ) {
        throw new Error("Invalid bootstrap message");
      }
      return value;
    }
    throw new Error("Missing bootstrap message");
  } finally {
    lines.close();
    process.stdin.destroy();
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
  const identity = {
    executionId: config.executionId,
    generation: config.generation + (config.scenario === "stale-generation" ? 1 : 0),
  };
  const metadata = new grpc.Metadata();
  metadata.set(
    "authorization",
    `Bearer ${config.scenario === "bad-auth" ? "invalid-spike-token" : config.token}`,
  );
  const options = { deadline: Date.now() + 10_000 };
  const control = client.attach(metadata, options);
  let events: grpc.ClientDuplexStream<HarnessEvent, EventAck> | undefined;
  let lastSequence = 0;
  let prompt = "";
  let stopping = false;
  let finished = false;
  let receivedOutcome = false;
  let closedSent = false;
  let pendingAck: { sequence: number; resolve: () => void } | undefined;
  const expectedErrors = new Map([
    ["bad-auth", grpc.status.UNAUTHENTICATED],
    ["bad-version", grpc.status.FAILED_PRECONDITION],
    ["stale-generation", grpc.status.FAILED_PRECONDITION],
    ["bad-sequence", grpc.status.INVALID_ARGUMENT],
  ]);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Adapter deadline exceeded")), 10_000);

    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      stopping = true;
      clearTimeout(timeout);
      pendingAck?.resolve();
      pendingAck = undefined;
      control.cancel();
      events?.cancel();
      client.close();
      if (error) reject(error);
      else resolve();
    }

    function onError(error: grpc.ServiceError): void {
      if (finished) return;
      if (expectedErrors.get(config.scenario) === error.code) {
        process.stdout.write(`EXPECTED_ERROR typescript ${config.scenario} ${error.code}\n`);
        finish();
      } else {
        finish(new Error(`Unexpected gRPC status ${error.code}`));
      }
    }

    function send(body: Omit<AdapterFrame, "identity">): void {
      control.write({ identity, ...body });
    }

    function quiesce(cancelled: boolean): void {
      if (stopping) return;
      stopping = true;
      pendingAck?.resolve();
      pendingAck = undefined;
      if (cancelled && config.scenario === "cancel-late-outcome") {
        send({
          outcome: {
            id: "final",
            text: `[typescript] ${prompt} complete.`,
            throughSequence: lastSequence,
          },
        });
      }
      send({ quiesced: { lastSequence } });
    }

    async function produce(): Promise<void> {
      if (!events) throw new Error("Missing event channel");
      for (const text of ["[typescript] ", prompt, " complete."]) {
        if (stopping) return;
        lastSequence += 1;
        const sequence = config.scenario === "bad-sequence" ? 2 : lastSequence;
        await new Promise<void>((acknowledge) => {
          pendingAck = { sequence, resolve: acknowledge };
          events?.write({ identity, sequence, text });
        });
        if (stopping) return;
        if (config.scenario === "crash") process.exit(17);
        // Deliberate pacing makes control responsiveness observable during streaming.
        await delay(15);
      }
      if (!stopping) {
        send({
          outcome: {
            id: "final",
            text: `[typescript] ${prompt} complete.`,
            throughSequence: lastSequence,
          },
        });
      }
    }

    function onControl(frame: WorkerFrame): void {
      if (finished) return;
      if (
        frame.identity.executionId !== config.executionId ||
        frame.identity.generation !== config.generation
      ) {
        throw new Error("Worker frame has incorrect identity");
      }
      switch (frame.body) {
        case "welcome": {
          if (frame.welcome?.protocolVersion !== 1) throw new Error("Unsupported Worker protocol");
          events = client.publishEvents(metadata, options);
          events.on("error", onError);
          events.on("data", (ack: EventAck) => {
            if (finished || stopping) return;
            if (!pendingAck || ack.throughSequence !== pendingAck.sequence) {
              finish(new Error("Unexpected event acknowledgement"));
              return;
            }
            const pending = pendingAck;
            pendingAck = undefined;
            pending.resolve();
          });
          break;
        }
        case "offer":
          if (!frame.offer || frame.offer.scenario !== config.scenario) {
            throw new Error("Incorrect run offer");
          }
          prompt = frame.offer.prompt;
          send({ ready: {} });
          break;
        case "begin":
          send({ started: {} });
          void produce().catch((error: Error) => finish(error));
          break;
        case "cancel":
          quiesce(true);
          break;
        case "quiesce":
          quiesce(false);
          break;
        case "receipt":
          if (
            frame.receipt?.outcomeId !== "final" ||
            frame.receipt.accepted !== (config.scenario !== "cancel-late-outcome")
          ) {
            throw new Error("Unexpected outcome receipt");
          }
          receivedOutcome = true;
          break;
        case "close":
          if (!stopping) throw new Error("Worker closed before quiescence");
          if (config.scenario !== "cancel" && !receivedOutcome) {
            throw new Error("Worker closed before outcome receipt");
          }
          send({ closed: {} });
          closedSent = true;
          control.end();
          events?.end();
          break;
        default:
          throw new Error(`Unknown Worker message ${frame.body}`);
      }
    }

    control.on("data", (frame: WorkerFrame) => {
      try {
        onControl(frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid Worker message"));
      }
    });
    control.on("error", onError);
    control.on("end", () => {
      if (!closedSent && !finished)
        finish(new Error("Worker stream ended before close acknowledgement"));
      else finish();
    });
    // Authentication must reject invalid metadata before any request body is sent.
    if (config.scenario !== "bad-auth") {
      send({
        hello: {
          protocolVersion: config.scenario === "bad-version" ? 99 : 1,
          language: "typescript",
        },
      });
    }
  });
}

try {
  await run(await bootstrap());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Adapter failed"}\n`);
  process.exitCode = 1;
}
