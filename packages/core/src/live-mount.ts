/** A live source attached at Task start, not a snapshot or an object manifest. */
export interface LiveMount {
  readonly volume: string;
  /** The configured source URL, without credentials. */
  readonly source: string;
  /** The source's key prefix; empty when the entire source is mounted. */
  readonly prefix: string;
  readonly path: string;
  readonly strategy: "mount";
  readonly access: "read-only" | "read-write";
  /** When the provider successfully attached the source, in ISO 8601 UTC. */
  readonly attachedAt: string;
}
