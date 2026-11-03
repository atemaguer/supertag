import { expect, it, vi } from "vitest";
import { assertHostVolumeMountable } from "../apps/cli/src/host-volumes.js";
import { artifactVolumeGuard } from "../packages/control-plane/src/label-placement.js";
import {
  normalizeVolumeLocation,
  parseVolumeSource,
  volumeLocationsOverlap,
} from "../packages/core/src/index.js";

const gcsAliases = [
  "gs://artifacts/private",
  "s3://artifacts/private?endpoint=https://storage.googleapis.com",
  // Represents the path-style request https://storage.googleapis.com/artifacts/private.
  "s3://private?endpoint=https://storage.googleapis.com/artifacts",
] as const;

const aliases = [
  [gcsAliases[0], gcsAliases[1]],
  [gcsAliases[0], gcsAliases[2]],
  [gcsAliases[1], gcsAliases[2]],
  ...[
    ["artifacts", "commondatastorage.googleapis.com"],
    ["artifacts", "storage.us-central1.rep.googleapis.com"],
    ["artifacts", "storage.europe-west1.rep.googleapis.com"],
    ["zzz", "artifacts.storage.googleapis.com"],
    ["zzz", "artifacts.commondatastorage.googleapis.com"],
    ["zzz", "artifacts.storage.us-central1.rep.googleapis.com"],
    ["zzz", "ARTIFACTS.STORAGE.GOOGLEAPIS.COM."],
    ["zzz", "storage.googleapis.com/artifacts"],
    ["artifacts", "storage.cloud.google.com"],
    ["zzz", "storage.cloud.google.com/artifacts"],
  ].map(([bucket, host]) => [
    `s3://artifacts?endpoint=https://${host?.includes("commondatastorage") ? "storage.googleapis.com" : "commondatastorage.googleapis.com"}`,
    `s3://${bucket}?endpoint=https://${host}`,
  ]),
  ...["0.0.0.0", "[::]", "storage.localhost", "nested.storage.localhost."].map((host) => [
    "s3://artifacts?endpoint=https://localhost:9000",
    `s3://artifacts?endpoint=https://${host}:9000`,
  ]),
  [
    "s3://artifacts?endpoint=https://minio.example.com&forcePathStyle=true",
    "s3://attempts?endpoint=https://minio.example.com/artifacts&forcePathStyle=true",
  ],
  [
    "s3://artifacts?endpoint=https://minio.example.com&forcePathStyle=true",
    "s3://zzz?endpoint=https://artifacts.minio.example.com&forcePathStyle=true",
  ],
  ["s3://artifacts", "s3://zzz?endpoint=https://artifacts.s3.amazonaws.com"],
  ["s3://artifacts", "s3://zzz?endpoint=https://artifacts.s3.eu-west-1.amazonaws.com"],
  ["s3://artifacts", "s3://zzz?endpoint=https://artifacts.s3.dualstack.eu-west-1.amazonaws.com"],
  ["s3://artifacts", "s3://zzz?endpoint=https://artifacts.s3-accelerate.amazonaws.com"],
  ["s3://artifacts", "s3://zzz?endpoint=https://s3.amazonaws.com/artifacts"],
  [
    "s3://artifacts/attempts?endpoint=https://minio.example.com",
    "s3://attempts?endpoint=https://minio.example.com/arti%66acts",
  ],
  [
    "s3://artifacts?endpoint=https://minio.example.com/proxy",
    "s3://zzz?endpoint=https://artifacts.minio.example.com/proxy",
  ],
] as const;

const catalog = (source: string) => ({
  listVolumes: async () => [{ id: "art", name: "artifacts", source }],
  listWorkerHosts: async () => [],
  listVolumeIdsHoldingArtifacts: async () => ["art"],
});

it("exposes a bucket-keyed GCS identity for native source integration", () => {
  expect(
    normalizeVolumeLocation(
      parseVolumeSource("s3://artifacts/private?endpoint=https://storage.googleapis.com"),
    ),
  ).toEqual({
    kind: "object-store",
    requestBases: [
      { origin: "gcs", segments: ["artifacts", "private"] },
      { origin: "gcs", segments: ["artifacts", "private"] },
    ],
  });
});

it.each(aliases)(
  "protects effective object-store request locations: %s / %s",
  async (first, second) => {
    for (const [artifactSource, source] of [
      [first, second],
      [second, first],
    ] as const) {
      expect(
        volumeLocationsOverlap(parseVolumeSource(artifactSource), parseVolumeSource(source)),
      ).toBe(true);
      const guard = await artifactVolumeGuard(catalog(artifactSource));
      expect(guard("data", source)).toMatch(/overlaps artifact Volume artifacts/u);
      const readCredential = vi.fn();
      await expect(
        assertHostVolumeMountable(
          {
            readCredential,
            protectedDirectories: [],
            artifactVolume: { name: "artifacts", source: async () => artifactSource },
          },
          "data",
          { taskId: "t", attemptId: "a", volumes: [{ name: "data", source }] },
        ),
      ).rejects.toThrow(/overlaps artifact Volume artifacts/u);
      expect(readCredential).not.toHaveBeenCalled();
    }
  },
);

it.each([
  [
    "s3://artifacts?endpoint=https://storage.googleapis.com",
    "s3://other?endpoint=https://storage.us-central1.rep.googleapis.com",
  ],
  [
    "s3://artifacts/one?endpoint=https://storage.googleapis.com",
    "s3://two?endpoint=https://artifacts.commondatastorage.googleapis.com",
  ],
  [
    "s3://artifacts?endpoint=https://storage.googleapis.com",
    "s3://artifacts?endpoint=https://storage.googleapis.com.example.org",
  ],
  [
    "s3://artifacts?endpoint=https://minio.example.com",
    "s3://other?endpoint=https://minio.example.com",
  ],
  [
    "s3://artifacts?endpoint=https://minio.example.com",
    "s3://zzz?endpoint=https://artifacts.minio.example.com:9000",
  ],
  [
    "s3://artifacts/one?endpoint=https://minio.example.com",
    "s3://two?endpoint=https://minio.example.com/artifacts",
  ],
  [
    "s3://artifacts/one",
    "s3://two?endpoint=https://artifacts.s3.amazonaws.com&forcePathStyle=true",
  ],
  [
    "s3://artifacts?endpoint=https://minio.example.com",
    "s3://zzz?endpoint=https://artifacts-other.minio.example.com",
  ],
])("keeps separate effective locations mountable: %s / %s", (first, second) => {
  expect(volumeLocationsOverlap(parseVolumeSource(first), parseVolumeSource(second))).toBe(false);
});

it("scopes legacy HTTP artifact holders without granting access to their HTTPS aliases", async () => {
  const guard = await artifactVolumeGuard(catalog("s3://artifacts?endpoint=http://localhost:9000"));
  expect(guard("data", "file:///srv/data")).toBeUndefined();
  expect(guard("data", "s3://data")).toBeUndefined();
  expect(guard("data", "s3://artifacts?endpoint=https://127.0.0.1:9000")).toMatch(
    /overlaps artifact Volume artifacts/u,
  );
  expect(guard("data", "s3://data?endpoint=http://localhost:9000")).toMatch(/invalid source/u);
});

it.each(["s3-accesspoint", "s3-object-lambda", "unknown"])(
  "fails closed for an AWS %s endpoint whose underlying bucket is unknown",
  (service) => {
    expect(
      volumeLocationsOverlap(
        parseVolumeSource("s3://artifacts/private"),
        parseVolumeSource(`s3://data?endpoint=https://alias.${service}.us-east-1.amazonaws.com`),
      ),
    ).toBe(true);
  },
);

it.each([
  "storage.unknown.googleapis.com",
  "artifacts.storage.unknown.googleapis.com",
  "unknown.googleapis.com",
])("fails closed for an unrecognized Google endpoint: %s", async (host) => {
  const artifact = "s3://artifacts/private?endpoint=https://storage.googleapis.com";
  const source = `s3://data?endpoint=https://${host}`;
  expect(volumeLocationsOverlap(parseVolumeSource(artifact), parseVolumeSource(source))).toBe(true);
  expect((await artifactVolumeGuard(catalog(artifact)))("data", source)).toMatch(
    /overlaps artifact Volume artifacts/u,
  );
});

it.each(gcsAliases)("normalizes the GCS artifact request location: %s", (source) => {
  const location = normalizeVolumeLocation(parseVolumeSource(source));
  expect(location.kind).toBe("object-store");
  if (location.kind !== "object-store") throw new Error("Expected an object-store location");
  expect(location.requestBases).toContainEqual({
    origin: "gcs",
    segments: ["artifacts", "private"],
  });
});

it.each([
  "s3://artifacts?endpoint=http://localhost:9000&endpoint=https://elsewhere.example",
  "s3://artifacts?endpoint=http://user:password@localhost:9000",
  "s3://artifacts?endpoint=http://localhost:9000&unknown=setting",
])("does not relax other validations on an HTTP artifact holder: %s", async (source) => {
  const guard = await artifactVolumeGuard(catalog(source));
  expect(guard("data", "s3://data")).toMatch(
    /cannot be checked against artifact Volume artifacts/u,
  );
});
