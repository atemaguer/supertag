import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { SessionStateRef } from "@supertag/worker-sdk";
import { type SessionRef, SessionRefSchema } from "./gen/supertag/session/v1/session_pb.js";

export * from "./gen/supertag/session/v1/session_pb.js";

export const SESSION_GRPC_CHUNK_BYTES = 256 * 1024;
export const SESSION_GRPC_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const SESSION_GRPC_MAX_METADATA_BYTES = 64 * 1024;

export function encodeSessionRef(ref: SessionStateRef): SessionRef {
  const result = create(SessionRefSchema, {
    id: ref.id,
    uri: ref.uri,
    format: ref.format,
    ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    ...(ref.artifactId === undefined ? {} : { artifactId: ref.artifactId }),
    ...(ref.path === undefined ? {} : { path: ref.path }),
    ...(ref.provenance === undefined
      ? {}
      : { provenanceJson: Buffer.from(JSON.stringify(ref.provenance), "utf8") }),
  });
  decodeSessionRef(result);
  return result;
}

export function decodeSessionRef(ref: SessionRef | undefined): SessionStateRef {
  if (!ref?.id.trim() || !ref.uri.trim() || !ref.format.trim())
    throw new ConnectError("Invalid native Session reference", Code.InvalidArgument);
  if (toBinary(SessionRefSchema, ref).byteLength > SESSION_GRPC_MAX_METADATA_BYTES)
    throw new ConnectError("Session metadata exceeds 64 KiB", Code.ResourceExhausted);
  let provenance: Record<string, unknown> | undefined;
  if (ref.provenanceJson !== undefined) {
    provenance = decodeJsonObject(ref.provenanceJson);
  }
  return {
    id: ref.id,
    uri: ref.uri,
    format: ref.format,
    ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    ...(ref.artifactId === undefined ? {} : { artifactId: ref.artifactId }),
    ...(ref.path === undefined ? {} : { path: ref.path }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

export function encodeSessionArchive(data: Readonly<Record<string, unknown>>): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(JSON.stringify(data), "utf8");
  } catch {
    throw new ConnectError("Invalid native Session JSON", Code.InvalidArgument);
  }
  decodeSessionArchive(bytes);
  return bytes;
}

export function decodeSessionArchive(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > SESSION_GRPC_MAX_ARCHIVE_BYTES)
    throw new ConnectError("Session state exceeds 16 MiB", Code.ResourceExhausted);
  return decodeJsonObject(bytes);
}

export function sessionArchiveDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Keep malformed payloads and implementation details out of error text.
  }
  throw new ConnectError("Invalid native Session JSON object", Code.InvalidArgument);
}
