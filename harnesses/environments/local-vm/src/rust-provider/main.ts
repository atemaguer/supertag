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

async function main(): Promise<void> {
  const session = createLocalVmWorkspaceSession(localVmOptions(), progress);
  try {
    await runRemoteWorkspaceTransport(createWorkspaceHandlers(session));
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
