import type { WorkerProfileRef as CoreWorkerProfileRef } from "./domain/index.js";

export interface CapabilityIdentifier {
  readonly id: string;
  readonly version: number;
}

export type WorkerProfileRef = CoreWorkerProfileRef;
