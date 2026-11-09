import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type ToolDocument,
  ToolDocumentSchema,
} from "./gen/supertag/coordination/v1/coordination_pb.js";

export * from "./gen/supertag/coordination/v1/coordination_pb.js";
export const COORDINATION_GRPC_MAX_INPUT_BYTES = 128_000;
export const COORDINATION_GRPC_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
export function encodeCoordinationDocument(value: unknown): ToolDocument {
  let json: Uint8Array;
  try {
    json = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new ConnectError("Invalid coordination document", Code.InvalidArgument);
  }
  const result = create(ToolDocumentSchema, { version: 1, json });
  decodeCoordinationDocument(result);
  return result;
}
export function decodeCoordinationDocument(
  value: ToolDocument | undefined,
): Record<string, unknown> {
  if (value?.version !== 1)
    throw new ConnectError("Unsupported coordination document version", Code.InvalidArgument);
  if (value.json.length > COORDINATION_GRPC_MAX_INPUT_BYTES)
    throw new ConnectError("Coordination document exceeds limit", Code.ResourceExhausted);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value.json));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* Do not include payloads in errors. */
  }
  throw new ConnectError("Coordination document must be a JSON object", Code.InvalidArgument);
}
