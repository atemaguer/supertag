import { Code, ConnectError } from "@connectrpc/connect";
import { type HarnessWorkspaceRequest, WorkspaceGrepMode } from "../rust-harness/index.js";
import { inputManifest } from "./input-files.js";
import type { WorkspaceOperation } from "./operations.js";
import { type createSandboxWorkspaceSession, MAX_TRANSFER } from "./session.js";
import type { RemoteWorkspaceHandlers } from "./transport.js";

const CHUNK_SIZE = 256 * 1024;
type Session = ReturnType<typeof createSandboxWorkspaceSession>;

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
        "Remote Workspace command execution is unavailable",
        Code.PermissionDenied,
      );
    default:
      throw new ConnectError("Workspace operation is required", Code.InvalidArgument);
  }
}

function invalidBundle(): ConnectError {
  return new ConnectError("Invalid Workspace bundle stream", Code.InvalidArgument);
}

export function createWorkspaceHandlers(session: Session): RemoteWorkspaceHandlers {
  let stageInFlight = false;
  return {
    provider: {
      async allocate(request, context) {
        if (!request.owner)
          throw new ConnectError("Workspace owner is required", Code.InvalidArgument);
        const { owner, timeoutMs, allowedActions, environment, preparedArtifact, prepare } =
          request;
        return session.allocate(
          {
            owner,
            timeoutMs,
            allowedActions,
            ...(preparedArtifact === undefined ? {} : { preparedArtifact }),
            prepare,
            ...(environment === undefined
              ? {}
              : {
                  environment: {
                    ...(environment.image === undefined ? {} : { image: environment.image }),
                    dockerfileCommands: environment.dockerfileCommands,
                    ...(environment.user === undefined ? {} : { user: environment.user }),
                    setupCommands: environment.setupCommands,
                  },
                }),
          },
          context.signal,
        );
      },
      async stage(stream, context) {
        if (stageInFlight)
          throw new ConnectError("Workspace bundle is already staging", Code.FailedPrecondition);
        stageInFlight = true;
        try {
          let header: Parameters<Session["stage"]>[0] | undefined;
          let bytes: Uint8Array | undefined;
          let bundleLength = 0;
          let offset = 0;
          for await (const { part } of stream) {
            if (part.case === "header" && !header) {
              const { bundle, startCommit, inputFiles, mcpCommit } = part.value;
              if (
                !bundle ||
                bundle.byteLength < 1n ||
                bundle.byteLength > BigInt(MAX_TRANSFER) ||
                !/^[0-9a-f]{64}$/u.test(bundle.sha256) ||
                !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(startCommit)
              )
                throw invalidBundle();
              let inputLength: number;
              try {
                inputLength = inputManifest(inputFiles);
              } catch {
                throw invalidBundle();
              }
              bundleLength = Number(bundle.byteLength);
              if (bundleLength + inputLength > MAX_TRANSFER) throw invalidBundle();
              header = {
                startCommit,
                bundle,
                inputFiles,
                ...(mcpCommit !== undefined ? { mcpCommit } : {}),
              };
              bytes = new Uint8Array(bundleLength + inputLength);
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
          await session.stage(
            header,
            bytes.subarray(0, bundleLength),
            context.signal,
            bytes.subarray(bundleLength),
          );
          return { inputFiles: [...(header.inputFiles ?? [])] };
        } finally {
          stageInFlight = false;
        }
      },
      async stageCopy(stream, context) {
        const inputs = stream[Symbol.asyncIterator]();
        const first = await inputs.next();
        if (first.done || first.value.part.case !== "header")
          throw new ConnectError("Workspace copy header is required", Code.InvalidArgument);
        const { path, readWrite } = first.value.part.value;
        async function* parts() {
          for (;;) {
            const next = await inputs.next();
            if (next.done) return;
            const { part } = next.value;
            if (part.case === "file") yield { case: "file" as const, value: part.value };
            else if (part.case === "directory")
              yield { case: "directory" as const, value: part.value };
            else if (part.case === "payload" && part.value.byteLength <= CHUNK_SIZE)
              yield { case: "payload" as const, value: part.value };
            else throw new ConnectError("Invalid Workspace copy stream", Code.InvalidArgument);
          }
        }
        return session.stageCopy({ path, readWrite }, parts(), context.signal);
      },
      async *captureCopy(request, context) {
        for await (const part of session.captureCopy(request, context.signal)) yield { part };
      },
      async *capture(_request, context) {
        const { tree, bytes } = await session.capture(context.signal);
        yield { part: { case: "tree", value: tree } };
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
          context.signal.throwIfAborted();
          yield { part: { case: "payload", value: bytes.subarray(offset, offset + CHUNK_SIZE) } };
        }
      },
      async *runMcpServer(stream, context) {
        const inputs = stream[Symbol.asyncIterator]();
        const first = await inputs.next();
        if (first.done || first.value.part.case !== "start")
          throw new ConnectError("Workspace MCP server start is required", Code.InvalidArgument);
        const { name, command, args } = first.value.part.value;
        const server = await session.startMcpServer({ name, command, args }, context.signal);
        const { write, endInput, output } = server;
        if (!write || !endInput || !output)
          throw new ConnectError("Workspace MCP server is unavailable", Code.Unavailable);
        // The Host's input ends when it closes the server; then the server sees end of input.
        const forwarded = (async () => {
          for (;;) {
            const next = await inputs.next();
            if (next.done) break;
            if (next.value.part.case !== "stdin")
              throw new ConnectError("Invalid Workspace MCP server input", Code.InvalidArgument);
            await write.call(server, next.value.part.value);
          }
          await endInput.call(server);
        })();
        // Never wait on the Host's input once the server ended: ending the call releases it.
        forwarded.catch(() => session.stopMcpServer(server));
        const encoder = new TextEncoder();
        try {
          for await (const chunk of output) {
            // Server diagnostics stay in the sandbox: stderr can echo its environment.
            if (chunk.stream === "stdout" && chunk.text)
              yield { stdout: encoder.encode(chunk.text) };
          }
        } finally {
          // Ends its input, so its supervisor stops its process group, never the sandbox.
          await session.stopMcpServer(server);
        }
      },
      async snapshot(_request, context) {
        return { artifact: await session.snapshot(context.signal) };
      },
      async removeArtifact(request, context) {
        await session.removeArtifact(request.artifact, context.signal);
        return {};
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
