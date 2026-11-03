import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import type { SessionPersistence } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";
import type { StoredHarnessSessionState } from "@supertag/worker-sdk";
import {
  decodeSessionArchive,
  decodeSessionRef,
  encodeSessionArchive,
  encodeSessionRef,
  SESSION_GRPC_CHUNK_BYTES,
  SESSION_GRPC_MAX_ARCHIVE_BYTES,
  SessionService,
  sessionArchiveDigest,
} from "@supertag/worker-transport";

/** The API edge adds framing only; SessionPersistence remains the sole policy/state owner. */
export function registerSessionGrpcRoutes(
  router: ConnectRouter,
  sessions: SessionPersistence,
  options: { readonly beginRequest?: () => () => void } = {},
): void {
  let active = 0;
  const begin = (timeoutMs: number | undefined) => {
    if (timeoutMs === undefined || timeoutMs > 60_000)
      throw new ConnectError(
        "Session calls require a deadline of at most 60 seconds",
        Code.InvalidArgument,
      );
    if (active >= 8)
      throw new ConnectError("Session persistence capacity exhausted", Code.ResourceExhausted);
    const release = options.beginRequest?.();
    active++;
    return () => {
      active--;
      release?.();
    };
  };
  router.service(
    SessionService,
    {
      async save(requests, context) {
        const release = begin(context.timeoutMs());
        const token = bearer(context.requestHeader.get("authorization"));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new ConnectError("Session upload deadline exceeded", Code.DeadlineExceeded)),
            60_000,
          );
          timeout.unref();
        });
        // Authentication may still be pending when the upload budget expires.
        void expired.catch(() => undefined);
        try {
          await sessions.execution(token);
          const iterator = requests[Symbol.asyncIterator]();
          const first = await Promise.race([iterator.next(), expired]);
          if (first.done || first.value.frame.case !== "header")
            throw new ConnectError("Session upload requires a header first", Code.InvalidArgument);
          const header = first.value.frame.value;
          const ref = decodeSessionRef(header.ref);
          const writeVersion = Number(header.writeVersion);
          if (
            !header.harnessId.trim() ||
            header.harnessId.length > 1024 ||
            !Number.isSafeInteger(writeVersion) ||
            writeVersion < 1 ||
            header.archiveSize < 2 ||
            !/^[a-f0-9]{64}$/u.test(header.archiveSha256)
          )
            throw new ConnectError("Invalid Session upload header", Code.InvalidArgument);
          if (header.archiveSize > SESSION_GRPC_MAX_ARCHIVE_BYTES)
            throw new ConnectError("Session state exceeds 16 MiB", Code.ResourceExhausted);
          const bytes = Buffer.alloc(header.archiveSize);
          let size = 0;
          let chunkCount = 0;
          for (;;) {
            const next = await Promise.race([iterator.next(), expired]);
            if (next.done) break;
            if (context.signal.aborted)
              throw new ConnectError("Session upload cancelled", Code.Canceled);
            if (next.value.frame.case !== "chunk")
              throw new ConnectError(
                "Session upload contains an unexpected frame",
                Code.InvalidArgument,
              );
            const chunk = next.value.frame.value;
            if (++chunkCount > 1024)
              throw new ConnectError(
                "Session archive contains too many chunks",
                Code.ResourceExhausted,
              );
            if (chunk.byteLength === 0 || chunk.byteLength > SESSION_GRPC_CHUNK_BYTES)
              throw new ConnectError("Invalid Session archive chunk size", Code.InvalidArgument);
            if (size + chunk.byteLength > header.archiveSize)
              throw new ConnectError("Session archive exceeds declared size", Code.InvalidArgument);
            bytes.set(chunk, size);
            size += chunk.byteLength;
          }
          if (context.signal.aborted)
            throw new ConnectError("Session upload cancelled", Code.Canceled);
          clearTimeout(timeout);
          if (size !== header.archiveSize || sessionArchiveDigest(bytes) !== header.archiveSha256)
            throw new ConnectError("Incomplete or invalid Session archive", Code.InvalidArgument);
          await sessions.command(
            "save",
            { ref, harnessId: header.harnessId, writeVersion, data: decodeSessionArchive(bytes) },
            token,
          );
          return { writeVersion: header.writeVersion };
        } catch (error) {
          throw sessionError(error);
        } finally {
          clearTimeout(timeout);
          release();
        }
      },
      async *load(request, context) {
        const release = begin(context.timeoutMs());
        const token = bearer(context.requestHeader.get("authorization"));
        try {
          await sessions.execution(token);
          const ref = decodeSessionRef(request.ref);
          const state = (await sessions.command(
            "load",
            { ref },
            token,
          )) as StoredHarnessSessionState | null;
          if (state === null) {
            yield { frame: { case: "notFound", value: true } };
            return;
          }
          const bytes = encodeSessionArchive(state.data);
          yield {
            frame: {
              case: "header",
              value: {
                ref: encodeSessionRef(state.ref),
                harnessId: state.harnessId,
                archiveSize: bytes.byteLength,
                archiveSha256: sessionArchiveDigest(bytes),
              },
            },
          };
          for (let offset = 0; offset < bytes.byteLength; offset += SESSION_GRPC_CHUNK_BYTES) {
            if (context.signal.aborted)
              throw new ConnectError("Session download cancelled", Code.Canceled);
            await sessions.execution(token);
            yield {
              frame: {
                case: "chunk",
                value: bytes.subarray(offset, offset + SESSION_GRPC_CHUNK_BYTES),
              },
            };
          }
        } catch (error) {
          throw sessionError(error);
        } finally {
          release();
        }
      },
    },
    {
      maxTimeoutMs: 60_000,
      readMaxBytes: SESSION_GRPC_CHUNK_BYTES + 1024,
      writeMaxBytes: SESSION_GRPC_CHUNK_BYTES + 1024,
    },
  );
}

function bearer(value: string | null): string | undefined {
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function sessionError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof TagMessagingError) {
    const code =
      {
        400: Code.InvalidArgument,
        401: Code.Unauthenticated,
        403: Code.PermissionDenied,
        404: Code.NotFound,
        409: Code.FailedPrecondition,
        413: Code.ResourceExhausted,
      }[error.statusCode] ?? Code.Internal;
    return new ConnectError(
      code === Code.Internal ? "Session persistence unavailable" : error.message,
      code,
    );
  }
  return new ConnectError("Session persistence unavailable", Code.Internal);
}
