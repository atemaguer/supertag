import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactStore, MAX_ARTIFACT_BYTES } from "./src/artifact-store.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "supertag-local-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("persistent local artifact storage", () => {
  it("survives restart and 100 concurrent idempotent captures without partial or duplicate blobs", async () => {
    const directory = resolve(await fixture(), "artifacts");
    const bytes = Buffer.from("durable report");
    const refs = await Promise.all(
      Array.from({ length: 100 }, () =>
        new FileArtifactStore(directory).put({ bytes, name: "../../report.md" }),
      ),
    );
    const ref = refs[0];
    if (!ref) throw new Error("Missing reference");
    expect(new Set(refs.map((ref) => ref.uri)).size).toBe(1);
    expect(await new FileArtifactStore(directory).get(ref)).toEqual(bytes);
    expect(await readdir(resolve(directory, "sha256"))).toEqual([ref.id]);
    expect(JSON.stringify(ref)).not.toContain(directory);
  });
  it("does not read or overwrite corrupt content, symlinks, or malformed references", async () => {
    const root = await fixture();
    const store = new FileArtifactStore(resolve(root, "artifacts"));
    const ref = await store.put({ bytes: Buffer.from("original") });
    await expect(store.get({ ...ref, uri: "../../outside" })).rejects.toThrow("Invalid artifact");
    const path = resolve(store.directory, "sha256", ref.id);
    await writeFile(path, "corrupt");
    await expect(store.get(ref)).rejects.toThrow("digest mismatch");
    await expect(store.put({ bytes: Buffer.from("original") })).rejects.toThrow("digest mismatch");
    await unlink(path);
    const outside = resolve(root, "outside");
    await writeFile(outside, "original");
    await symlink(outside, path);
    await expect(store.get(ref)).rejects.toThrow();
    await expect(store.put({ bytes: Buffer.from("original") })).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("original");
    expect(
      (await readdir(resolve(store.directory, "sha256"))).filter((name) =>
        name.startsWith(".upload"),
      ),
    ).toEqual([]);
  });
  it("rejects symlink storage roots and content directories", async () => {
    const root = await fixture();
    const target = resolve(root, "target");
    await mkdir(target);
    const directory = resolve(root, "artifacts");
    await symlink(target, directory);
    await expect(
      new FileArtifactStore(directory).put({ bytes: Buffer.from("no") }),
    ).rejects.toThrow("symlink");
    await unlink(directory);
    await mkdir(directory);
    await symlink(target, resolve(directory, "sha256"));
    await expect(
      new FileArtifactStore(directory).put({ bytes: Buffer.from("no") }),
    ).rejects.toThrow("symlink");
    expect(await readdir(target)).toEqual([]);
  });
  it("bounds content and never substitutes missing bytes", async () => {
    const store = new FileArtifactStore(await fixture());
    await expect(store.put({ bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1) })).rejects.toThrow(
      "32 MiB",
    );
    const ref = await store.put({ bytes: Buffer.from("small") });
    const path = resolve(store.directory, "sha256", ref.id);
    await writeFile(path, new Uint8Array(MAX_ARTIFACT_BYTES + 1));
    await expect(store.get(ref)).rejects.toThrow("32 MiB");
    await unlink(path);
    await expect(store.get(ref)).rejects.toThrow("ENOENT");
  });
});
