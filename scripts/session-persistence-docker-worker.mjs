import { readFile } from "node:fs/promises";
import { createClaudeCodeWorker } from "supertag-ai/harnesses/claude-code";
import { createCodexWorker } from "supertag-ai/harnesses/codex";
import { LocalExecutionEnvironmentProvider } from "supertag-ai/worker";

const spec = JSON.parse(await readFile("/run/supertag/spec.json", "utf8"));
const options = {
  workspace: "/source",
  profileId: "session-live",
  profileRevision: "1",
  timeoutMs: 150_000,
  executionEnvironment: new LocalExecutionEnvironmentProvider({ temporaryDirectory: "/runtime" }),
};
const worker =
  process.env.SUPERTAG_SESSION_LIVE_PROVIDER === "codex"
    ? createCodexWorker({
        ...options,
        model: "gpt-5.6-luna",
        executionMode: process.env.SUPERTAG_SESSION_LIVE_MODE,
        maxNativeAgents: 0,
      })
    : createClaudeCodeWorker({ ...options, model: "haiku", maxTurns: 8 });
const events = [];
for await (const event of worker.execute(spec)) events.push(event);
process.stdout.write(JSON.stringify({ pid: process.pid, events }));
