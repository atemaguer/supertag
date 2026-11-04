import { query } from "@anthropic-ai/claude-agent-sdk";

/** The outcome of checking a harness's configured models without running a Task. */
export type ClaudeCodeModelCheckResult =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "skipped"; readonly note: string };

/**
 * Checks configured Claude Code models against the Agent SDK's model listing, which sends no
 * prompt. A model matches a listed value, a listed variant's base ID, or the model an alias resolves
 * to. Claude Code accepts more IDs than it lists, so only a listing match is reported as ok; a miss
 * or a listing failure is a note rather than a startup failure.
 */
export async function checkClaudeCodeModels(
  models: readonly string[],
  options: { readonly queryAgent?: typeof query; readonly timeoutMs?: number } = {},
): Promise<ClaudeCodeModelCheckResult> {
  if (models.length === 0) return { status: "ok" };
  let session: ReturnType<typeof query> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const executable =
      options.queryAgent === undefined
        ? (await import("./index.js").then(({ installedClaudeCode }) => installedClaudeCode()))
            .command
        : undefined;
    session = (options.queryAgent ?? query)({
      // Streaming input that never sends a message: the session answers control requests only.
      prompt: (async function* () {
        await new Promise<never>(() => undefined);
      })(),
      options: {
        settingSources: [],
        maxTurns: 1,
        ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
      },
    });
    const listed = await Promise.race([
      session.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code model listing timed out")),
          options.timeoutMs ?? 20_000,
        );
      }),
    ]);
    const available = [
      ...new Set(
        listed.flatMap((model) => [
          model.value,
          ...(model.resolvedModel === undefined ? [] : [model.resolvedModel]),
        ]),
      ),
    ];
    if (available.length === 0)
      return { status: "skipped", note: "Claude Code listed no models; skipping the model check." };
    // The listing is a menu of aliases and variants (`claude-opus-5-5[1m]`), not every model ID
    // Claude Code accepts, so an unlisted model is a note, never a startup failure.
    const known = new Set(available.flatMap((model) => [model, model.replace(/\[[^\]]*\]$/u, "")]));
    const missing = models.filter((model) => !known.has(model));
    return missing.length === 0
      ? { status: "ok" }
      : {
          status: "skipped",
          note: `Claude Code's model list doesn't include ${missing.join(", ")} (it lists ${available.join(", ")}). Continuing; a Task Attempt reports the provider's error if the model is rejected.`,
        };
  } catch (error) {
    return {
      status: "skipped",
      note: `Could not list Claude Code models (${error instanceof Error ? error.message : String(error)}); skipping the model check.`,
    };
  } finally {
    clearTimeout(timer);
    try {
      session?.close();
    } catch {
      // The session never started; nothing to close.
    }
  }
}
