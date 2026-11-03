import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactVolumeReader } from "../apps/cli/src/artifact-volume.js";
import { artifactVolumeKeyDirectory } from "../packages/core/src/index.js";
import { FakeS3 } from "./support/fake-s3.ts";

const ACCESS_KEY = "AKIAVOLUMEREADER0001";
const SECRET_KEY = "volume-reader-secret-0123456789abcdef";
const secret = JSON.stringify({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function artifact(content: string | Buffer) {
  const bytes = Buffer.from(content);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hex}`;
  return {
    bytes,
    hex,
    ref: { uri: `supertag-artifact:${digest}`, digest, artifactId: "artifact-1", path: "a.bin" },
  };
}

describe("artifact Volume copy keys", () => {
  it("accepts only an Attempt-scoped key for this file's own digest", () => {
    const hex = "b".repeat(64);
    const digest = `sha256:${hex}`;
    expect(() => artifactVolumeKeyDirectory(`sha256/${hex}`, digest)).toThrow();
    expect(artifactVolumeKeyDirectory(`attempts/a-1/sha256/${hex}`, digest)).toBe("attempts/a-1");
    for (const key of [
      `sha256/${"c".repeat(64)}`,
      `../sha256/${hex}`,
      `attempts/../sha256/${hex}`,
      `./sha256/${hex}`,
      `/sha256/${hex}`,
      `attempts//sha256/${hex}`,
      `sha256/${hex}/x`,
      `other/${hex}`,
      `attempts\\x/sha256/${hex}`,
    ])
      expect(() => artifactVolumeKeyDirectory(key, digest), key).toThrow(
        "Artifact Volume copy key does not name this file's content",
      );
  });
});

describe("reading a copy on a shared Volume", () => {
  async function bucket() {
    const s3 = await FakeS3.start(ACCESS_KEY);
    cleanup.push(() => s3.close());
    s3.bucket("team");
    const source = `s3://team/hosts?region=us-east-1&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`;
    return { s3, source };
  }

  it("reads exactly the recorded key with this host's own mapping, verifying the digest", async () => {
    const { s3, source } = await bucket();
    const { bytes, hex, ref } = artifact(randomBytes(4096));
    s3.put("team", `hosts/attempts/a-1/sha256/${hex}`, bytes);
    // A copy of the same content at another key is never touched.
    s3.put("team", `hosts/sha256/${hex}`, bytes);
    const credentials: string[] = [];
    const read = artifactVolumeReader({
      readVolumeCredential: async (name) => {
        credentials.push(name);
        return secret;
      },
    });
    const location = {
      volume: "shared",
      source,
      credential: "team-artifacts",
      key: `attempts/a-1/sha256/${hex}`,
    };
    await expect(read(location, ref, bytes.byteLength)).resolves.toEqual(bytes);
    expect(s3.requests.map((request) => [request.method, request.key])).toEqual([
      ["GET", `hosts/attempts/a-1/sha256/${hex}`],
    ]);
    expect(new Set(s3.requests.map((request) => request.accessKeyId))).toEqual(
      new Set([ACCESS_KEY]),
    );
    expect(new Set(credentials)).toEqual(new Set(["team-artifacts"]));

    // Bytes at the key that do not match the entry are refused, not returned.
    s3.put("team", `hosts/attempts/a-2/sha256/${hex}`, Buffer.from("tampered"));
    await expect(
      read({ ...location, key: `attempts/a-2/sha256/${hex}` }, ref, bytes.byteLength),
    ).rejects.toThrow("Artifact digest mismatch");
    // A key that names other content is refused before any request.
    const before = s3.requests.length;
    await expect(
      read({ ...location, key: `sha256/${"d".repeat(64)}` }, ref, bytes.byteLength),
    ).rejects.toThrow("does not name this file's content");
    expect(s3.requests.length).toBe(before);
  });

  it("reads nothing from a Volume this host does not map", async () => {
    const { s3, source } = await bucket();
    const { bytes, hex, ref } = artifact("unmapped");
    s3.put("team", `hosts/attempts/a-1/sha256/${hex}`, bytes);
    const location = {
      volume: "shared",
      source,
      credential: "team-artifacts",
      key: `attempts/a-1/sha256/${hex}`,
    };
    // A host service without a volume-credentials entry for the credential.
    const unmapped = artifactVolumeReader({
      readVolumeCredential: async (name) => {
        throw new Error(`no volume-credentials mapping for ${name}`);
      },
    });
    await expect(unmapped(location, ref, bytes.byteLength)).resolves.toBeUndefined();
    // A connected Worklet reads only its own artifact Volume with its credential file.
    const otherWorklet = artifactVolumeReader({
      artifactVolume: { name: "mine", readCredential: async () => secret },
    });
    await expect(otherWorklet(location, ref, bytes.byteLength)).resolves.toBeUndefined();
    const sameWorklet = artifactVolumeReader({
      artifactVolume: { name: "shared", readCredential: async () => secret },
    });
    await expect(sameWorklet(location, ref, bytes.byteLength)).resolves.toEqual(bytes);
    expect(s3.requests.filter((request) => request.method === "GET")).toHaveLength(1);
  });

  it("names the Volume and the provider's code in errors, never the credential", async () => {
    const { s3, source } = await bucket();
    const { bytes, hex, ref } = artifact("echo");
    s3.put("team", `hosts/attempts/a-1/sha256/${hex}`, bytes);
    s3.echoError = "SignatureDoesNotMatch";
    const read = artifactVolumeReader({ readVolumeCredential: async () => secret });
    const failure = await read(
      { volume: "shared", source, credential: "team-artifacts", key: `attempts/a-1/sha256/${hex}` },
      ref,
      bytes.byteLength,
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/^Artifact Volume shared request failed/u);
    const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure ?? {}));
    expect(text).not.toContain(ACCESS_KEY);
    expect(text).not.toContain(SECRET_KEY);
  });

  it("reads a file:// copy inside the consent directory, and refuses a key directory that leaves it", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-volume-reader-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const consent = join(root, "shared");
    const volume = join(consent, "artifacts");
    const outside = join(root, "outside");
    const { bytes, hex, ref } = artifact("file copy");
    await mkdir(join(volume, "attempts", "a-1", "sha256"), { recursive: true });
    await writeFile(join(volume, "attempts", "a-1", "sha256", hex), bytes);
    await mkdir(join(outside, "sha256"), { recursive: true });
    await writeFile(join(outside, "sha256", hex), bytes);
    await mkdir(join(volume, "attempts"), { recursive: true });
    await symlink(outside, join(volume, "attempts", "escape"));
    const read = artifactVolumeReader({ readVolumeCredential: async () => ({ path: consent }) });
    const location = {
      volume: "shared",
      source: `file://${volume}`,
      credential: "shared-dir",
      key: `attempts/a-1/sha256/${hex}`,
    };
    await expect(read(location, ref, bytes.byteLength)).resolves.toEqual(bytes);
    await expect(
      read({ ...location, key: `attempts/escape/sha256/${hex}` }, ref, bytes.byteLength),
    ).rejects.toThrow("outside its consent directory");
    // A missing copy creates nothing on the shared Volume.
    const missing = artifact("not there");
    await expect(
      read({ ...location, key: `attempts/a-3/sha256/${missing.hex}` }, missing.ref, 9),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(volume, "attempts"))).sort()).toEqual(["a-1", "escape"]);
  });
});
