import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactVolumeCredentialFile,
  HostArtifactVolumeStore,
} from "../apps/cli/src/artifact-volume.js";
import { hostVolumeResolver } from "../apps/cli/src/host-volumes.js";
import {
  hostArtifactVolumeStore,
  runWorkletCommand,
  workletStorageWarnings,
} from "../apps/cli/src/worker.js";
import {
  artifactVolumeKey,
  artifactVolumeLabel,
  normalizeVolumeLocation,
  parseVolumeSource,
  parseWorkerHostLabels,
  type TaskWorkspaceVolume,
  volumeLocationsOverlap,
} from "../packages/core/src/index.js";
import type { VolumeTask } from "../packages/runtime/sdk/src/volume-copy.js";
import { FakeS3 } from "./support/fake-s3.ts";

const ACCESS_KEY = "AKIAARTIFACTVOLUME01";
const SECRET_KEY = "artifact-volume-store-secret-0123456789";
const SECRET = JSON.stringify({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });

const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refOf = (bytes: Uint8Array) => {
  const hex = digestOf(bytes);
  return { uri: `supertag-artifact:sha256:${hex}`, digest: `sha256:${hex}` };
};

describe("Volume locations compared normalized, not as strings", () => {
  const overlap = (a: string, b: string) =>
    volumeLocationsOverlap(parseVolumeSource(a), parseVolumeSource(b));

  it("treats s3:// and r2:// as one scheme and compares endpoint origins", () => {
    expect(overlap("s3://bkt/p", "r2://bkt/p?endpoint=https://s3.us-west-2.amazonaws.com")).toBe(
      true,
    );
    expect(
      overlap("s3://bkt/p?region=eu-west-1", "s3://bkt/p?endpoint=https://s3.amazonaws.com"),
    ).toBe(true);
    expect(
      overlap(
        "r2://bkt/p?endpoint=https://acct.r2.cloudflarestorage.com",
        "s3://bkt/p?endpoint=https://ACCT.r2.cloudflarestorage.com:443/",
      ),
    ).toBe(true);
    expect(
      overlap(
        "s3://bkt/p?endpoint=https://localhost:9000",
        "s3://bkt/p?endpoint=https://127.0.0.1:9000",
      ),
    ).toBe(true);
    expect(
      overlap(
        "s3://bkt/p?endpoint=https://[::1]:9000",
        "s3://bkt/p?endpoint=https://127.9.9.9:9000",
      ),
    ).toBe(true);
    expect(
      overlap(
        "s3://bkt/p?endpoint=https://localhost:9000",
        "s3://bkt/p?endpoint=https://localhost:9001",
      ),
    ).toBe(false);
    expect(overlap("s3://bkt/p", "s3://bkt/p?endpoint=https://acct.r2.cloudflarestorage.com")).toBe(
      false,
    );
    expect(overlap("s3://bkt/p", "s3://cbk/p")).toBe(false);
  });

  it.each(["localhost:9000", "127.0.0.1:9000", "[::1]:9000", "127.9.9.9:9000", "localhost:9001"])(
    "refuses plain-HTTP loopback endpoint %s before comparing locations",
    (endpoint) => {
      expect(() => overlap(`s3://bkt/p?endpoint=http://${endpoint}`, "s3://bkt/p")).toThrow(
        "Volume spec.source endpoint must be an https URL without credentials, a query, a fragment, or control characters (including on loopback)",
      );
    },
  );

  it("compares prefixes and paths by whole segments, decoded, ignoring repeated slashes", () => {
    expect(overlap("s3://bkt/a/b", "s3://bkt/a//b/c/")).toBe(true);
    expect(overlap("s3://bkt/a%2Fb", "s3://bkt/a/b")).toBe(true);
    expect(overlap("s3://bkt/ho%73ts", "s3://bkt/hosts/sha256")).toBe(true);
    expect(overlap("s3://bkt", "s3://bkt/anything")).toBe(true);
    expect(overlap("s3://bkt/a/b", "s3://bkt/a/bc")).toBe(false);
    expect(overlap("file:///srv/Artifacts", "file:///srv/artifacts/x")).toBe(true);
    expect(overlap("file:///srv/a", "file:///srv/ab")).toBe(false);
    expect(overlap("file:///srv/a", "s3://srv/a")).toBe(false);
    expect(normalizeVolumeLocation(parseVolumeSource("s3://bkt/x/"))).toEqual({
      kind: "object-store",
      requestBases: [{ origin: "aws", segments: ["bkt", "x"] }],
    });
  });

  it("derives each artifact's Volume key from its producing Attempt and digest", () => {
    expect(artifactVolumeKey("producer-attempt", `sha256:${"a".repeat(64)}`)).toBe(
      `attempts/producer-attempt/sha256/${"a".repeat(64)}`,
    );
    expect(() => artifactVolumeKey("producer-attempt", "sha256:../../etc")).toThrow(/sha256:HEX/u);
    for (const attemptId of ["", ".", "..", "other/attempt", "a\\b", "a%2fb"])
      expect(() => artifactVolumeKey(attemptId, `sha256:${"a".repeat(64)}`)).toThrow(
        /Task Attempt id/u,
      );
  });

  it("keeps the artifact Volume advertisement out of operator labels", () => {
    expect(artifactVolumeLabel("artifacts")).toMatch(/^artifact-volume:[a-f0-9]{32}$/u);
    expect(() => parseWorkerHostLabels([artifactVolumeLabel("artifacts")])).toThrow(
      /artifact-volume: labels come from host service configuration/u,
    );
  });
});

describe("a Worker Host's artifact copies on its artifact Volume", () => {
  let s3: FakeS3;
  let scratch: string;
  beforeEach(async () => {
    s3 = await FakeS3.start(ACCESS_KEY);
    s3.bucket("team-artifacts");
    scratch = await realpath(await mkdtemp(join(tmpdir(), "supertag-artifact-volume-")));
  });
  afterEach(async () => {
    await s3.close();
    await rm(scratch, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const bucketVolume = (): TaskWorkspaceVolume => ({
    name: "artifacts",
    source: `s3://team-artifacts/team/a?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
    credential: "team",
  });

  it.each([false, true])(
    "keeps unaccepted uploads out of inventory (durable=%s)",
    async (durable) => {
      const options = {
        volume: "artifacts",
        lookup: async () => bucketVolume(),
        readCredential: async () => SECRET,
      };
      const receipts = durable ? join(scratch, "receipts") : undefined;
      const store = new HostArtifactVolumeStore(options, receipts);
      const bytes = Buffer.from("catalog refused this upload");
      const ref = await store.forAttempt("producer-attempt").put({ bytes });
      // A 403/409 (or a crash before publication) must leave nothing to re-advertise.
      expect(await Array.fromAsync(store.inventory())).toEqual([]);
      expect(
        await Array.fromAsync(new HostArtifactVolumeStore(options, receipts).inventory()),
      ).toEqual([]);
      await store.acceptUpload(ref, bytes.length, "producer-attempt");
      expect(Buffer.from(await store.get(ref))).toEqual(bytes);
      expect(await Array.fromAsync(store.inventory())).toEqual([
        { digest: ref.digest, sizeBytes: bytes.length },
      ]);
      if (durable)
        expect(
          await Array.fromAsync(new HostArtifactVolumeStore(options, receipts).inventory()),
        ).toEqual([{ digest: ref.digest, sizeBytes: bytes.length }]);
    },
  );

  it("stores each file as its own object at attempts/ATTEMPT_ID/sha256/HEX beneath the Volume's prefix", async () => {
    const lookups: number[] = [];
    let now = 0;
    const store = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => {
        lookups.push(now);
        return bucketVolume();
      },
      readCredential: async (name) => {
        expect(name).toBe("team");
        return SECRET;
      },
      now: () => now,
    });
    const first = Buffer.from("first artifact");
    const second = Buffer.from("second artifact");
    await store.acceptUpload(
      await store.forAttempt("producer-attempt").put({ bytes: first }),
      first.length,
      "producer-attempt",
    );
    now = 10_000;
    await store.acceptUpload(
      await store.forAttempt("producer-attempt").put({ bytes: second }),
      second.length,
      "producer-attempt",
    );
    expect(
      Buffer.from(
        s3.object("team-artifacts", `team/a/attempts/producer-attempt/sha256/${digestOf(first)}`) ??
          [],
      ),
    ).toEqual(first);
    expect(
      s3.object("team-artifacts", `team/a/attempts/producer-attempt/sha256/${digestOf(second)}`),
    ).toBeDefined();
    expect(Buffer.from(await store.get(refOf(first)))).toEqual(first);
    expect((await Array.fromAsync(store.inventory())).map((entry) => entry.digest).sort()).toEqual(
      [`sha256:${digestOf(first)}`, `sha256:${digestOf(second)}`].sort(),
    );
    expect(await store.source()).toBe(bucketVolume().source);
    // The catalog lookup is reused for 30 seconds, then read again.
    expect(lookups).toEqual([0]);
    now = 40_000;
    await store.get(refOf(first));
    expect(lookups).toEqual([0, 40_000]);
  });

  it.each(["s3", "file"])(
    "separates identical files by producing Attempt on a %s Volume",
    async (kind) => {
      const options = {
        volume: "artifacts",
        lookup: async () =>
          kind === "s3"
            ? bucketVolume()
            : { name: "artifacts", source: pathToFileURL(scratch).href, credential: "nfs" },
        readCredential: async () => (kind === "s3" ? SECRET : { path: scratch }),
      };
      const host = new HostArtifactVolumeStore(options);
      const bytes = Buffer.from("identical output from independent attempts");
      const ref = refOf(bytes);
      await expect(host.put({ bytes })).rejects.toThrow(/require a Task Attempt/);
      await host.acceptUpload(
        await host.forAttempt("first-attempt").put({ bytes }),
        bytes.length,
        "first-attempt",
      );
      await expect(host.forAttempt("second-attempt").get(ref)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await host.acceptUpload(
        await host.forAttempt("second-attempt").put({ bytes }),
        bytes.length,
        "second-attempt",
      );
      for (const attemptId of ["first-attempt", "second-attempt"]) {
        const key = artifactVolumeKey(attemptId, ref.digest);
        const stored =
          kind === "s3"
            ? s3.object("team-artifacts", `team/a/${key}`)
            : await readFile(join(scratch, key));
        expect(Buffer.from(stored ?? [])).toEqual(bytes);
      }
      // Discarding one Attempt's copy cannot erase another Attempt's bytes or receipt.
      await host.forAttempt("first-attempt").discard(ref);
      expect(Buffer.from(await host.forAttempt("second-attempt").get(ref))).toEqual(bytes);
      expect(Buffer.from(await host.get(ref))).toEqual(bytes);
      expect(await Array.fromAsync(host.inventory())).toEqual([
        { digest: ref.digest, sizeBytes: bytes.length },
      ]);
    },
  );

  it("binds receipts to each write and refreshes after refused publication", async () => {
    let current = bucketVolume();
    let lookups = 0;
    const store = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => {
        lookups++;
        return current;
      },
      readCredential: async () => SECRET,
    });
    const bytes = Buffer.from("same content on different sources");
    const first = await store.forAttempt("producer-attempt").put({ bytes });
    const original = current.source;
    current = { ...current, source: current.source.replace("team/a", "team/b") };
    const stale = await store.forAttempt("producer-attempt").put({ bytes });
    expect(store.uploadReceipt(stale)).toEqual({ volume: "artifacts", volumeSource: original });
    // A refused receipt clears the 30s lookup cache; the retry must write to B first.
    store.invalidate();
    const fresh = await store.forAttempt("producer-attempt").put({ bytes });
    expect(lookups).toBe(2);
    expect(store.uploadReceipt(fresh)).toEqual({
      volume: "artifacts",
      volumeSource: current.source,
    });
    expect(store.uploadReceipt(first).volumeSource).toBe(original);
    expect(
      Buffer.from(
        s3.object("team-artifacts", `team/b/attempts/producer-attempt/sha256/${digestOf(bytes)}`) ??
          [],
      ),
    ).toEqual(bytes);

    // Refreshing during a streaming write cannot relabel its receipt with the newer source.
    const streamed = await store.forAttempt("producer-attempt").putStream(
      refOf(bytes),
      (async function* () {
        current = { ...current, source: original };
        store.invalidate();
        await store.source();
        yield bytes;
      })(),
    );
    expect(store.uploadReceipt(streamed).volumeSource).not.toBe(original);
  });

  it.each(["s3", "file"])(
    "inventories only this host's own writes on a shared %s Volume",
    async (kind) => {
      const options = {
        volume: "artifacts",
        lookup: async () =>
          kind === "s3"
            ? bucketVolume()
            : {
                name: "artifacts",
                source: pathToFileURL(scratch).href,
                credential: "nfs",
              },
        readCredential: async () => (kind === "s3" ? SECRET : { path: scratch }),
      };
      const producer = new HostArtifactVolumeStore(options);
      const peer = new HostArtifactVolumeStore(options);
      const own = Buffer.from("producer's upload");
      const other = Buffer.from("peer's upload");
      await producer.acceptUpload(
        await producer.forAttempt("producer-attempt").put({ bytes: own }),
        own.length,
        "producer-attempt",
      );
      const ref = await peer.forAttempt("producer-attempt").put({ bytes: other });
      await peer.acceptUpload(ref, other.length, "producer-attempt");
      // A host-wide read requires its private receipt; the shared listing is not authority.
      await expect(producer.get(ref)).rejects.toMatchObject({ code: "ENOENT" });
      // A streamed download is a fetched copy, not an upload from this host's Task.
      const fetched = Buffer.from("downloaded from a serving peer");
      await producer.forAttempt("producer-attempt").putStream(
        refOf(fetched),
        (async function* () {
          yield fetched;
        })(),
      );
      expect(await Array.fromAsync(producer.inventory())).toEqual([
        { digest: refOf(own).digest, sizeBytes: own.length },
      ]);
      expect(await Array.fromAsync(peer.inventory())).toEqual([
        { digest: ref.digest, sizeBytes: other.length },
      ]);
      await producer.discard(refOf(own));
      expect(await Array.fromAsync(producer.inventory())).toEqual([]);
      // Without local evidence a restarted host must not adopt the shared Volume's contents.
      expect(await Array.fromAsync(new HostArtifactVolumeStore(options).inventory())).toEqual([]);
    },
  );

  it("restores only this host's upload inventory after a process restart", async () => {
    vi.stubEnv("SUPERTAG_STATE_DIR", scratch);
    const forHost = (workerHostId: string) =>
      hostArtifactVolumeStore({
        name: "artifacts",
        token: "host-credential",
        workerHostId,
        hostArtifacts: { getArtifactVolume: async () => bucketVolume() },
        readCredential: async () => SECRET,
      });
    const producer = forHost("producer");
    const peer = forHost("peer");
    const own = Buffer.from("durable upload receipt");
    await producer.acceptUpload(
      await producer.forAttempt("producer-attempt").put({ bytes: own }),
      own.length,
      "producer-attempt",
    );
    await peer.forAttempt("producer-attempt").put({ bytes: Buffer.from("peer upload") });
    const restarted = forHost("producer");
    expect(await Array.fromAsync(restarted.inventory())).toEqual([
      { digest: refOf(own).digest, sizeBytes: own.length },
    ]);
    expect(Buffer.from(await restarted.get(refOf(own)))).toEqual(own);
    const streamed: Uint8Array[] = [];
    for await (const chunk of restarted.stream(refOf(own))) streamed.push(chunk);
    expect(Buffer.concat(streamed)).toEqual(own);
    await restarted.discard(refOf(own));
    expect(await Array.fromAsync(forHost("producer").inventory())).toEqual([]);
  });

  it("names the Volume and never the credential when the Volume cannot be used", async () => {
    s3.echoError = "SignatureDoesNotMatch";
    const store = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => bucketVolume(),
      readCredential: async () => SECRET,
    });
    const failure = await store
      .forAttempt("producer-attempt")
      .put({ bytes: Buffer.from("x") })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const text = `${(failure as Error).message} ${JSON.stringify(failure)} ${String((failure as Error).cause)}`;
    expect(text).toContain("Artifact Volume artifacts request failed");
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(ACCESS_KEY);
    const unmapped = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => bucketVolume(),
      readCredential: async () => {
        throw new Error(`secret ${SECRET_KEY} unreadable`);
      },
    });
    await expect(
      unmapped.forAttempt("producer-attempt").put({ bytes: Buffer.from("x") }),
    ).rejects.toThrow(
      "Artifact Volume artifacts needs a readable mapping for credential team on this Worker Host",
    );
    const unknown = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => {
        throw new Error("HTTP 404");
      },
      readCredential: async () => SECRET,
    });
    await expect(
      unknown.forAttempt("producer-attempt").put({ bytes: Buffer.from("x") }),
    ).rejects.toThrow(/Artifact Volume artifacts could not be read from the catalog/u);
  });

  it("stores copies in a file:// Volume only inside the host's consent directory", async () => {
    const shared = join(scratch, "shared");
    await mkdir(shared);
    const volume = { name: "artifacts", source: pathToFileURL(shared).href, credential: "nfs" };
    const store = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => volume,
      readCredential: async () => ({ path: scratch }),
    });
    const bytes = Buffer.from("on an NFS share");
    await store.forAttempt("producer-attempt").put({ bytes });
    expect(
      await readFile(join(shared, "attempts", "producer-attempt", "sha256", digestOf(bytes))),
    ).toEqual(bytes);
    const outside = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => volume,
      readCredential: async () => ({ path: join(scratch, "elsewhere") }),
    });
    await mkdir(join(scratch, "elsewhere"));
    await expect(outside.forAttempt("producer-attempt").put({ bytes })).rejects.toThrow(
      "Artifact Volume artifacts has a file:// source outside its consent directory",
    );
  });

  it.each(["attempts", "attempts/producer-attempt"])(
    "refuses a symlinked %s before creating anything outside the Volume",
    async (linked) => {
      const shared = join(scratch, "shared");
      const outside = join(scratch, "outside");
      await mkdir(shared);
      await mkdir(outside);
      if (linked.includes("/")) await mkdir(join(shared, "attempts"));
      await symlink(outside, join(shared, linked));
      const store = new HostArtifactVolumeStore({
        volume: "artifacts",
        lookup: async () => ({
          name: "artifacts",
          source: pathToFileURL(shared).href,
          credential: "nfs",
        }),
        readCredential: async () => ({ path: shared }),
      });
      await expect(
        store.forAttempt("producer-attempt").put({ bytes: Buffer.from("private") }),
      ).rejects.toThrow("outside its consent directory");
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("reads --artifact-volume-credential from a file only, without echoing it", async () => {
    expect(() => artifactVolumeCredentialFile(SECRET)).toThrow(
      "--artifact-volume-credential takes file:PATH; the credential is never passed as a value",
    );
    const file = join(scratch, "artifact-volume.json");
    await writeFile(file, `${SECRET}\n`);
    expect(await artifactVolumeCredentialFile(`file:${file}`)()).toBe(SECRET);
    await writeFile(file, JSON.stringify({ path: scratch }));
    expect(await artifactVolumeCredentialFile(`file:${file}`)()).toEqual({ path: scratch });
    await writeFile(file, JSON.stringify({ path: join(scratch, "missing") }));
    await expect(artifactVolumeCredentialFile(`file:${file}`)()).rejects.toThrow(
      /must name an existing directory/u,
    );
    await expect(artifactVolumeCredentialFile(`file:${join(scratch, "none")}`)()).rejects.toThrow(
      /cannot be read/u,
    );
  });

  it("parses --artifact-volume with its credential before connecting", async () => {
    const run = (...args: string[]) =>
      runWorkletCommand(["--worklet-url", "ws://127.0.0.1:9/worklets", ...args]);
    await expect(run("--artifact-volume", "artifacts")).rejects.toThrow(
      "--artifact-volume artifacts requires --artifact-volume-credential file:PATH, the credential its Volume names",
    );
    await expect(run("--artifact-volume-credential", "file:/tmp/x")).rejects.toThrow(
      "--artifact-volume-credential requires --artifact-volume NAME",
    );
    await expect(
      run("--artifact-volume", "Artifacts", "--artifact-volume-credential", "file:/tmp/x"),
    ).rejects.toThrow(/--artifact-volume must be 1-63 lowercase letters/u);
    await expect(
      run("--artifact-volume", "artifacts", "--artifact-volume-credential", SECRET),
    ).rejects.toThrow(/takes file:PATH/u);
  });

  it("drops the only-copy warning for an ephemeral Worklet with an artifact Volume", () => {
    expect(workletStorageWarnings({ ephemeral: true })).toHaveLength(2);
    expect(workletStorageWarnings({ ephemeral: true }, "artifacts")).toEqual([
      "Ephemeral storage: Task files and artifacts on this host are lost if it stops.",
    ]);
  });
});

describe("the Worker Host's mount guard for its artifact Volume", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "supertag-artifact-guard-")));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  const task = (volumes: TaskWorkspaceVolume[]) => ({ volumes }) as unknown as VolumeTask;
  const resolver = (source: () => Promise<string>, readCredential = async () => SECRET) =>
    hostVolumeResolver({
      readCredential: async (name) => (name === "path" ? { path: scratch } : readCredential()),
      protectedDirectories: [],
      artifactVolume: { name: "artifacts", source },
    });

  it("refuses the artifact Volume and object-store Volumes overlapping its location", async () => {
    const guard = resolver(async () => "s3://shared/hosts?region=us-east-1");
    await expect(
      guard.resolve(
        "artifacts",
        task([{ name: "artifacts", source: "s3://shared/hosts", credential: "c" }]),
      ),
    ).rejects.toThrow("Volume artifacts holds artifacts and cannot be mounted");
    await expect(
      guard.resolve(
        "alias",
        task([
          {
            name: "alias",
            source: "r2://shared/hosts/sha256?endpoint=https://s3.amazonaws.com",
            credential: "c",
          },
        ]),
      ),
    ).rejects.toThrow("Volume alias overlaps artifact Volume artifacts and cannot be mounted");
    await expect(
      guard.resolve(
        "sibling",
        task([{ name: "sibling", source: "s3://shared/hosts-data", credential: "c" }]),
      ),
    ).resolves.toMatchObject({ volume: "sibling" });
  });

  it("refuses a file:// Volume whose real path overlaps the artifact Volume's", async () => {
    const artifacts = join(scratch, "artifacts");
    await mkdir(join(artifacts, "sha256"), { recursive: true });
    await symlink(artifacts, join(scratch, "alias"));
    const guard = resolver(async () => pathToFileURL(artifacts).href);
    for (const source of [join(scratch, "alias"), join(scratch, "alias", "sha256"), scratch])
      await expect(
        guard.resolve(
          "datasets",
          task([{ name: "datasets", source: pathToFileURL(source).href, credential: "path" }]),
        ),
      ).rejects.toThrow("Volume datasets overlaps artifact Volume artifacts and cannot be mounted");
    await mkdir(join(scratch, "datasets"));
    await expect(
      guard.resolve(
        "datasets",
        task([
          {
            name: "datasets",
            source: pathToFileURL(join(scratch, "datasets")).href,
            credential: "path",
          },
        ]),
      ),
    ).resolves.toMatchObject({ volume: "datasets" });
  });

  it("refuses every mount when the artifact Volume cannot be read", async () => {
    const guard = resolver(async () => {
      throw new Error("catalog unreachable");
    });
    await expect(
      guard.resolve("data", task([{ name: "data", source: "s3://other/x", credential: "c" }])),
    ).rejects.toThrow(
      "Volume data cannot be checked against artifact Volume artifacts, so it is not mounted",
    );
  });
});
