import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostVolumeResolver } from "../apps/cli/src/host-volumes.js";
import { describeVolume } from "../apps/cli/src/resources.js";
import {
  MAX_MOUNT_OBJECTS,
  type MountManifest,
  mountManifestDigest,
  parseMountManifests,
  type WorkspaceMount,
} from "../packages/core/src/index.js";
import {
  copyWorkspaceMount,
  copyWorkspaceMounts,
  HostVolumeCopyTarget,
  mountRelativeKey,
  type ResolvedVolume,
  type VolumeCredentials,
} from "../packages/runtime/sdk/src/index.js";
import {
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { CopyBudget, pinWorkspaceVolumes } from "../packages/runtime/sdk/src/volume-copy.js";
import { FakeS3 } from "./support/fake-s3.ts";
import { removeSealedTree } from "./support/sealed-tree.ts";

// Scratch directories live in the system temporary directory, which a real Worker Host refuses
// for local copies; tests/volume-copy-races.test.ts checks that refusal.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

const SECRET = "volume-secret-canary-0b9f4d";
const ACCESS_KEY = "volume-access-key-canary";

describe("Volume copy mounts", () => {
  let budget: CopyBudget;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  const copyTarget = (...args: ConstructorParameters<typeof HostVolumeCopyTarget>) =>
    new HostVolumeCopyTarget(args[0], args[1], localMountRoot);
  let s3: FakeS3;

  beforeEach(async () => {
    budget = new CopyBudget();
    scratch = await mkdtemp(join(tmpdir(), "supertag-volume-copy-"));
    localMountRoot = await resolveLocalMountRoot(scratch);
    s3 = await FakeS3.start(ACCESS_KEY);
  });
  afterEach(async () => {
    await s3.close();
    await removeSealedTree(scratch);
  });

  const credentials = (): VolumeCredentials => ({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
  });
  const s3Volume = (source = "s3://data/datasets/v3"): ResolvedVolume => ({
    volume: "datasets",
    source: `${source}?region=eu-west-2&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
    credentials: async () => credentials(),
  });
  const mountAt = (path: string, maxBytes?: number): WorkspaceMount => ({
    volume: "datasets",
    path,
    access: "read-only",
    strategy: "copy",
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  const copy = (volume: ResolvedVolume, mount = mountAt(join(scratch, "mnt", "data"))) =>
    copyWorkspaceMount({ budget, mount, volume, target: copyTarget() });

  it("copies an S3 prefix read-only through a real S3 client and records its manifest", async () => {
    s3.pageSize = 2;
    s3.put("data", "datasets/v3/a.csv", "a,b\n1,2\n");
    s3.put("data", "datasets/v3/nested/b.json", '{"ok":true}');
    s3.put("data", "datasets/v3/nested/", "");
    s3.put("data", "datasets/v3/c.txt", "c");
    s3.put("data", "datasets/v30/other.txt", "not under the prefix");
    s3.put("data", "elsewhere.txt", "not under the prefix");
    const path = join(scratch, "mnt", "data");
    const manifest = await copy(s3Volume());

    expect(await readFile(join(path, "a.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(await readFile(join(path, "nested", "b.json"), "utf8")).toBe('{"ok":true}');
    await expect(lstat(join(path, "other.txt"))).rejects.toThrow();
    for (const entry of [path, join(path, "a.csv"), join(path, "nested"), join(path, "c.txt")])
      expect((await stat(entry)).mode & 0o222).toBe(0);
    expect(manifest).toMatchObject({
      volume: "datasets",
      source: s3Volume().source,
      path,
      strategy: "copy",
      access: "read-only",
      objectCount: 3,
      totalBytes: 8 + 11 + 1,
    });
    expect(manifest.objects.map((object) => object.key)).toEqual([
      "a.csv",
      "c.txt",
      "nested/b.json",
    ]);
    expect(manifest.objects.every((object) => /^"[a-f0-9]{32}"$/u.test(object.etag ?? ""))).toBe(
      true,
    );
    expect(manifest.digest).toBe(mountManifestDigest(manifest.source, manifest.objects));
    expect(parseMountManifests([manifest])).toEqual([manifest]);
    // Listing pages of two, then exactly one download per object, each signed with the key.
    expect(s3.listings.length).toBeGreaterThan(1);
    expect(s3.downloads.map((request) => request.key).toSorted()).toEqual([
      "datasets/v3/a.csv",
      "datasets/v3/c.txt",
      "datasets/v3/nested/b.json",
    ]);
    expect(s3.requests.every((request) => request.accessKeyId === ACCESS_KEY)).toBe(true);
    expect(
      s3.requests.every((request) =>
        String(request.headers["authorization"]).includes("/eu-west-2/s3/aws4_request"),
      ),
    ).toBe(true);
    expect(s3.downloads.every((request) => request.headers["if-match"] !== undefined)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("records S3 content digests and leaves read-write copies writable", async () => {
    s3.put("data", "datasets/v3/data.txt", "before");
    const path = join(scratch, "mnt", "writable");
    const manifest = await copy(s3Volume(), { ...mountAt(path), access: "read-write" });
    expect(manifest.access).toBe("read-write");
    expect(manifest.objects).toMatchObject([
      {
        key: "data.txt",
        sha256: `sha256:${createHash("sha256").update("before").digest("hex")}`,
      },
    ]);
    await writeFile(join(path, "data.txt"), "after");
    expect(await readFile(join(path, "data.txt"), "utf8")).toBe("after");
  });

  it.each(["s3", "r2"])(
    "copies %s using URL settings and only host-mapped credential values",
    async (scheme) => {
      s3.put("data", "datasets/v3/a.txt", "from the host");
      const source = `${scheme}://data/datasets/v3?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`;
      const spec = { source, credential: "data-key" };
      const resolver = hostVolumeResolver({
        protectedDirectories: [],
        readCredential: async () =>
          JSON.stringify({
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET,
            sessionToken: "session-canary",
          }),
      });
      const volume = await resolver.resolve("datasets", {
        taskId: "t",
        attemptId: "a",
        volumes: [{ name: "datasets", ...spec }],
      });
      const manifest = await copy(volume);
      expect(await readFile(join(scratch, "mnt", "data", "a.txt"), "utf8")).toBe("from the host");
      const region = scheme === "r2" ? "auto" : "us-east-1";
      expect(
        s3.requests.every((request) =>
          String(request.headers["authorization"]).includes(`/${region}/s3/aws4_request`),
        ),
      ).toBe(true);
      expect(
        s3.requests.every(
          (request) => request.headers["x-amz-security-token"] === "session-canary",
        ),
      ).toBe(true);
      const output = describeVolume({
        apiVersion: "supertag/v1",
        kind: "Volume",
        metadata: { name: "datasets" },
        spec,
      });
      expect(output).toContain(`Endpoint: ${s3.endpoint}`);
      expect(output).toContain(`Region: ${region}`);
      for (const value of [SECRET, ACCESS_KEY, "session-canary"])
        expect(`${JSON.stringify(manifest)}${output}`).not.toContain(value);
    },
  );

  it("streams S3 and file objects in bounded chunks with a digest", async () => {
    const content = "x".repeat(300_000);
    s3.put("data", "datasets/v3/large.bin", content);
    const fileRoot = join(scratch, "source");
    await mkdir(fileRoot);
    await writeFile(join(fileRoot, "large.bin"), content);
    for (const volume of [
      s3Volume(),
      { volume: "datasets", source: pathToFileURL(fileRoot).href },
    ]) {
      let largest = 0;
      let total = 0;
      const manifest = await copyWorkspaceMount({
        budget,
        mount: mountAt(
          join(scratch, `stream-${total}-${volume.source.startsWith("s3") ? "s3" : "file"}`),
        ),
        volume,
        target: {
          async create() {},
          async mkdir() {},
          async seal() {},
          async write(_path, chunks) {
            for await (const chunk of chunks) {
              largest = Math.max(largest, chunk.byteLength);
              total += chunk.byteLength;
            }
          },
        },
      });
      expect(total).toBe(content.length);
      expect(largest).toBeLessThanOrEqual(64 * 1024);
      if (volume.source.startsWith("file:"))
        expect(manifest.objects[0]?.sha256).toBe(
          `sha256:${createHash("sha256").update(content).digest("hex")}`,
        );
    }
  });

  it("caps explicit maxBytes before listing or downloading", async () => {
    await expect(
      copy(s3Volume(), mountAt(join(scratch, "over-cap"), 20 * 1024 ** 3 + 1)),
    ).rejects.toThrow(/maxBytes must be at most/u);
    expect(s3.listings).toHaveLength(0);
    expect(s3.downloads).toHaveLength(0);
  });

  it("refuses a Volume over maxBytes before downloading anything", async () => {
    s3.pageSize = 1;
    s3.put("data", "datasets/v3/a.bin", "x".repeat(600));
    s3.put("data", "datasets/v3/b.bin", "x".repeat(600));
    s3.put("data", "datasets/v3/c.bin", "x".repeat(600));
    const path = join(scratch, "mnt", "data");
    await expect(copy(s3Volume(), mountAt(path, 1000))).rejects.toThrow(
      /Volume datasets .*1000-byte limit.*downloaded nothing/u,
    );
    expect(s3.downloads).toHaveLength(0);
    // The listing stopped at the page that crossed the limit.
    expect(s3.listings).toHaveLength(2);
    await expect(lstat(path)).rejects.toThrow();
  });

  it(`refuses more than ${MAX_MOUNT_OBJECTS} objects with a bounded listing and no download`, async () => {
    for (let index = 0; index <= MAX_MOUNT_OBJECTS + 1500; index += 1)
      s3.put("data", `datasets/v3/${String(index).padStart(6, "0")}`, "");
    await expect(copy(s3Volume())).rejects.toThrow(
      new RegExp(`more than ${MAX_MOUNT_OBJECTS} objects.*downloaded nothing`, "u"),
    );
    expect(s3.downloads).toHaveLength(0);
    expect(s3.listings.length).toBeLessThanOrEqual(Math.ceil((MAX_MOUNT_OBJECTS + 1) / 1000));
  }, 30_000);

  it("counts folder markers toward the object limit before downloading anything", async () => {
    for (let index = 0; index <= MAX_MOUNT_OBJECTS; index += 1)
      s3.put("data", `datasets/v3/${String(index).padStart(6, "0")}/`, "");
    s3.put("data", "datasets/v3/zz.txt", "data");
    await expect(copy(s3Volume())).rejects.toThrow(
      new RegExp(`more than ${MAX_MOUNT_OBJECTS} objects.*downloaded nothing`, "u"),
    );
    expect(s3.downloads).toHaveLength(0);
    await expect(lstat(join(scratch, "mnt", "data"))).rejects.toThrow();
  }, 30_000);

  it("stops a listing of endless empty truncated pages", async () => {
    s3.put("data", "datasets/v3/a.csv", "a");
    s3.endlessEmptyPages = true;
    await expect(copy(s3Volume())).rejects.toThrow(
      new RegExp(`more than ${MAX_MOUNT_OBJECTS} objects.*downloaded nothing`, "u"),
    );
    expect(s3.listings.length).toBe(Math.ceil(MAX_MOUNT_OBJECTS / 1000) + 1);
    expect(s3.downloads).toHaveLength(0);
  }, 30_000);

  it.each([
    ["datasets/v3/../escape.txt", /would escape/u],
    ["datasets/v3//absolute.txt", /would escape|absolute/u],
    ["datasets/v3/a/./b.txt", /would escape/u],
    ["datasets/v3/back\\slash.txt", /backslash/u],
    ["datasets/v3/control\u0007.txt", /control character/u],
  ])("refuses the escaping or invalid key %j before downloading", async (key, reason) => {
    s3.put("data", "datasets/v3/fine.txt", "fine");
    s3.put("data", key, "payload");
    await expect(copy(s3Volume())).rejects.toThrow(reason);
    expect(s3.downloads).toHaveLength(0);
    await expect(lstat(join(scratch, "mnt", "data"))).rejects.toThrow();
  });

  it("refuses a key that is both a file and a directory", async () => {
    s3.put("data", "datasets/v3/a", "file");
    s3.put("data", "datasets/v3/a/b", "nested");
    await expect(copy(s3Volume())).rejects.toThrow(/both a file and a directory/u);
    expect(s3.downloads).toHaveLength(0);
  });

  it("refuses an object that changed between listing and download", async () => {
    s3.put("data", "datasets/v3/a.csv", "first");
    s3.beforeGet = (bucket, key) => s3.put(bucket, key, "second version");
    await expect(copy(s3Volume())).rejects.toThrow(/changed while it was copied/u);
  });

  it("keeps the credential out of errors, even when the store echoes it", async () => {
    s3.put("data", "datasets/v3/a.csv", "a");
    s3.listError = `denied for ${ACCESS_KEY} with ${SECRET}`;
    const failure = await copy(s3Volume()).then(
      () => "copied",
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(/Volume datasets could not be listed/u);
    expect(failure).not.toContain(SECRET);
    expect(failure).not.toContain(ACCESS_KEY);
  });

  it("refuses object stores without a credential, and r2 without an endpoint", async () => {
    await expect(copy({ volume: "datasets", source: "s3://data/datasets" })).rejects.toThrow(
      /no credential for Volume datasets/u,
    );
    await expect(
      copy({
        volume: "datasets",
        source: "r2://data/datasets",
        credentials: async () => ({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET }),
      }),
    ).rejects.toThrow(/r2:\/\/ sources need an account endpoint/u);
    expect(s3.requests).toHaveLength(0);
  });

  it("refuses a mount without a Volume resolver, naming the Volume", async () => {
    await expect(
      copyWorkspaceMounts({
        mounts: [mountAt(join(scratch, "mnt", "data"))],
        volumes: undefined,
        task: { taskId: "t", attemptId: "a" },
        target: copyTarget(),
      }),
    ).rejects.toThrow(/cannot copy Volume datasets/u);
  });

  it("copies a file:// directory without following or recreating symbolic links", async () => {
    const source = join(scratch, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "a.txt"), "alpha");
    await writeFile(join(source, "nested", "b.txt"), "beta");
    await writeFile(join(scratch, "outside.txt"), SECRET);
    await symlink(join(scratch, "outside.txt"), join(source, "link.txt"));
    await symlink(scratch, join(source, "linked-directory"));
    const path = join(scratch, "mnt", "data");
    const manifest = await copy(
      { volume: "datasets", source: pathToFileURL(source).href },
      mountAt(path),
    );
    expect(manifest.objects.map((object) => object.key)).toEqual(["a.txt", "nested/b.txt"]);
    expect(manifest.objects[0]?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(lstat(join(path, "link.txt"))).rejects.toThrow();
    await expect(lstat(join(path, "linked-directory"))).rejects.toThrow();
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("alpha");
    // A private copy: changing the source afterwards changes nothing in it.
    await writeFile(join(source, "a.txt"), "changed");
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("alpha");
    expect((await stat(join(path, "a.txt"))).ino).not.toBe((await stat(join(source, "a.txt"))).ino);
  });

  it("refuses a file:// Volume over maxBytes before copying", async () => {
    const source = join(scratch, "source");
    await mkdir(source);
    await writeFile(join(source, "big.bin"), "x".repeat(100));
    const path = join(scratch, "mnt", "data");
    await expect(
      copy({ volume: "datasets", source: pathToFileURL(source).href }, mountAt(path, 10)),
    ).rejects.toThrow(/10-byte limit/u);
    await expect(lstat(path)).rejects.toThrow();
  });

  it("refuses an existing mount path and one that resolves into a forbidden directory", async () => {
    const source = join(scratch, "source");
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "alpha");
    const volume = { volume: "datasets", source: pathToFileURL(source).href };
    const existing = join(scratch, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "mine");
    await expect(copy(volume, mountAt(existing))).rejects.toThrow(/already exists/u);
    expect(await readFile(join(existing, "keep.txt"), "utf8")).toBe("mine");
    const checkout = join(scratch, "checkout");
    await mkdir(checkout);
    await symlink(checkout, join(scratch, "via-link"));
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(join(scratch, "via-link", "data")),
        volume,
        target: copyTarget([checkout]),
      }),
    ).rejects.toThrow(/resolves into/u);
    await expect(lstat(join(checkout, "data"))).rejects.toThrow();
  });

  describe("file:// sources and protected host paths", () => {
    const fileVolume = (source: string) => ({
      resolve: async (volume: string) => ({ volume, source: pathToFileURL(source).href }),
    });
    const copyFrom = (source: string, protectedDirectories: readonly string[]) =>
      copyWorkspaceMounts({
        mounts: [mountAt(join(scratch, "mnt", "data"))],
        volumes: { ...fileVolume(source), protectedDirectories },
        task: { taskId: "t", attemptId: "a" },
        target: copyTarget(),
      });

    it("refuses a source that is, is inside, or contains protected state after resolving links", async () => {
      const state = join(scratch, "state");
      await mkdir(join(state, "workspaces"), { recursive: true });
      await writeFile(join(state, "supertag.db"), SECRET);
      await symlink(state, join(scratch, "state-link"));
      // The source is a link to the state directory.
      await expect(copyFrom(join(scratch, "state-link"), [state])).rejects.toThrow(
        /Volume datasets source directory .* overlaps .*SuperTag copied nothing/u,
      );
      // The source is below the state directory, which is named through a link.
      await expect(
        copyFrom(join(state, "workspaces"), [join(scratch, "state-link")]),
      ).rejects.toThrow(/overlaps/u);
      // The source contains the state directory.
      await expect(copyFrom(scratch, [state])).rejects.toThrow(/overlaps/u);
      await expect(lstat(join(scratch, "mnt", "data"))).rejects.toThrow();
    });

    it("compares a protected path that does not exist yet by its real parent", async () => {
      const parent = join(scratch, "home");
      await mkdir(parent);
      await writeFile(join(parent, "notes.txt"), "notes");
      await symlink(parent, join(scratch, "home-link"));
      await expect(
        copyFrom(parent, [join(scratch, "home-link", ".supertag-not-created-yet")]),
      ).rejects.toThrow(/overlaps/u);
    });

    it("refuses a source that contains a protected secret file", async () => {
      const secrets = join(scratch, "secrets");
      await mkdir(secrets);
      await writeFile(join(secrets, "volume.json"), SECRET);
      await expect(copyFrom(secrets, [join(secrets, "volume.json")])).rejects.toThrow(/overlaps/u);
      // A sibling directory is fine.
      const data = join(scratch, "data");
      await mkdir(data);
      await writeFile(join(data, "a.txt"), "alpha");
      const [manifest] = await copyFrom(data, [join(secrets, "volume.json")]);
      expect(manifest?.objects.map((object) => object.key)).toEqual(["a.txt"]);
    });

    it("refuses a protected source when Volumes are pinned, before anything is listed", async () => {
      const state = join(scratch, "state");
      await mkdir(state);
      await symlink(state, join(scratch, "state-link"));
      await expect(
        pinWorkspaceVolumes({
          mounts: [mountAt(join(scratch, "mnt", "data"))],
          volumes: { ...fileVolume(join(scratch, "state-link")), protectedDirectories: [state] },
          task: { taskId: "t", attemptId: "a" },
        }),
      ).rejects.toThrow(/Volume datasets source directory .* overlaps/u);
    });
  });

  describe("pinning Volumes before provider calls", () => {
    const mount = () => mountAt(join(scratch, "mnt", "data"));

    it("reads each credential once and serves exactly the pinned Volumes to start", async () => {
      s3.put("data", "datasets/v3/a.csv", "a");
      let reads = 0;
      const pinned = await pinWorkspaceVolumes({
        mounts: [mount()],
        volumes: {
          resolve: async (volume) => ({
            volume,
            source: s3Volume().source,
            credentials: async () => {
              reads += 1;
              return credentials();
            },
          }),
        },
        task: { taskId: "t", attemptId: "a" },
      });
      expect(reads).toBe(1);
      expect(s3.requests).toHaveLength(0);
      const [manifest] = await copyWorkspaceMounts({
        mounts: [mount()],
        volumes: pinned,
        task: { taskId: "t", attemptId: "a" },
        target: copyTarget(),
      });
      expect(manifest?.objectCount).toBe(1);
      expect(reads).toBe(1);
      await expect(
        pinned?.resolve("datasets", { taskId: "t", attemptId: "other" }),
      ).rejects.toThrow(/not resolved for Task Attempt other/u);
      await expect(pinned?.resolve("other", { taskId: "t", attemptId: "a" })).rejects.toThrow(
        /Volume other was not resolved/u,
      );
    });

    it.each([
      [
        "no resolver",
        undefined,
        /This Worker Host resolves no Volumes, so it cannot copy Volume datasets/u,
      ],
      [
        "a resolver that refuses",
        {
          resolve: async () => {
            throw new Error("unmapped");
          },
        },
        /cannot resolve Volume datasets: unmapped/u,
      ],
      [
        "no credential",
        { resolve: async (volume: string) => ({ volume, source: "s3://data/datasets" }) },
        /no credential for Volume datasets/u,
      ],
      [
        "an unreadable credential",
        {
          resolve: async (volume: string) => ({
            volume,
            source: "s3://data/datasets",
            credentials: async () => {
              throw new Error(SECRET);
            },
          }),
        },
        /could not resolve the credential for Volume datasets/u,
      ],
      [
        "an incomplete credential",
        {
          resolve: async (volume: string) => ({
            volume,
            source: "s3://data/datasets",
            credentials: async () => ({ accessKeyId: ACCESS_KEY, secretAccessKey: "" }),
          }),
        },
        /credential for Volume datasets needs an access key and secret/u,
      ],
      [
        "a different Volume",
        { resolve: async () => ({ volume: "other", source: "s3://data/datasets" }) },
        /mount datasets resolved to Volume other/u,
      ],
    ])("refuses %s, naming the Volume and never the secret", async (_, volumes, reason) => {
      const failure = await pinWorkspaceVolumes({
        mounts: [mount()],
        volumes,
        task: { taskId: "t", attemptId: "a" },
      }).then(
        () => "pinned",
        (error: unknown) => String(error),
      );
      expect(failure).toMatch(reason);
      expect(failure).not.toContain(SECRET);
      expect(s3.requests).toHaveLength(0);
    });
  });

  it("names a key only as a path below the mount", () => {
    expect(mountRelativeKey("v", "a/b.txt")).toBe("a/b.txt");
    for (const key of ["", "/a", "a/../b", "..", "a//b", "a\\b", `${"x".repeat(256)}`])
      expect(() => mountRelativeKey("v", key)).toThrow(/Volume v object key/u);
  });

  it("validates reported manifests, including their digest", () => {
    const objects = [{ key: "a.csv", size: 3, etag: '"e"' }];
    const manifest: MountManifest = {
      volume: "datasets",
      source: "s3://data/x",
      path: "/mnt/data",
      strategy: "copy",
      access: "read-only",
      objectCount: 1,
      totalBytes: 3,
      digest: mountManifestDigest("s3://data/x", objects),
      copiedAt: "2026-10-04T00:00:00.000Z",
      objects,
    };
    expect(parseMountManifests([manifest])).toEqual([manifest]);
    expect(() =>
      parseMountManifests([{ ...manifest, objects: [{ key: "a.csv", size: 4, etag: '"e"' }] }]),
    ).toThrow();
    expect(() =>
      parseMountManifests([{ ...manifest, digest: `sha256:${"0".repeat(64)}` }]),
    ).toThrow(/digest/u);
  });
});
