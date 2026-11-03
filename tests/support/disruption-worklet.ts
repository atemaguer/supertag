import { join } from "node:path";
/** Child-process fixture: killed while executing, never invokes a model provider. */
import { createCodexWorker } from "../../packages/runtime/harnesses/codex/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";

process.once("message", async (input: { url: string; directory: string; credential: string }) => {
  try {
    const worker = createCodexWorker({
      workspace: join(input.directory, "source-workspace"),
      profileId: "disruption",
      executionEnvironment: new LocalExecutionEnvironmentProvider({
        temporaryDirectory: input.directory,
      }),
      runner: async function* (request, environment) {
        const server = request.mcpServers.find((server) => server.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Missing coordination input");
        const response = await fetch(server.url, {
          method: "POST",
          headers: { ...server.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        if (!response.ok) throw new Error("Attempt credential rejected");
        await response.json();
        process.send?.({
          type: "executing",
          authorization: server.headers["Authorization"],
          rootDirectory: environment.rootDirectory,
        });
        await new Promise<void>(() => {});
        yield { type: "output.message", text: "unreachable" };
      },
    });
    const worklet = new LocalWorklet("killed-worklet", "killed-host", [worker]);
    await connectWorklet({
      url: input.url,
      credential: input.credential,
      worklet,
      durableWorklet: new DurableLocalWorklet(
        worklet,
        new FileAttemptJournal(join(input.directory, "journal")),
      ),
    });
    process.send?.({ type: "ready" });
  } catch (error) {
    process.send?.({
      type: "error",
      message: error instanceof Error ? error.message : "Child fixture failed",
    });
    process.exitCode = 1;
  }
});
