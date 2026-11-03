export type WorkerHostEnrollmentStatus = "active" | "revoked";
export type WorkerHostConnectionStatus = "connected" | "disconnected";

/** Durable identity and latest observed state for an existing Worker Host resource. */
export interface WorkerHost {
  readonly id: string;
  /** Non-secret address of the enrollment credential in the configured credential vault. */
  readonly credentialId: string;
  /** Monotonic credential revision used to reject an enrollment superseded by rotation. */
  readonly credentialRevision: number;
  readonly enrollmentStatus: WorkerHostEnrollmentStatus;
  /**
   * An ephemeral host joined with an ephemeral Auth Key. After it disconnects with no open Task
   * Attempts, the Control Plane revokes it and hides it from default lists.
   */
  readonly ephemeral: boolean;
  /** Name of the Auth Key this host redeemed to join, when it joined that way. */
  readonly authKey?: string;
  /** Monotonic connection fence. Only the current generation may report or disconnect. */
  readonly connectionGeneration: number;
  readonly connectionStatus: WorkerHostConnectionStatus;
  readonly workletId?: string;
  readonly protocolVersion?: number;
  readonly durableProtocolVersion?: number;
  readonly controlProtocolVersion?: number;
  /** Provider-neutral snapshot of the Workers and capabilities advertised by the Worklet. */
  readonly workerSnapshot: Readonly<Record<string, unknown>>;
  /**
   * Placement labels: those the host advertised in its latest snapshot plus {@link grantedLabels}.
   * Advertised labels are self-reported; they place work and never grant access.
   */
  readonly labels: readonly string[];
  /** Labels granted by the Auth Key this host redeemed. */
  readonly grantedLabels: readonly string[];
  readonly capacity: number;
  readonly availableSlots: number;
  readonly activeAttempts: number;
  readonly ready: boolean;
  readonly draining: boolean;
  /** Last time an enrolled credential successfully claimed a connection generation. */
  readonly lastAuthenticatedAt?: string;
  /** Cumulative rejected credential claims for this enrolled host identity. */
  readonly failedAuthenticationCount: number;
  readonly lastAuthenticationFailureAt?: string;
  readonly lastSeenAt?: string;
  readonly connectedAt?: string;
  readonly disconnectedAt?: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnrollWorkerHostInput {
  readonly id: string;
  readonly credentialId: string;
  readonly enrolledAt: string;
}

export interface RotateWorkerHostCredentialInput {
  readonly workerHostId: string;
  readonly expectedCredentialRevision: number;
  readonly credentialId: string;
  readonly rotatedAt: string;
}

export interface RevokeWorkerHostInput {
  readonly workerHostId: string;
  readonly revokedAt: string;
  readonly reason?: string;
}

export interface WorkerHostObservation {
  readonly workletId: string;
  readonly protocolVersion: number;
  readonly durableProtocolVersion?: number;
  readonly controlProtocolVersion?: number;
  readonly workerSnapshot: Readonly<Record<string, unknown>>;
  readonly capacity: number;
  readonly availableSlots: number;
  readonly activeAttempts: number;
  readonly ready: boolean;
  readonly observedAt: string;
}

export interface ClaimWorkerHostConnectionInput extends WorkerHostObservation {
  readonly workerHostId: string;
  readonly credentialRevision: number;
}

export interface UpdateWorkerHostObservationInput extends WorkerHostObservation {
  readonly workerHostId: string;
  readonly connectionGeneration: number;
}

export interface ReleaseWorkerHostConnectionInput {
  readonly workerHostId: string;
  readonly connectionGeneration: number;
  readonly disconnectedAt: string;
}

export interface WorkerHostObservationResult {
  readonly draining: boolean;
}

export interface WorkerHostStore {
  enrollWorkerHost(input: EnrollWorkerHostInput): Promise<WorkerHost>;
  findWorkerHostById(id: string): Promise<WorkerHost | undefined>;
  listWorkerHosts(): Promise<readonly WorkerHost[]>;
  /** Rotates enrollment authority and fences any connection authenticated by the old revision. */
  rotateWorkerHostCredential(
    input: RotateWorkerHostCredentialInput,
  ): Promise<WorkerHost | undefined>;
  /** Revocation is idempotent and immediately fences the current connection generation. */
  revokeWorkerHost(input: RevokeWorkerHostInput): Promise<WorkerHost | undefined>;
  /** Persistently drain or resume an active Host independently of its current connection. */
  setWorkerHostDraining(
    workerHostId: string,
    draining: boolean,
    updatedAt: string,
  ): Promise<WorkerHost | undefined>;
  /** Atomically claims the next connection generation, or returns undefined when unauthorized. */
  claimWorkerHostConnection(input: ClaimWorkerHostConnectionInput): Promise<WorkerHost | undefined>;
  /** Durably records a rejected credential claim for a known enrolled Host. */
  recordWorkerHostAuthenticationFailure(workerHostId: string, failedAt: string): Promise<boolean>;
  /** Applies an observation and returns authoritative Host state while this generation owns it. */
  updateWorkerHostObservation(
    input: UpdateWorkerHostObservationInput,
  ): Promise<WorkerHostObservationResult | undefined>;
  /** Marks the Host disconnected only while this connection generation still owns it. */
  releaseWorkerHostConnection(input: ReleaseWorkerHostConnectionInput): Promise<boolean>;
}
