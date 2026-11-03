/** Reusable conformance probes for third-party Worker and Harness implementations. */
export * from "../../runtime/sdk/src/conformance.js";

import type { ConformanceFinding, ConformanceReport } from "../../runtime/sdk/src/conformance.js";
import type { Surface } from "../../surfaces/sdk/src/index.js";

export interface SurfaceConformanceOptions {
  readonly surface: Surface;
  /** Maximum time allowed for start() or stop(); defaults to two seconds. */
  readonly lifecycleTimeoutMs?: number;
}

export interface WorkletTransportConformanceOptions {
  readonly workletProtocolVersions: readonly number[];
  readonly controlPlaneProtocolVersions: readonly number[];
  /** Supply an independent implementation to verify; defaults to protocol 18 selection. */
  readonly negotiate?: (
    offered: readonly number[],
    supported: readonly number[],
  ) => number | undefined;
}

/** Exercises a Surface's identity and reversible lifecycle. */
export async function runSurfaceConformance(
  options: SurfaceConformanceOptions,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  const { surface } = options;
  const timeoutMs = options.lifecycleTimeoutMs ?? 2_000;
  if (surface.identity.id.trim().length === 0) {
    findings.push({ code: "surface.identity.id", message: "Surface id must not be empty" });
  }
  if (surface.identity.displayName.trim().length === 0) {
    findings.push({
      code: "surface.identity.display-name",
      message: "Surface display name must not be empty",
    });
  }

  let started = false;
  try {
    await settleWithin(surface.start(), timeoutMs, "Surface start()");
    started = true;
  } catch (error) {
    findings.push({
      code: "surface.start.threw",
      message: `start() failed: ${errorMessage(error)}`,
    });
  } finally {
    if (started) {
      try {
        await settleWithin(surface.stop(), timeoutMs, "Surface stop()");
      } catch (error) {
        findings.push({
          code: "surface.stop.threw",
          message: `stop() failed: ${errorMessage(error)}`,
        });
      }
    }
  }

  return {
    subject: `Surface ${surface.identity.id || "<unknown>"}`,
    passed: findings.length === 0,
    findings,
  };
}

/** Verifies that a transport implementation accepts only protocol 18. */
export function runWorkletTransportConformance(
  options: WorkletTransportConformanceOptions,
): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  validateVersionList("worklet", options.workletProtocolVersions, findings);
  validateVersionList("control-plane", options.controlPlaneProtocolVersions, findings);
  if (findings.length === 0) {
    const expected =
      options.workletProtocolVersions.length === 1 &&
      options.workletProtocolVersions[0] === 18 &&
      options.controlPlaneProtocolVersions.length === 1 &&
      options.controlPlaneProtocolVersions[0] === 18
        ? 18
        : undefined;
    const actual = (options.negotiate ?? (() => expected))(
      options.workletProtocolVersions,
      options.controlPlaneProtocolVersions,
    );
    if (actual !== expected) {
      findings.push({
        code: "transport.negotiation.selection",
        message: `Transport selected ${actual ?? "no version"}; expected ${expected ?? "no version"}`,
      });
    }
  }
  return { subject: "Worklet transport negotiation", passed: findings.length === 0, findings };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateVersionList(
  peer: string,
  versions: readonly number[],
  findings: ConformanceFinding[],
): void {
  if (versions.length === 0) {
    findings.push({
      code: `transport.${peer}.versions.empty`,
      message: `${peer} must advertise at least one protocol version`,
    });
  }
  if (versions.some((version) => !Number.isInteger(version) || version < 1)) {
    findings.push({
      code: `transport.${peer}.versions.invalid`,
      message: `${peer} protocol versions must be positive integers`,
    });
  }
  if (new Set(versions).size !== versions.length) {
    findings.push({
      code: `transport.${peer}.versions.duplicate`,
      message: `${peer} protocol versions must be unique`,
    });
  }
  if (versions.length !== 1 || versions[0] !== 18) {
    findings.push({
      code: `transport.${peer}.versions.unsupported`,
      message: `${peer} must advertise only protocol 18`,
    });
  }
}
