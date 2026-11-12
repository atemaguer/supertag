import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createWorkspaceHandlers,
  runRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { createE2BWorkspaceSession } from "./session.js";

async function main(): Promise<void> {
  const session = createE2BWorkspaceSession();
  try {
    await runRemoteWorkspaceTransport(createWorkspaceHandlers(session));
  } finally {
    // Only the Worker Host can record durable cleanup. The session may stop
    // a staged sandbox while preserving an unacknowledged allocation for discovery.
    await session.close();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("SuperTag E2B Workspace provider stopped after an error.\n");
    process.exitCode = 1;
  });
}
