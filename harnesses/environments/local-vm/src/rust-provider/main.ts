import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createWorkspaceHandlers,
  runRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { createLocalVmWorkspaceSession, localVmOptions } from "./session.js";

/** A progress line the Worker Host logs; nothing else this provider writes reaches its log. */
function progress(line: string): void {
  process.stderr.write(`supertag-progress: ${line}\n`);
}

/** An error's message and its causes' messages, one line, bounded. */
function causes(error: unknown): string {
  const messages: string[] = [];
  for (let at = error, depth = 0; at !== undefined && depth < 4; depth++) {
    messages.push(at instanceof Error ? at.message : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return messages
    .join(": ")
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, 500);
}

async function main(): Promise<void> {
  const session = createLocalVmWorkspaceSession(localVmOptions(), progress);
  try {
    await runRemoteWorkspaceTransport(createWorkspaceHandlers(session), {
      // The Worker Host sees only an internal error; its log gets the cause.
      onError: (error) => progress(`operation failed: ${causes(error)}`),
    });
  } finally {
    await session.close();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("SuperTag local-vm Workspace provider stopped after an error.\n");
    process.exitCode = 1;
  });
}
