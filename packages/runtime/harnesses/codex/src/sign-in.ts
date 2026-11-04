import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { minimalProcessEnvironment } from "@supertag/worker-sdk";
import { codexAuthFilePath, prepareCodexHome } from "./authentication.js";
import { codexRuntimeFeatures } from "./runtime-features.js";

/** Uses the bundled SDK with exactly the local Worker's credential precedence. */
export async function checkCodexSignIn(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly createCodex?: (
      options: ConstructorParameters<typeof Codex>[0],
    ) => Pick<Codex, "startThread">;
  } = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  if (!environment["CODEX_API_KEY"]?.trim()) {
    const file = await readFile(codexAuthFilePath(environment), "utf8").catch(() => undefined);
    if (file !== undefined) return hasFileBackedCredential(file);
  }
  const directoryPromise = mkdtemp(join(tmpdir(), "supertag-codex-signin-"));
  let directory: string | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    controller.abort();
    void directoryPromise
      .then((created) => rm(created, { recursive: true, force: true }))
      .catch(() => undefined)
      .finally(() => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        process.kill(process.pid, signal);
      });
  };
  const interrupt = () => onSignal("SIGINT");
  const terminate = () => onSignal("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    directory = await directoryPromise;
    if (controller.signal.aborted) return false;
    const home = join(directory, ".codex");
    const apiKey = await prepareCodexHome(home, environment);
    const codexPath =
      options.createCodex === undefined
        ? (await import("./index.js").then(({ installedCodex }) => installedCodex())).command
        : undefined;
    const codex = (options.createCodex ?? ((config) => new Codex(config)))({
      ...(codexPath === undefined ? {} : { codexPathOverride: codexPath }),
      ...(apiKey ? { apiKey } : {}),
      env: { ...minimalProcessEnvironment(environment), CODEX_HOME: home },
      config: {
        agents: { enabled: false },
        features: { ...codexRuntimeFeatures([]), apply_patch_freeform: false },
      },
    });
    const thread = codex.startThread({
      ...(options.model === undefined ? {} : { model: options.model }),
      workingDirectory: directory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      networkAccessEnabled: false,
    });
    const result = await thread.run("Reply with OK only.", { signal: controller.signal });
    return Boolean(result.finalResponse.trim()) && !controller.signal.aborted;
  } catch {
    // SDK errors and stderr can contain credentials. Do not return their text.
    return false;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    controller.abort();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

/** Read-only check: a copied OAuth refresh token must never be rotated by an init probe. */
function hasFileBackedCredential(content: string): boolean {
  try {
    const auth: unknown = JSON.parse(content);
    if (auth === null || typeof auth !== "object") return false;
    const record = auth as Record<string, unknown>;
    if (typeof record["OPENAI_API_KEY"] === "string" && record["OPENAI_API_KEY"].trim())
      return true;
    const tokens = record["tokens"];
    if (tokens === null || typeof tokens !== "object") return false;
    const refreshToken = (tokens as Record<string, unknown>)["refresh_token"];
    return typeof refreshToken === "string" && Boolean(refreshToken.trim());
  } catch {
    return false;
  }
}
