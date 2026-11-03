import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type ExecuteRequest,
  ExecuteRequestSchema,
  type OperationReceipt,
  OperationReceiptSchema,
  OperationStatus,
  OutputStream,
  ProcessResultSchema,
  type ProcessSnapshot,
  ProcessSnapshotSchema,
} from "./gen/supertag/environment/v1/environment_pb.js";

export const WIRE_LIMIT = 2 * 1024 * 1024;
const statuses = {
  accepted: OperationStatus.ACCEPTED,
  running: OperationStatus.RUNNING,
  completed: OperationStatus.COMPLETED,
  failed: OperationStatus.FAILED,
  uncertain: OperationStatus.UNCERTAIN,
} as const;
export function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConnectError("Integer exceeds supported range", Code.OutOfRange);
  return Number(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectError("Expected an object", Code.InvalidArgument);
  return value as Record<string, unknown>;
}
export function integer(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ConnectError("Expected a nonnegative safe integer", Code.InvalidArgument);
  return BigInt(value);
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new ConnectError("Expected a string", Code.InvalidArgument);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new ConnectError("Expected a boolean", Code.InvalidArgument);
  return value;
}
function bytes(value: unknown): Buffer {
  const encoded = text(value);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded)
    throw new ConnectError("Expected canonical base64", Code.InvalidArgument);
  return decoded;
}
function uint32(value: unknown): number {
  const n = safeNumber(integer(value));
  if (n > 0xffffffff) throw new ConnectError("Integer exceeds uint32 range", Code.OutOfRange);
  return n;
}
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConnectError("Expected string array", Code.InvalidArgument);
  return value.map(text);
}
function outputStream(value: unknown): OutputStream {
  if (value === "stdout") return OutputStream.STDOUT;
  if (value === "stderr") return OutputStream.STDERR;
  throw new ConnectError("Unknown output stream", Code.DataLoss);
}
export function operationFromProto(request: ExecuteRequest): Record<string, unknown> {
  const op = request.operation;
  switch (op.case) {
    case "writeFile":
    case "stageFile":
      return {
        kind: op.case === "writeFile" ? "file.write" : "file.stage",
        path: op.value.path,
        contentBase64: Buffer.from(op.value.content).toString("base64"),
        ...(op.value.exclusive === undefined ? {} : { exclusive: op.value.exclusive }),
        ...(op.value.mode === undefined ? {} : { mode: op.value.mode }),
      };
    case "readFile":
      return {
        kind: "file.read",
        path: op.value.path,
        maximumBytes: safeNumber(op.value.maximumBytes),
      };
    case "startProcess":
      return {
        kind: "process.start",
        command: op.value.command,
        args: op.value.args,
        environment: op.value.environment,
        ...(op.value.cwd === undefined ? {} : { cwd: op.value.cwd }),
        ...(op.value.stdin === undefined ? {} : { stdin: op.value.stdin }),
        ...(op.value.streamInput === undefined ? {} : { streamInput: op.value.streamInput }),
        ...(op.value.timeoutMs === undefined ? {} : { timeoutMs: safeNumber(op.value.timeoutMs) }),
      };
    case "writeProcessInput":
      return {
        kind: "process.input.write",
        processId: op.value.processId,
        contentBase64: Buffer.from(op.value.content).toString("base64"),
      };
    case "closeProcessInput":
      return { kind: "process.input.close", processId: op.value.processId };
    case "signalProcess":
      return {
        kind: "process.signal",
        processId: op.value.processId,
        ...(op.value.signal === undefined ? {} : { signal: op.value.signal }),
      };
    default:
      throw new ConnectError("A supported operation is required", Code.InvalidArgument);
  }
}
export function operationToProto(
  operationId: string,
  body: Record<string, unknown>,
): ExecuteRequest {
  const kind = body["kind"];
  switch (kind) {
    case "file.write":
    case "file.stage":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: {
          case: kind === "file.write" ? "writeFile" : "stageFile",
          value: {
            path: text(body["path"]),
            content: bytes(body["contentBase64"]),
            ...(body["exclusive"] === undefined ? {} : { exclusive: boolean(body["exclusive"]) }),
            ...(body["mode"] === undefined ? {} : { mode: uint32(body["mode"]) }),
          },
        },
      });
    case "file.read":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: {
          case: "readFile",
          value: { path: text(body["path"]), maximumBytes: integer(body["maximumBytes"]) },
        },
      });
    case "process.start":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: {
          case: "startProcess",
          value: {
            command: text(body["command"]),
            args: strings(body["args"]),
            environment: Object.fromEntries(
              Object.entries(
                record(body["environment"] === undefined ? {} : body["environment"]),
              ).map(([key, value]) => [key, text(value)]),
            ),
            ...(body["cwd"] === undefined ? {} : { cwd: text(body["cwd"]) }),
            ...(body["stdin"] === undefined ? {} : { stdin: text(body["stdin"]) }),
            ...(body["streamInput"] === undefined
              ? {}
              : { streamInput: boolean(body["streamInput"]) }),
            ...(body["timeoutMs"] === undefined ? {} : { timeoutMs: integer(body["timeoutMs"]) }),
          },
        },
      });
    case "process.input.write":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: {
          case: "writeProcessInput",
          value: {
            processId: text(body["processId"]),
            content: bytes(body["contentBase64"]),
          },
        },
      });
    case "process.input.close":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: { case: "closeProcessInput", value: { processId: text(body["processId"]) } },
      });
    case "process.signal":
      return create(ExecuteRequestSchema, {
        operationId,
        operation: {
          case: "signalProcess",
          value: {
            processId: text(body["processId"]),
            ...(body["signal"] === undefined ? {} : { signal: text(body["signal"]) }),
          },
        },
      });
    default:
      throw new ConnectError("Unsupported execution operation", Code.InvalidArgument);
  }
}
function status(value: unknown): OperationStatus {
  const status = statuses[value as keyof typeof statuses];
  if (status === undefined) throw new ConnectError("Unknown operation status", Code.DataLoss);
  return status;
}
function statusText(value: OperationStatus): string {
  const entry = Object.entries(statuses).find(([, status]) => status === value);
  if (!entry) throw new ConnectError("Unknown operation status", Code.DataLoss);
  return entry[0];
}
function processResult(value: unknown) {
  const result = record(value);
  return create(ProcessResultSchema, {
    ...(result["exitCode"] === null || result["exitCode"] === undefined
      ? {}
      : { exitCode: Number(result["exitCode"]) }),
    ...(result["signal"] === undefined ? {} : { signal: text(result["signal"]) }),
    stdout: text(result["stdout"]),
    stderr: text(result["stderr"]),
  });
}
export function receiptToProto(body: Record<string, unknown>): OperationReceipt {
  const receipt = create(OperationReceiptSchema, {
    operationId: text(body["operationId"]),
    status: status(body["status"]),
    ...(body["processId"] === undefined ? {} : { processId: text(body["processId"]) }),
    ...(body["error"] === undefined ? {} : { error: text(body["error"]) }),
  });
  if (body["result"] !== undefined) {
    const r = record(body["result"]);
    if ("exitCode" in r) receipt.result = { case: "processResult", value: processResult(r) };
    else if ("contentBase64" in r)
      receipt.result = {
        case: "fileContent",
        value: {
          $typeName: "supertag.environment.v1.FileContent",
          content: Buffer.from(text(r["contentBase64"]), "base64"),
          bytes: integer(r["bytes"]),
        },
      };
    else if ("created" in r)
      receipt.result = {
        case: "fileWritten",
        value: {
          $typeName: "supertag.environment.v1.FileWritten",
          bytes: integer(r["bytes"]),
          created: r["created"] === true,
        },
      };
    else if ("bytes" in r)
      receipt.result = {
        case: "inputWritten",
        value: { $typeName: "supertag.environment.v1.InputWritten", bytes: integer(r["bytes"]) },
      };
    else if ("closed" in r)
      receipt.result = {
        case: "inputClosed",
        value: { $typeName: "supertag.environment.v1.InputClosed", closed: r["closed"] === true },
      };
    else if ("signalled" in r)
      receipt.result = {
        case: "processSignalled",
        value: {
          $typeName: "supertag.environment.v1.ProcessSignalled",
          signalled: r["signalled"] === true,
        },
      };
    else throw new ConnectError("Unsupported operation result", Code.DataLoss);
  }
  return receipt;
}
export function receiptFromProto(value: OperationReceipt): Record<string, unknown> {
  const r = value.result;
  let result: Record<string, unknown> | undefined;
  switch (r.case) {
    case "processResult":
      result = {
        exitCode: r.value.exitCode ?? null,
        ...(r.value.signal === undefined ? {} : { signal: r.value.signal }),
        stdout: r.value.stdout,
        stderr: r.value.stderr,
      };
      break;
    case "fileContent":
      result = {
        contentBase64: Buffer.from(r.value.content).toString("base64"),
        bytes: safeNumber(r.value.bytes),
      };
      break;
    case "fileWritten":
      result = { bytes: safeNumber(r.value.bytes), created: r.value.created };
      break;
    case "inputWritten":
      result = { bytes: safeNumber(r.value.bytes) };
      break;
    case "inputClosed":
      result = { closed: r.value.closed };
      break;
    case "processSignalled":
      result = { signalled: r.value.signalled };
      break;
  }
  return {
    operationId: value.operationId,
    status: statusText(value.status),
    ...(value.processId === undefined ? {} : { processId: value.processId }),
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(result === undefined ? {} : { result }),
  };
}
export function snapshotToProto(body: Record<string, unknown>): ProcessSnapshot {
  return create(ProcessSnapshotSchema, {
    processId: text(body["processId"]),
    status: status(body["status"]),
    nextCursor: integer(body["nextCursor"]),
    chunks: (Array.isArray(body["chunks"]) ? body["chunks"] : []).map((chunk) => {
      const c = record(chunk);
      return {
        sequence: integer(c["sequence"]),
        stream: outputStream(c["stream"]),
        text: text(c["text"]),
      };
    }),
    ...(body["result"] === undefined ? {} : { result: processResult(body["result"]) }),
    ...(body["error"] === undefined ? {} : { error: text(body["error"]) }),
  });
}
export function snapshotFromProto(value: ProcessSnapshot): Record<string, unknown> {
  return {
    processId: value.processId,
    status: statusText(value.status),
    nextCursor: safeNumber(value.nextCursor),
    chunks: value.chunks.map((chunk) => {
      if (![OutputStream.STDOUT, OutputStream.STDERR].includes(chunk.stream))
        throw new ConnectError("Unknown output stream", Code.DataLoss);
      return {
        sequence: safeNumber(chunk.sequence),
        stream: chunk.stream === OutputStream.STDOUT ? "stdout" : "stderr",
        text: chunk.text,
      };
    }),
    ...(value.result === undefined
      ? {}
      : {
          result: {
            exitCode: value.result.exitCode ?? null,
            ...(value.result.signal === undefined ? {} : { signal: value.result.signal }),
            stdout: value.result.stdout,
            stderr: value.result.stderr,
          },
        }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}
