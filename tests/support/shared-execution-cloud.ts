import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(repositoryRoot, "tests/fixtures/shared-execution-worker.ts");

export interface SharedExecutionHealth {
  readonly environmentId: string;
  readonly incarnationId: string;
  readonly activeProcesses: number;
  readonly maximumConcurrentProcesses: number;
}

interface WorkerEvent {
  readonly type: string;
  readonly message?: { readonly text: string };
  readonly error?: { readonly message: string };
}

export async function waitForSharedExecution(baseUrl: string): Promise<SharedExecutionHealth> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return (await response.json()) as SharedExecutionHealth;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Shared execution service did not become ready: ${String(lastError)}`);
}

export async function runSharedExecutionWorker(
  baseUrl: string,
  adminToken: string,
  mode: string,
  attemptId: string,
): Promise<readonly WorkerEvent[]> {
  const result = await execute(
    "pnpm",
    ["exec", "tsx", "--conditions=development", fixturePath, mode, attemptId],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SUPERTAG_SHARED_EXECUTION_URL: baseUrl,
        SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return (JSON.parse(result.stdout) as { events: WorkerEvent[] }).events;
}

export async function runSharedExecutionCloudScenario(baseUrl: string, adminToken: string) {
  const writer = await runSharedExecutionWorker(baseUrl, adminToken, "writer", "cloud-writer");
  assertMessage(writer, "wrote pooled.txt");
  const reader = await runSharedExecutionWorker(baseUrl, adminToken, "reader", "cloud-reader");
  assertMessage(reader, "worker-a");

  const [cancelled, survivor] = await Promise.all([
    runSharedExecutionWorker(baseUrl, adminToken, "cancelled", "cloud-cancelled"),
    runSharedExecutionWorker(baseUrl, adminToken, "survivor", "cloud-survivor"),
  ]);
  if (cancelled.at(-1)?.type !== "execution.failed")
    throw new Error(`Cancelled Worker did not fail: ${JSON.stringify(cancelled)}`);
  assertMessage(survivor, "survived");
  const observed = await runSharedExecutionWorker(
    baseUrl,
    adminToken,
    "survivor-reader",
    "cloud-survivor-reader",
  );
  assertMessage(observed, "worker-b");
  return { writer: "completed", reader: "completed", cancelled: "failed", survivor: "completed" };
}

function assertMessage(events: readonly WorkerEvent[], expected: string): void {
  const message = events.findLast((event) => event.type === "output.message")?.message?.text;
  if (message !== expected)
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(events)}`);
}
