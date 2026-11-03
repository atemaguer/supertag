import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostEnvironmentProvider } from "../apps/cli/src/host-environment.js";
import { createHarnessWorker, type WorkletHarness } from "../apps/cli/src/worker.js";
import { checkClaudeCodeSignIn } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  ContextResolverRegistry,
  collectTaskAttemptEvents,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";
import { repositoryAttempt } from "./support/repository-execution.js";

// A live suite stays discoverable in normal Vitest runs without opening a Modal sandbox.
const enabled = process.env["SUPERTAG_LIVE_MODAL"] === "1" && !process.env["CI"];
const suite = enabled ? describe : describe.skip;
const credentialNames = [
  "CURSOR_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const claudeEnvironmentCredential = credentialNames.slice(1).some((name) => process.env[name]);
const claudeSignedIn =
  enabled && !claudeEnvironmentCredential ? await checkClaudeCodeSignIn() : false;

function missingCredential(harness: WorkletHarness): string | undefined {
  if (harness === "cursor")
    return process.env["CURSOR_API_KEY"] ? undefined : "CURSOR_API_KEY is missing";
  return claudeEnvironmentCredential || claudeSignedIn
    ? undefined
    : "Claude sign-in is missing: run claude and /login, or set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN";
}

suite("Modal host split execution (live)", () => {
  for (const harness of ["cursor", "claude-code"] as const) {
    const reason = missingCredential(harness);
    it.skipIf(Boolean(reason))(
      `${harness} edits a file and runs a command in Modal${reason ? `; skipped: ${reason}` : ""}`,
      async () => {
        const root = await mkdtemp(
          join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "supertag-split-modal-"),
        );
        const source = join(root, "source");
        const marker = `MODAL_${harness.replaceAll("-", "_")}_${randomUUID().slice(0, 8)}`;
        const seen: {
          edit?: string;
          commandFile?: string;
          commandOutput?: string;
          environment?: string;
          placement?: string;
          probeErrors: string[];
        } = { probeErrors: [] };
        try {
          await mkdir(source);
          await writeFile(join(source, "seed.txt"), "before\n");
          const provider = await createHostEnvironmentProvider(
            {
              provider: "modal",
              app: process.env["SUPERTAG_LIVE_MODAL_APP"] ?? "supertag-conformance",
            },
            { stagingDirectory: join(root, "staging"), sandboxTimeoutMs: 240_000 },
          );
          const observedProvider: ExecutionEnvironmentProvider = {
            ...provider,
            provision: async (spec, signal) => {
              const environment = await provider.provision(spec, signal);
              return new Proxy(environment, {
                get(target, property) {
                  if (property === "dispose")
                    return async (disposition: "completed" | "failed" | "cancelled") => {
                      // Probe failures are recorded, never thrown: when the run fails early the
                      // workspace files may not exist, and a probe error must not mask the real
                      // terminal event.
                      const probeSafely = async <T>(probe: () => Promise<T>) => {
                        try {
                          return await probe();
                        } catch (error) {
                          seen.probeErrors.push(
                            error instanceof Error ? error.message : String(error),
                          );
                          return undefined;
                        }
                      };
                      try {
                        seen.placement = target.placement;
                        const environmentResult = await probeSafely(async () => {
                          const probe = await target.spawn({
                            command: "sh",
                            args: [
                              "-c",
                              `test -z "$CURSOR_API_KEY" && test -z "$ANTHROPIC_API_KEY" && test -z "$ANTHROPIC_AUTH_TOKEN" && test -z "$CLAUDE_CODE_OAUTH_TOKEN" && test -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR" && test -z "$CLAUDE_CONFIG_DIR" && test ! -e "$HOME/.claude/.credentials.json" && test -z "$(find . -name .credentials.json -print -quit)"`,
                            ],
                            cwd: target.rootDirectory,
                            timeoutMs: 15_000,
                          });
                          return probe.wait();
                        });
                        if (environmentResult !== undefined)
                          seen.environment =
                            environmentResult.exitCode === 0
                              ? "clean"
                              : `exit ${environmentResult.exitCode}`;
                        const commandResult = await probeSafely(async () => {
                          const probe = await target.spawn({
                            command: "cat",
                            args: ["workspace/command.txt"],
                            cwd: target.rootDirectory,
                            timeoutMs: 15_000,
                          });
                          return probe.wait();
                        });
                        if (commandResult?.exitCode === 0)
                          seen.commandOutput = commandResult.stdout;
                        seen.edit = await probeSafely(() => target.read("workspace/seed.txt"));
                        seen.commandFile = await probeSafely(() =>
                          target.read("workspace/command.txt"),
                        );
                      } finally {
                        await target.dispose(disposition);
                      }
                    };
                  const value = Reflect.get(target, property, target) as unknown;
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }) as ExecutionEnvironment;
            },
          };
          const worker = createHarnessWorker(
            {
              harness,
              workerId: `modal-live-${harness}`,
              profileId: `modal-live-${harness}`,
              profileRevision: "1",
              models: [harness === "cursor" ? "claude-sonnet-5-5" : "haiku"],
            },
            {
              mcpServers: {},
              executionEnvironment: observedProvider,
              splitHostEnvironment: true,
              checkouts: [],
              worktreeRoot: join(root, "worktrees"),
              shared: {
                workspace: source,
                timeoutMs: 180_000,
                redactValues: credentialNames.flatMap((name) => {
                  const value = process.env[name];
                  return value ? [value] : [];
                }),
                contextResolvers: new ContextResolverRegistry([]) as unknown as Parameters<
                  typeof createHarnessWorker
                >[1]["shared"]["contextResolvers"],
              },
            },
          );
          const attempt = repositoryAttempt(`modal-live-${harness}-${randomUUID()}`);
          const events = await collectTaskAttemptEvents(
            worker.execute({
              ...attempt,
              workerProfile: { id: `modal-live-${harness}`, revision: "1" },
              execution: { model: harness === "cursor" ? "claude-sonnet-5-5" : "haiku" },
              input: {
                ...attempt.input,
                messages: [
                  {
                    id: "request",
                    role: "requester",
                    text: `Use the workspace file tools to replace the entire contents of seed.txt with exactly ${marker} followed by a newline. Then use the command tool to run: printf '${marker}\\n' > command.txt && cat command.txt. Reply with the exact command output.`,
                  },
                ],
              },
            }),
          );
          expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
            type: "execution.completed",
          });
          expect(terminalOutputText(events)).toContain(marker);
          expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
            manifest: {
              harnessRuntime: { placement: "local" },
              executionEnvironment: { placement: "remote" },
            },
          });
          expect(seen.placement).toBe("remote");
          expect(seen.edit).toBe(`${marker}\n`);
          expect(seen.commandFile).toBe(`${marker}\n`);
          expect(seen.commandOutput).toBe(`${marker}\n`);
          expect(seen.environment).toBe("clean");
          expect(seen.probeErrors).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      300_000,
    );
  }
});
