import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { FileScopeRules } from "@supertag/worker-sdk/internal/rust-harness";
import { expect, it } from "vitest";
import { claudeQuery } from "./src/query.js";
import { permissionHook } from "./src/rust-adapter/adapter.js";
import { NATIVE_MEMORY_DIRECTORY, nativeEnvironment } from "./src/rust-adapter/environment.js";

const TOOLS = ["Read", "Write", "Edit"];

/** One Attempt as the adapter starts it: its own config, cwd, and custom system prompt. */
async function turn(directory: string, memory: string, name: string, prompt: string) {
  const state = join(directory, `${name}-state`);
  const workspace = join(directory, `${name}-workspace`);
  await mkdir(state, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const {
    env,
    cwd,
    memory: root,
  } = await nativeEnvironment({
    ...process.env,
    SUPERTAG_ADAPTER_STATE_DIRECTORY: state,
    SUPERTAG_WORKSPACE_DIRECTORY: workspace,
    [NATIVE_MEMORY_DIRECTORY]: memory,
  });
  if (!root) throw new Error("native memory directory was not taken up");
  const options: Options = {
    cwd,
    env,
    tools: TOOLS,
    allowedTools: TOOLS,
    additionalDirectories: [root],
    permissionMode: "dontAsk",
    settingSources: [],
    settings: { autoMemoryDirectory: root },
    systemPrompt: "You are a SuperTag Tag working on an accepted Task. Be brief.",
    model: "haiku",
    maxTurns: 6,
    persistSession: false,
    stderr: () => {},
    hooks: {
      PreToolUse: [
        {
          hooks: [
            permissionHook(
              TOOLS,
              cwd,
              AbortSignal.timeout(170_000),
              new Set(),
              [],
              new Map(),
              {
                read: [],
                write: [],
              },
              {
                rules: new FileScopeRules(),
                outside: { read: [], write: [] },
                memory: { root, only: new Set(TOOLS) },
              },
            ),
          ],
        },
      ],
    },
  };
  let result = "";
  let cost = 0;
  for await (const message of claudeQuery(query, prompt, options, AbortSignal.timeout(170_000))) {
    if (message.type === "result") {
      result = message.subtype === "success" ? message.result : message.subtype;
      cost = message.total_cost_usd;
    }
  }
  return { result, cost };
}

// Opt-in and live: two short Haiku turns on the operator's Claude sign-in
// (SUPERTAG_TEST_CLAUDE_LIVE=1). Run it after every Claude Agent SDK or Claude Code upgrade.
// It pins what native memory relies on: under our custom system prompt, Claude Code learns of
// its memory directory only from CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, writes a memory there with
// its file tools, and a later fresh session in another directory finds it.
it.skipIf(process.env["SUPERTAG_TEST_CLAUDE_LIVE"] !== "1")(
  "keeps a memory across Attempts in the Tag's native memory directory",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-native-memory-")));
    try {
      const memory = join(directory, "memory");
      await mkdir(memory, { mode: 0o700 });
      const codename = `heron-${Date.now().toString(36)}`;
      const first = await turn(
        directory,
        memory,
        "first",
        `Remember for future conversations: the deploy codename is ${codename}. Save it to your memory now, then reply SAVED.`,
      );
      const files = await readdir(memory, { recursive: true });
      const contents = await Promise.all(
        files
          .filter((file) => file.endsWith(".md"))
          .map((file) => readFile(join(memory, file), "utf8")),
      );
      expect(contents.join("\n"), JSON.stringify({ first, files })).toContain(codename);

      const second = await turn(
        directory,
        memory,
        "second",
        "What is the deploy codename? Answer from your memory with just the codename.",
      );
      expect(second.result, JSON.stringify(second)).toContain(codename);
      console.log(
        `native memory live check: files=${files.join(",")} cost=$${(first.cost + second.cost).toFixed(4)}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  360_000,
);
