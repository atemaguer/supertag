import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactRef,
  type ArtifactStore,
  MAX_ARTIFACT_BYTES,
  type ResourceRef,
} from "../../packages/runtime/sdk/src/index.js";
/** Test fixture only. Production artifact bytes use cloud blob storage. */
export class FileArtifactStore implements ArtifactStore {
  constructor(readonly directory: string) {}
  async put(input: {
    readonly bytes: Uint8Array;
    readonly name?: string;
    readonly mediaType?: string;
  }): Promise<ArtifactRef> {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact exceeds 32 MiB limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    try {
      await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(this.directory, digest));
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      id: digest,
      uri: `supertag-artifact:sha256:${digest}`,
      digest: `sha256:${digest}`,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    };
  }
  async get(ref: ResourceRef): Promise<Uint8Array> {
    const match = /^supertag-artifact:sha256:([a-f0-9]{64})$/u.exec(ref.uri);
    const digest = match?.[1];
    if (!digest || ref.digest !== `sha256:${digest}`)
      throw new Error("Invalid artifact reference or digest");
    const path = join(this.directory, digest),
      metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ARTIFACT_BYTES)
      throw new Error("Invalid artifact file");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Artifact digest mismatch");
    return bytes;
  }
}
