import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEnvironment } from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";

import { installedCodex, runCodex } from "./src/index.js";

it("overrides native delegation even with conflicting user and workspace configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-delegation-"));
  const userHome = join(directory, "user");
  const attemptHome = join(directory, "attempt", ".codex");
  await mkdir(userHome, { recursive: true });
  await mkdir(attemptHome, { recursive: true });
  const config =
    "[agents]\nenabled = true\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\nenable_fanout = true\n";
  await writeFile(join(userHome, "config.toml"), config);
  await writeFile(join(attemptHome, "config.toml"), config);
  vi.stubEnv("CODEX_HOME", userHome);
  vi.stubEnv("CODEX_API_KEY", "test-only-key");
  try {
    let captured: import("@supertag/worker-sdk").ProcessSpec | undefined;
    const environment = {
      placement: "local",
      async spawn(spec: import("@supertag/worker-sdk").ProcessSpec) {
        captured = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${[
                { type: "thread.started", thread_id: "test-thread" },
                {
                  type: "item.completed",
                  item: { id: "answer", type: "agent_message", text: "done" },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          async wait() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          kill() {},
        };
      },
      resolvePath: (path: string) => join(directory, "attempt", path),
    } as ExecutionEnvironment;
    for await (const _ of runCodex(
      {
        prompt: "Delegate to helpers",
        workspace: join(directory, "attempt"),
        command: "codex",
        model: "gpt-5.6-luna",
        timeoutMs: 1000,
        toolInputs: [],
        mcpServers: [],
        runtimeActions: ["commands:execute", "files:write"],
      },
      environment,
    )) {
      /* exhaust SDK adapter */
    }
    expect(captured?.args).toEqual(
      expect.arrayContaining([
        "--json",
        "--ignore-user-config",
        "agents.enabled=false",
        "features.multi_agent=false",
        "features.multi_agent_v2=false",
        "features.enable_fanout=false",
        "gpt-5.6-luna",
      ]),
    );
    expect(captured?.environment).toMatchObject({ CODEX_HOME: attemptHome });
    // Tasks run the user's installed Codex CLI, not a copy bundled with the SDK.
    expect(captured?.command).toBe((await installedCodex()).command);
    expect(captured?.streamOutput).toBe(true);
    expect(await readFile(join(userHome, "config.toml"), "utf8")).toBe(config);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
