import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { E2BExecutionEnvironmentProvider } from "../packages/runtime/environments/e2b/src/index.js";
import { ModalExecutionEnvironmentProvider } from "../packages/runtime/environments/modal/src/index.js";
import type { EnvironmentPlan, ExecutionEnvironment } from "../packages/runtime/sdk/src/index.js";
import { repositoryAttempt } from "../tests/support/repository-execution.js";

const { values } = parseArgs({
  options: {
    backend: { type: "string" },
    output: { type: "string" },
    live: { type: "boolean" },
    network: { type: "string" },
  },
});
if (!values.live)
  throw new Error("Pass --live to authorize creation of short-lived cloud sandboxes");
const directory = resolve(values.output ?? `.supertag/sandbox-conformance/${Date.now()}`);
await mkdir(directory, { recursive: true });
const provider =
  values.backend === "modal"
    ? new ModalExecutionEnvironmentProvider({
        appName: "supertag-conformance",
        createAppIfMissing: true,
        sandboxTimeoutMs: 120000,
        cpu: 0.25,
        memoryMiB: 256,
      })
    : values.backend === "e2b"
      ? new E2BExecutionEnvironmentProvider({ sandboxTimeoutMs: 120000 })
      : undefined;
if (!provider) throw new Error("Select modal or e2b");
const plan: EnvironmentPlan = {
  files: [{ path: "input.txt", content: "SuperTag sandbox conformance", mode: 0o600 }],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network:
    values.network === "allowlist"
      ? { mode: "allowlist", allowedHosts: ["api.openai.com"] }
      : values.network === "unrestricted"
        ? { mode: "unrestricted" }
        : { mode: "none" },
};
const task = repositoryAttempt(`cloud-${Date.now()}`);
const profile = {
  ref: task.workerProfile,
  workerType: "conformance",
  harness: { provider: "deterministic" },
  execution: { provider: provider.id, lifetime: { scope: "attempt" as const } },
};
let environment: ExecutionEnvironment | undefined;
const started = Date.now();
try {
  environment = await provider.provision({ task, profile, plan });
  await writeFile(
    resolve(directory, "resource.json"),
    JSON.stringify({ environmentId: environment.id, createdAt: new Date().toISOString() }),
  );
  await environment.prepare(plan);
  if ((await environment.read("input.txt")) !== "SuperTag sandbox conformance")
    throw new Error("File staging failed");
  if (values.network === "allowlist" || values.network === "unrestricted") {
    const probe = await environment.spawn({
      command: "python3",
      timeoutMs: 20000,
      args: [
        "-c",
        String.raw`import urllib.request,urllib.error,socket,ssl

def reachable(url):
    try:
        urllib.request.urlopen(url,timeout=3).close()
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False

positive=reachable('https://api.openai.com/v1/models')
negative=not reachable('https://example.com')
plain=not reachable('http://api.openai.com')
raw=True
try:
    s=socket.create_connection(('1.1.1.1',443),timeout=3)
    context=ssl.create_default_context();context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
    with context.wrap_socket(s) as tls:
        tls.sendall(b'GET / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n')
        raw=not bool(tls.recv(1024))
except Exception:
    pass
print({'allowed_tls':positive,'denied_other_host':negative,'denied_plaintext':plain,'denied_raw_ip_tls':raw})
assert positive
assert (negative and plain and raw) if ${values.network === "allowlist" ? "True" : "False"} else (not negative and not plain and not raw)
`,
      ],
    });
    const result = await probe.wait();
    if (result.exitCode !== 0)
      throw new Error(`Allowlist verification failed: ${result.stdout} ${result.stderr}`);
    await writeFile(
      resolve(directory, "allowlist.json"),
      JSON.stringify({ passed: true, checks: result.stdout }),
    );
  }
  const process = await environment.spawn({
    command: "python3",
    args: [
      "-c",
      values.network === "allowlist" || values.network === "unrestricted"
        ? "import sys; print('STREAM:✓',flush=True); print('ERR:✓',file=sys.stderr,flush=True); open('output.bin','wb').write(bytes([0,255,128,10]))"
        : "import sys,socket; print('STREAM:✓',flush=True); print('ERR:✓',file=sys.stderr,flush=True); open('output.bin','wb').write(bytes([0,255,128,10])); s=socket.socket(); s.settimeout(2); r=s.connect_ex(('1.1.1.1',443)); print('NETWORK_BLOCKED:'+str(r!=0)); sys.exit(0 if r!=0 else 1)",
    ],
    streamOutput: true,
    timeoutMs: 10000,
  });
  const chunks = [];
  if (!process.output) throw new Error("Streaming unavailable");
  for await (const chunk of process.output) chunks.push(chunk);
  const result = await process.wait();
  if (result.exitCode !== 0) throw new Error("Process or network restriction verification failed");
  const bytes = await environment.readBytes?.("output.bin");
  if (!bytes || Buffer.from(bytes).toString("hex") !== "00ff800a")
    throw new Error("Binary artifact read failed");
  const controller = new AbortController();
  const stubborn = await environment.spawn(
    {
      command: "python3",
      args: [
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(90)",
      ],
      timeoutMs: 100000,
    },
    controller.signal,
  );
  const cancelAt = Date.now();
  controller.abort(new Error("Conformance cancellation"));
  let cancellationConfirmed = false;
  try {
    await stubborn.wait();
  } catch {
    cancellationConfirmed = true;
  }
  if (!cancellationConfirmed) throw new Error("Cancellation did not interrupt the command");
  await environment.dispose("cancelled");
  const report = {
    backend: provider.id,
    environmentId: environment.id,
    streaming: chunks,
    binaryRoundTrip: true,
    networkPolicy: plan.network,
    networkVerified: true,
    cancellationConfirmed,
    cancellationMs: Date.now() - cancelAt,
    terminated: true,
    elapsedMs: Date.now() - started,
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  processOutput(JSON.stringify(report, null, 2));
} finally {
  await environment?.dispose("failed");
}
function processOutput(text: string) {
  globalThis.process.stdout.write(`${text}\n`);
}
