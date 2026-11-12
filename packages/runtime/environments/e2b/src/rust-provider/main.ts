import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type HarnessWorkspaceRequest,
  WorkspaceGrepMode,
} from "@supertag/worker-sdk/internal/rust-harness";
import type { WorkspaceOperation } from "./operations.js";
import { createE2BWorkspaceSession } from "./session.js";
import { type RemoteWorkspaceHandlers, runRemoteWorkspaceTransport } from "./transport.js";

const MAX_TRANSFER = 256 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
type Session = ReturnType<typeof createE2BWorkspaceSession>;

function workspaceOperation(input: HarnessWorkspaceRequest): WorkspaceOperation {
  const { operation } = input;
  switch (operation.case) {
    case "read": {
      const { path, offset, limit } = operation.value;
      return {
        kind: "read",
        path,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
    case "write":
      return { kind: "write", ...operation.value };
    case "edit":
      return { kind: "edit", ...operation.value };
    case "glob": {
      const { pattern, path } = operation.value;
      return { kind: "glob", pattern, ...(path !== undefined ? { path } : {}) };
    }
    case "list":
      return {
        kind: "ls",
        ...(operation.value.path !== undefined ? { path: operation.value.path } : {}),
      };
    case "grep": {
      const { mode, pattern, path, glob, offset, headLimit } = operation.value;
      const fields = {
        pattern,
        ...(path !== undefined ? { path } : {}),
        ...(glob !== undefined ? { glob } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(headLimit !== undefined ? { headLimit } : {}),
      };
      switch (mode) {
        case WorkspaceGrepMode.UNSPECIFIED:
        case WorkspaceGrepMode.CONTENT:
          return { kind: "grep", ...fields, outputMode: "content" };
        case WorkspaceGrepMode.FILES_WITH_MATCHES:
          return { kind: "grep", ...fields, outputMode: "files_with_matches" };
        case WorkspaceGrepMode.COUNT:
          return { kind: "grep", ...fields, outputMode: "count" };
        default:
          throw new ConnectError("Invalid Workspace grep mode", Code.InvalidArgument);
      }
    }
    case "command":
      throw new ConnectError(
        "E2B Workspace command execution is unavailable",
        Code.PermissionDenied,
      );
    default:
      throw new ConnectError("Workspace operation is required", Code.InvalidArgument);
  }
}

function invalidBundle(): ConnectError {
  return new ConnectError("Invalid Workspace bundle stream", Code.InvalidArgument);
}

export function createE2BWorkspaceHandlers(session: Session): RemoteWorkspaceHandlers {
  let stageInFlight = false;
  return {
    provider: {
      async allocate(request, context) {
        if (!request.owner)
          throw new ConnectError("Workspace owner is required", Code.InvalidArgument);
        return session.allocate({ ...request, owner: request.owner }, context.signal);
      },
      async stage(stream, context) {
        if (stageInFlight)
          throw new ConnectError("Workspace bundle is already staging", Code.FailedPrecondition);
        stageInFlight = true;
        try {
          let header: Parameters<Session["stage"]>[0] | undefined;
          let bytes: Uint8Array | undefined;
          let offset = 0;
          for await (const { part } of stream) {
            if (part.case === "header" && !header) {
              const { bundle, startCommit } = part.value;
              if (
                !bundle ||
                bundle.byteLength < 1n ||
                bundle.byteLength > BigInt(MAX_TRANSFER) ||
                !/^[0-9a-f]{64}$/u.test(bundle.sha256) ||
                !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(startCommit)
              )
                throw invalidBundle();
              header = { startCommit, bundle };
              bytes = new Uint8Array(Number(bundle.byteLength));
            } else if (part.case === "payload" && bytes) {
              const payload = part.value;
              if (payload.byteLength === 0 || payload.byteLength > bytes.byteLength - offset)
                throw invalidBundle();
              bytes.set(payload, offset);
              offset += payload.byteLength;
            } else {
              throw invalidBundle();
            }
          }
          if (!header || !bytes || bytes.byteLength !== offset) throw invalidBundle();
          await session.stage(header, bytes, context.signal);
          return {};
        } finally {
          stageInFlight = false;
        }
      },
      async *capture(_request, context) {
        const { tree, bytes } = await session.capture(context.signal);
        yield { part: { case: "tree", value: tree } };
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
          context.signal.throwIfAborted();
          yield { part: { case: "payload", value: bytes.subarray(offset, offset + CHUNK_SIZE) } };
        }
      },
      async stop(request) {
        if (!request.owner)
          throw new ConnectError("Workspace owner is required", Code.InvalidArgument);
        const result = await session.stop({
          owner: request.owner,
          ...(request.sandboxId !== undefined ? { sandboxId: request.sandboxId } : {}),
        });
        return result.state === "stopped" ? { stoppedSandboxId: result.sandboxId } : {};
      },
    },
    workspace: {
      async execute(request, context) {
        return session.execute(workspaceOperation(request), context.signal);
      },
    },
  };
}

async function main(): Promise<void> {
  const session = createE2BWorkspaceSession();
  try {
    await runRemoteWorkspaceTransport(createE2BWorkspaceHandlers(session));
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
