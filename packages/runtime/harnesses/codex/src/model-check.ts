import { spawn } from "node:child_process";
import { withoutProviderCredentials } from "@supertag/worker-sdk";

/** The outcome of checking a harness's configured models without running a Task. */
export type HarnessModelCheckResult =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "skipped"; readonly note: string };

/**
 * Asks a Codex app-server which models this account may use (`model/list`), without sending a
 * prompt. Rejects on any protocol, process, or timeout problem so the caller can skip the check.
 */
export async function listCodexModels(options: {
  readonly command: string;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly string[]> {
  const child = spawn(options.command, ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: withoutProviderCredentials({ ...process.env, ...options.environment }),
  });
  try {
    return await new Promise<readonly string[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Codex model listing timed out")),
        options.timeoutMs ?? 20_000,
      );
      timer.unref();
      child.once("error", reject);
      // A child that exits before reading its input makes writes fail with EPIPE on stdin's own
      // stream. Unhandled, that error would crash the Worker instead of skipping the check.
      child.stdin.on("error", reject);
      child.once("exit", () => reject(new Error("Codex app-server exited before listing models")));
      let buffer = "";
      const models: string[] = [];
      const send = (message: Record<string, unknown>) =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      const page = (cursor?: string) =>
        send({ id: 2, method: "model/list", params: cursor === undefined ? {} : { cursor } });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message["id"] === 1) {
            if (message["error"] !== undefined)
              return reject(new Error("Codex app-server refused initialization"));
            send({ method: "initialized", params: {} });
            page();
          } else if (message["id"] === 2) {
            const result = message["result"] as Record<string, unknown> | undefined;
            if (message["error"] !== undefined || !Array.isArray(result?.["data"]))
              return reject(new Error("Codex app-server did not list models"));
            for (const entry of result["data"] as unknown[])
              if (entry && typeof entry === "object")
                for (const key of ["id", "model"])
                  if (typeof (entry as Record<string, unknown>)[key] === "string")
                    models.push((entry as Record<string, unknown>)[key] as string);
            const next = result["nextCursor"];
            if (typeof next === "string" && next) page(next);
            else {
              clearTimeout(timer);
              resolve([...new Set(models)]);
            }
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "supertag", version: "1" } },
      });
    });
  } finally {
    child.kill();
  }
}

/** Compares configured models with the models a harness lists for this account. */
export function compareModels(
  harness: string,
  configured: readonly string[],
  available: readonly string[],
): HarnessModelCheckResult {
  if (available.length === 0)
    return { status: "skipped", note: `${harness} listed no models; skipping the model check.` };
  const missing = configured.filter((model) => !available.includes(model));
  return missing.length === 0
    ? { status: "ok" }
    : {
        status: "failed",
        message: `${harness} does not offer ${missing.join(", ")} for this account. Available models: ${available.join(", ")}.`,
      };
}

/** Checks configured Codex models with one model listing; a listing failure skips the check. */
export async function checkCodexModels(
  models: readonly string[],
  options: { readonly command?: string; readonly list?: typeof listCodexModels } = {},
): Promise<HarnessModelCheckResult> {
  if (models.length === 0) return { status: "ok" };
  try {
    const command = options.command ?? (await codexCommand());
    return compareModels("Codex", models, await (options.list ?? listCodexModels)({ command }));
  } catch (error) {
    return {
      status: "skipped",
      note: `Could not list Codex models (${error instanceof Error ? error.message : String(error)}); skipping the model check.`,
    };
  }
}

async function codexCommand(): Promise<string> {
  const { installedCodex } = await import("./index.js");
  return (await installedCodex()).command;
}
