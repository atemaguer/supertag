import type { WorkerProfileRef as CoreWorkerProfileRef } from "@supertag/core";

export interface CapabilityIdentifier {
  readonly id: string;
  readonly version: number;
}

export type WorkerProfileRef = CoreWorkerProfileRef;
