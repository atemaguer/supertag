/**
 * A long-lived process server in a sandbox, so a file or command tool costs one line each way
 * instead of a new runtime exec (35 to 280 ms each on a local container runtime).
 *
 * The provider starts `EXEC_SERVER_PROGRAM` once, as the Workspace user, over one exec whose
 * standard input and output carry newline-delimited JSON. The server holds no power the Task
 * lacks: it runs as the same user, the seal stops it like any Task process, and what it returns
 * is as untrusted as the Task's own output (the Worker Host trusts nothing a sandbox returns).
 * When it is gone, the provider starts another on the next operation, or falls back to one exec
 * per operation.
 *
 * Requests (provider to server):
 * - `{"op":"spawn","id":N,"argv":[...],"cwd":P,"env":{...},"replace":B,"stdin":B64|null,"stream":B}`
 * - `{"op":"input","id":N,"data":B64}`, `{"op":"eof","id":N}`, `{"op":"kill","id":N}`
 *
 * Replies: `{"ready":true}` once, then `{"id":N,"pid":P}`, `{"id":N,"out":B64}`,
 * `{"id":N,"err":B64}`, `{"id":N,"exit":CODE}`, or `{"id":N,"error":TEXT}`. A process a signal
 * ended exits 128 plus the signal, as a runtime exec reports it.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const EXEC_SERVER_PROGRAM = String.raw`import base64, json, os, queue, signal, subprocess, sys, threading
lock = threading.Lock()
procs = {}

def emit(value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    with lock:
        view = memoryview(data)
        while view:
            view = view[os.write(1, view):]

def pump(ident, stream, name):
    while chunk := os.read(stream.fileno(), 65536):
        emit({"id": ident, name: base64.b64encode(chunk).decode()})

def feed(proc, inputs):
    try:
        while (data := inputs.get()) is not None:
            proc.stdin.write(data)
            proc.stdin.flush()
    except OSError:
        pass
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass

def watch(ident, proc, pumps):
    code = proc.wait()
    for thread in pumps:
        thread.join()
    procs.pop(ident, None)
    emit({"id": ident, "exit": code if code >= 0 else 128 - code})

def spawn(request):
    ident = request["id"]
    env = request["env"] if request.get("replace") else {**os.environ, **request["env"]}
    try:
        proc = subprocess.Popen(request["argv"], cwd=request.get("cwd") or "/tmp", env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
    except (OSError, ValueError) as error:
        # As a runtime exec reports a command it cannot run: 127 when missing, else 126.
        message = "%s: %s\n" % (request["argv"][0] if request["argv"] else "", getattr(error, "strerror", None) or error)
        emit({"id": ident, "pid": None})
        emit({"id": ident, "err": base64.b64encode(message.encode()).decode()})
        emit({"id": ident, "exit": 127 if isinstance(error, FileNotFoundError) else 126})
        return
    inputs = queue.Queue()
    procs[ident] = (proc, inputs)
    threading.Thread(target=feed, args=(proc, inputs), daemon=True).start()
    if request.get("stdin") is not None:
        inputs.put(base64.b64decode(request["stdin"]))
        inputs.put(None)
    elif not request.get("stream"):
        inputs.put(None)
    pumps = [threading.Thread(target=pump, args=(ident, proc.stdout, "out"), daemon=True),
             threading.Thread(target=pump, args=(ident, proc.stderr, "err"), daemon=True)]
    for thread in pumps:
        thread.start()
    emit({"id": ident, "pid": proc.pid})
    threading.Thread(target=watch, args=(ident, proc, pumps), daemon=True).start()

emit({"ready": True})
for line in sys.stdin.buffer:
    try:
        request = json.loads(line)
        op, ident = request["op"], request["id"]
    except (ValueError, KeyError, TypeError):
        continue
    if op == "spawn":
        spawn(request)
        continue
    entry = procs.get(ident)
    if entry is None:
        continue
    proc, inputs = entry
    if op == "input":
        inputs.put(base64.b64decode(request["data"]))
    elif op == "eof":
        inputs.put(None)
    elif op == "kill":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
# The provider went away: no process it started outlives the server.
for proc, _ in list(procs.values()):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass`;

/** How long a new server may take to say it is ready. */
const READY_MS = 10_000;
/** A reply line this long is not one the server sends. */
const MAX_LINE = 1 << 20;

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly replaceEnvironment?: boolean;
  readonly stdin?: Uint8Array;
  /** Keep standard input open for `write`; otherwise it ends after `stdin`. */
  readonly streamInput?: boolean;
}

export interface ExecProcess {
  readonly pid?: number;
  write(bytes: Uint8Array): Promise<void>;
  endInput(): void;
  kill(): void;
  /** The exit code, or null when the server went away first. */
  readonly exited: Promise<number | null>;
}

interface Pending {
  started: (pid: number | undefined) => void;
  failed: (error: Error) => void;
  exited: (code: number | null) => void;
  output: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
}

/**
 * The provider's side. `open` starts the server process (one exec as the Workspace user); a
 * server that cannot start, or stops, makes `spawn` resolve undefined until a later call starts
 * another, so the caller falls back to an exec of its own.
 */
export function createExecServer(open: () => ChildProcessWithoutNullStreams) {
  let server:
    | {
        readonly child: ChildProcessWithoutNullStreams;
        readonly ready: Promise<boolean>;
        alive: boolean;
      }
    | undefined;
  const pending = new Map<number, Pending>();
  let next = 0;
  let closed = false;

  function start() {
    const child = open();
    let buffer = "";
    let markReady: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      markReady = resolve;
    });
    const timer = setTimeout(() => markReady(false), READY_MS);
    const current = { child, ready, alive: true };
    const gone = () => {
      if (!current.alive) return;
      current.alive = false;
      clearTimeout(timer);
      markReady(false);
      if (server === current) server = undefined;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.failed(new Error("Exec server stopped"));
        waiter.exited(null);
      }
    };
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      buffer += text;
      if (buffer.length > MAX_LINE) {
        child.kill("SIGKILL");
        gone();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (reply["ready"] === true) {
          clearTimeout(timer);
          markReady(true);
          continue;
        }
        const id = reply["id"];
        const waiter = typeof id === "number" ? pending.get(id) : undefined;
        if (!waiter) continue;
        if ("pid" in reply)
          waiter.started(typeof reply["pid"] === "number" ? reply["pid"] : undefined);
        else if (typeof reply["error"] === "string") {
          pending.delete(id as number);
          waiter.failed(new Error(reply["error"]));
        } else if (typeof reply["out"] === "string")
          waiter.output("stdout", Buffer.from(reply["out"], "base64"));
        else if (typeof reply["err"] === "string")
          waiter.output("stderr", Buffer.from(reply["err"], "base64"));
        else if ("exit" in reply) {
          pending.delete(id as number);
          waiter.exited(typeof reply["exit"] === "number" ? reply["exit"] : null);
        }
      }
    });
    child.once("close", gone);
    child.once("error", gone);
    return current;
  }

  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (!server?.alive) {
        reject(new Error("Exec server stopped"));
        return;
      }
      server.child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });

  return {
    /**
     * Starts `request` through the server, or resolves undefined when no server runs, so the
     * caller starts it itself.
     */
    async spawn(
      request: ExecRequest,
      output: (stream: "stdout" | "stderr", bytes: Uint8Array) => void,
    ): Promise<ExecProcess | undefined> {
      // A server found gone on the way gets one replacement before the caller falls back.
      return (await this.once(request, output)) ?? this.once(request, output);
    },
    /** One try at `spawn`, on the running server or a new one. */
    async once(
      request: ExecRequest,
      output: (stream: "stdout" | "stderr", bytes: Uint8Array) => void,
    ): Promise<ExecProcess | undefined> {
      if (closed) return undefined;
      if (!server?.alive) server = start();
      const current = server;
      if (!(await current.ready) || !current.alive) {
        current.child.kill("SIGKILL");
        return undefined;
      }
      next += 1;
      const id = next;
      let exited: (code: number | null) => void = () => {};
      const exit = new Promise<number | null>((resolve) => {
        exited = resolve;
      });
      const started = new Promise<number | undefined>((resolve, reject) => {
        pending.set(id, { started: resolve, failed: reject, exited, output });
      });
      try {
        await send({
          op: "spawn",
          id,
          argv: request.argv,
          cwd: request.cwd ?? "/tmp",
          env: { ...request.environment },
          replace: request.replaceEnvironment === true,
          stdin: request.stdin === undefined ? null : Buffer.from(request.stdin).toString("base64"),
          stream: request.streamInput === true,
        });
        const pid = await started;
        return {
          ...(pid === undefined ? {} : { pid }),
          write: (bytes) => send({ op: "input", id, data: Buffer.from(bytes).toString("base64") }),
          endInput: () => void send({ op: "eof", id }).catch(() => undefined),
          kill: () => void send({ op: "kill", id }).catch(() => undefined),
          exited: exit,
        };
      } catch {
        pending.delete(id);
        // The server stopped, or its input broke, before the process started: it is gone, and
        // a later call starts another.
        current.alive = false;
        if (server === current) server = undefined;
        current.child.kill("SIGKILL");
        return undefined;
      }
    },
    /** Stops the server; its processes stop with it. */
    close() {
      closed = true;
      server?.child.stdin.end();
      server?.child.kill("SIGKILL");
      server = undefined;
    },
  };
}

export type ExecServer = ReturnType<typeof createExecServer>;
