import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  ExecuteRequestSchema,
  OperationReceiptSchema,
  OperationStatus,
  ProcessSnapshotSchema,
} from "./src/gen/supertag/environment/v1/environment_pb.js";
import {
  operationFromProto,
  operationToProto,
  receiptFromProto,
  receiptToProto,
  safeNumber,
  snapshotFromProto,
  snapshotToProto,
} from "./src/grpc-codec.js";

function roundTrip(body: Record<string, unknown>) {
  return operationFromProto(
    fromBinary(ExecuteRequestSchema, toBinary(ExecuteRequestSchema, operationToProto("op", body))),
  );
}

describe("execution protobuf codec", () => {
  it.each(["file.write", "file.stage", "process.input.write"])(
    "preserves binary bytes for %s",
    (kind) => {
      const body = {
        kind,
        ...(kind === "process.input.write" ? { processId: "process" } : { path: "binary" }),
        contentBase64: Buffer.from([0, 255, 128, 10, 13, 65]).toString("base64"),
      };
      expect(roundTrip(body)).toEqual(body);
    },
  );

  it("preserves absent optional fields and explicit false, zero, and empty values", () => {
    const file = { kind: "file.write", path: "x", contentBase64: "" };
    expect(roundTrip(file)).toEqual(file);
    expect(roundTrip({ ...file, mode: 0, exclusive: false })).toEqual({
      ...file,
      mode: 0,
      exclusive: false,
    });
    const process = { kind: "process.start", command: "node", args: [], environment: {} };
    expect(roundTrip(process)).toEqual(process);
    const explicit = { ...process, cwd: "", stdin: "", streamInput: false, timeoutMs: 0 };
    expect(roundTrip(explicit)).toEqual(explicit);
  });

  it.each([
    { kind: "file.write", path: "x", contentBase64: "not base64" },
    { kind: "file.write", path: "x", contentBase64: "", exclusive: "false" },
    { kind: "file.write", path: "x", contentBase64: "", mode: 0x100000000 },
    { kind: "process.start", command: "node", args: "ignored" },
    { kind: "process.start", command: "node", args: [2] },
    { kind: "process.start", command: "node", environment: null },
    { kind: "process.start", command: "node", environment: { SECRET: 2 } },
    { kind: "process.start", command: "node", streamInput: "false" },
    { kind: "process.start", command: "node", timeoutMs: 1.5 },
  ])("rejects invalid values instead of silently changing their meaning: %j", (body) => {
    expect(() => operationToProto("op", body)).toThrow();
  });

  it("rejects unknown operations and unsafe 64 bit integers", () => {
    expect(() => operationFromProto(create(ExecuteRequestSchema))).toThrow(
      "A supported operation is required",
    );
    expect(() => safeNumber(2n ** 64n - 1n)).toThrow("Integer exceeds supported range");
    expect(() => safeNumber(-1n)).toThrow();
    expect(safeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    { bytes: 0, created: false },
    { contentBase64: "AP8=", bytes: 2 },
    { bytes: 0 },
    { closed: false },
    { signalled: false },
    { exitCode: 0, stdout: "λ", stderr: "" },
    { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "stopped" },
  ])("preserves operation result variants: %j", (result) => {
    const body = { operationId: "op", status: "completed", result };
    const encoded = toBinary(OperationReceiptSchema, receiptToProto(body));
    expect(receiptFromProto(fromBinary(OperationReceiptSchema, encoded))).toEqual(body);
  });

  it("rejects unknown statuses and streams", () => {
    expect(() => receiptFromProto(create(OperationReceiptSchema, { status: 999 }))).toThrow(
      "Unknown operation status",
    );
    expect(() =>
      snapshotFromProto(
        create(ProcessSnapshotSchema, {
          status: OperationStatus.RUNNING,
          chunks: [{ stream: 999, sequence: 1n }],
        }),
      ),
    ).toThrow("Unknown output stream");
    expect(() =>
      snapshotToProto({
        processId: "process",
        status: "running",
        nextCursor: 1,
        chunks: [{ stream: "unknown", sequence: 1, text: "" }],
      }),
    ).toThrow(expect.objectContaining({ code: Code.DataLoss }));
  });
});
