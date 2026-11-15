export interface OutputFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
}
export interface OutputFileQuery {
  readonly roots: readonly string[];
  readonly maxFiles: number;
  /** Optional patterns relative to each root, pruned before unrelated directories are traversed. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}
