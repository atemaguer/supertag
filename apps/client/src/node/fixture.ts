/**
 * Disposable SuperTag deployments for the Gateway backend's integration tests, run by the CLI
 * built from this repository (`SUPERTAG_RUST_TEST_CLI`): a Control Plane on its own SQLite
 * database and, in front of it, a Gateway with a native listener and a WebSocket tunnel
 * listener, as `supertag up` runs them. Every state and home directory is a throwaway one, and
 * every port is picked by the system, so nothing touches `~/.supertag` or a running deployment.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { connect as tcpConnect } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { promisify } from "node:util";
import { HarnessKind } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import { createGatewayClient } from "./sdk";

export const CLI = process.env["SUPERTAG_RUST_TEST_CLI"];
const execute = promisify(execFile);

/** What every service and CLI run of a test sees: no inherited SuperTag settings. */
export function baseEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home };
}

/** Waits until `done` holds, within `ms`. */
export async function eventually(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await delay(20);
  }
}

/** Runs the CLI once and returns its standard output. */
export async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execute(CLI as string, args, { env, timeout: 30_000 });
  return stdout;
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(5000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/** Starts a service and reads the `count` addresses it reports, in order. */
async function service(
  args: string[],
  env: NodeJS.ProcessEnv,
  count: number,
): Promise<{ child: ChildProcess; addresses: string[] }> {
  const child = spawn(CLI as string, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })[
    Symbol.asyncIterator
  ]();
  const addresses: string[] = [];
  try {
    while (addresses.length < count) {
      const next = await Promise.race([
        lines.next(),
        delay(20_000, undefined, { ref: false }).then(() => {
          throw new Error(`${args[0]} did not report its addresses: ${stderr}`);
        }),
      ]);
      if (next.done) throw new Error(`${args[0]} exited: ${stderr}`);
      if (!/^127\.0\.0\.1:[1-9][0-9]*$/u.test(next.value)) continue;
      addresses.push(next.value);
    }
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { child, addresses };
}

export interface StackOptions {
  /** A throwaway directory for the database and the services' home. */
  readonly root: string;
  readonly name: string;
  /** The operator token the Control Plane accepts. */
  readonly token: string;
  /** TLS for the Gateway's own listeners, natively and inside its tunnel. */
  readonly tls?: { cert: string; key: string };
  /** The Control Plane's database; a SQLite file under `root` by default. */
  readonly databaseUrl?: string;
}

/** One disposable deployment: a Control Plane on its own database, and its Gateway. */
export class Stack {
  private controlPlane: ChildProcess | undefined;
  private gateway: ChildProcess | undefined;
  private controlPlaneUrl = "";
  /** The Gateway's native address and its tunnel listener's address. */
  native = "";
  tunnel = "";
  private readonly hostToken = `stcr_${randomBytes(32).toString("hex")}`;
  private readonly gatewayCredential = `stcr_${randomBytes(32).toString("hex")}`;

  private constructor(readonly options: StackOptions) {}

  static async start(options: StackOptions): Promise<Stack> {
    const stack = new Stack(options);
    await stack.startControlPlane();
    await stack.startGateway();
    return stack;
  }

  /** The Gateway's native URL. */
  get url(): string {
    return `${this.options.tls ? "https" : "http"}://${this.native}`;
  }

  /** The Gateway's tunnel URL, with a path. */
  get tunnelUrl(): string {
    return `ws://${this.tunnel}/supertag`;
  }

  private env(): NodeJS.ProcessEnv {
    return baseEnv(this.options.root);
  }

  async startControlPlane() {
    const database = path.join(this.options.root, `${this.options.name}.sqlite`);
    const { child, addresses } = await service(
      ["control-plane"],
      {
        ...this.env(),
        SUPERTAG_DATABASE_URL: this.options.databaseUrl ?? `sqlite://${database}?mode=rwc`,
        SUPERTAG_OPERATOR_TOKEN: this.options.token,
        SUPERTAG_BOOTSTRAP_HOST_TOKEN: this.hostToken,
        SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL: this.gatewayCredential,
      },
      1,
    );
    this.controlPlane = child;
    this.controlPlaneUrl = `http://${addresses[0]}`;
  }

  /** Starts the Gateway; after the first start, at its earlier addresses, as a restart does. */
  async startGateway() {
    const listen = this.native === "" ? "127.0.0.1:0" : this.native;
    const websocket = this.tunnel === "" ? "127.0.0.1:0" : this.tunnel;
    const env = {
      ...this.env(),
      SUPERTAG_GATEWAY_CREDENTIAL: this.gatewayCredential,
      ...(this.options.tls
        ? {
            SUPERTAG_TLS_CERT_FILE: this.options.tls.cert,
            SUPERTAG_TLS_KEY_FILE: this.options.tls.key,
          }
        : {}),
    };
    const args = [
      "gateway",
      "--control-plane",
      this.controlPlaneUrl,
      "--listen",
      listen,
      "--websocket-listen",
      websocket,
    ];
    // A just-stopped listener may hold its port for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        const { child, addresses } = await service(args, env, 2);
        this.gateway = child;
        [this.native, this.tunnel] = addresses as [string, string];
        return;
      } catch (error) {
        if (attempt >= 30) throw error;
        await delay(200);
      }
    }
  }

  async stopGateway() {
    if (this.gateway) await stopChild(this.gateway);
    this.gateway = undefined;
  }

  /** Stops both services, as a machine restart would. */
  async stop() {
    await this.stopGateway();
    if (this.controlPlane) await stopChild(this.controlPlane);
    this.controlPlane = undefined;
  }

  /** Restarts both on the same database, with the Gateway at its earlier addresses. */
  async restart() {
    await this.stop();
    await this.startControlPlane();
    await this.startGateway();
  }

  /** An operator client of the Gateway, for setup the app does not do itself. */
  operator(ca?: Buffer) {
    return createGatewayClient({
      url: this.url,
      token: this.options.token,
      ...(ca === undefined ? {} : { ca }),
    });
  }

  /** Creates a Tag on Codex, by default the lead, as `supertag init` would. */
  async putTag(tagId: string, ca?: Buffer, lead = true) {
    const client = this.operator(ca);
    try {
      await client.operator.putTag(
        {
          tagId,
          instructions: "Help with engineering",
          allowedActions: ["files:read"],
          harnessKind: HarnessKind.CODEX,
          lead,
        },
        { timeoutMs: 10_000 },
      );
    } finally {
      client.close();
    }
  }
}

/** A private certificate authority and a server certificate for 127.0.0.1, by openssl. */
export async function privateCertificates(
  directory: string,
): Promise<{ ca: Buffer; cert: string; key: string } | undefined> {
  const openssl = (args: string[]) => execute("openssl", args, { cwd: directory, timeout: 30_000 });
  try {
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-subj",
      "/CN=SuperTag desktop test CA",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=127.0.0.1",
    ]);
    await writeFile(
      path.join(directory, "server.ext"),
      "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
    );
    await openssl([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "2",
      "-extfile",
      "server.ext",
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return {
    ca: await readFile(path.join(directory, "ca.pem")),
    cert: path.join(directory, "server.pem"),
    key: path.join(directory, "server.key"),
  };
}

/**
 * A platform-style edge in front of a tunnel listener: it terminates the outer `wss://` TLS and
 * forwards the plain WebSocket connection, so the Gateway's own TLS runs inside the tunnel.
 */
export async function tlsEdge(
  certificates: { cert: string; key: string },
  target: number,
): Promise<TlsServer> {
  const server = createTlsServer(
    {
      cert: await readFile(certificates.cert),
      key: await readFile(certificates.key),
      ALPNProtocols: ["http/1.1"],
    },
    (socket) => {
      const upstream = tcpConnect({ host: "127.0.0.1", port: target });
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

/**
 * Holds the supervisor lock of a local state directory, as `supertag up` does while its services
 * run: an exclusive `flock` held by a child process until `release`.
 */
export async function holdLock(file: string): Promise<{ release(): Promise<void> }> {
  const child = spawn(
    "perl",
    [
      "-e",
      'use Fcntl qw(:flock); open(my $f, "<", $ARGV[0]) or die $!; flock($f, LOCK_EX|LOCK_NB) or die "busy"; $| = 1; print "locked\\n"; <STDIN>;',
      file,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })[
    Symbol.asyncIterator
  ]();
  const first = await lines.next();
  if (first.value !== "locked") throw new Error("could not hold the state lock");
  return {
    async release() {
      child.stdin?.end();
      await stopChild(child);
    },
  };
}

/** The next value `received` collects that matches, within `ms`. */
export async function next<T>(
  received: T[],
  matches: (value: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const index = received.findIndex(matches);
    if (index >= 0) return received.splice(0, index + 1)[index] as T;
    if (Date.now() > deadline) throw new Error(`timed out; received ${JSON.stringify(received)}`);
    await delay(20);
  }
}
