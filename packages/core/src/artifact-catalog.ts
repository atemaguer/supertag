/** Exact immutable files selected from a captured artifact. */
export interface ArtifactSelection {
  readonly artifactId: string;
  readonly paths: readonly string[];
}
