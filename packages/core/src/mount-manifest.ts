/** A regular file under a copied mount. The caller must exclude symlinks before listing. */
export interface MountUploadFile {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface MountOutputManifest {
  readonly volume: string;
  readonly source: string;
  readonly path: string;
  readonly status: "complete" | "partial" | "refused";
  readonly uploadedAt: string;
  /** Successfully uploaded objects only. */
  readonly objects: readonly MountUploadFile[];
  readonly skipped: number;
  /** Failed key and reason, including a refused bound. */
  readonly error?: { readonly key: string; readonly reason: string };
  /** Changed keys not uploaded, including the failed key. */
  readonly notAttempted: readonly string[];
}
