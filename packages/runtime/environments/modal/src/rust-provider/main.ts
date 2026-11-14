import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createWorkspaceHandlers,
  runRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { createModalWorkspaceSession } from "./session.js";

async function main(): Promise<void> {
  const session = createModalWorkspaceSession();
  try {
    await runRemoteWorkspaceTransport(createWorkspaceHandlers(session));
  } finally {
    await session.close();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("SuperTag Modal Workspace provider stopped after an error.\n");
    process.exitCode = 1;
  });
}
