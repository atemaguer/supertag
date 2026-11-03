import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hostVolumeResolver } from "../apps/cli/src/host-volumes.js";
import {
  availableHostVolumeCredentials,
  loadServicesFile,
  readVolumeCredential,
  readVolumeMountCredential,
} from "../apps/cli/src/supertag-yaml.js";
import {
  parseVolumeSource,
  parseVolumeSpec,
  volumeLocationsOverlap,
} from "../packages/core/src/volume.js";

it("requires host consent for Modal Volume sources", () => {
  expect(
    parseVolumeSpec({ source: "modal-volume://Training/data/", credential: "team-data" }),
  ).toEqual({ source: "modal-volume://Training/data/", credential: "team-data" });
  expect(() => parseVolumeSpec({ source: "modal-volume://training/data/" })).toThrow(/credential/);
  expect(parseVolumeSource("modal-volume://Training/data/")).toEqual({
    scheme: "modal-volume",
    name: "Training",
    prefix: "data/",
  });
  expect(parseVolumeSource("gs://datasets/train/")).toEqual({
    scheme: "gs",
    bucket: "datasets",
    prefix: "train/",
  });
  expect(() => parseVolumeSpec({ source: "gs://datasets/train/" })).toThrow(/credential/);
  for (const source of [
    "gs://datasets/?endpoint=https://example.com",
    "modal-volume://training/?environment=prod&environment=other",
    "modal-volume://training/../secret",
    "modal-volume://training/%2e%2e/secret",
  ])
    expect(() => parseVolumeSource(source)).toThrow();
});

it.each(["gs://datasets/data/", "modal-volume://training/data/"])(
  "guards normalized native locations and refuses copy: %s",
  async (source) => {
    const readCredential = vi.fn();
    const task = {
      taskId: "task",
      attemptId: "attempt",
      volumes: [{ name: "data", source, credential: "data" }],
    };
    const guard = hostVolumeResolver({
      readCredential,
      protectedDirectories: [],
      artifactVolume: {
        name: "artifacts",
        source: async () => source.replace("data/", "data//private/"),
      },
    });
    await expect(guard.resolveMount?.("data", task)).rejects.toThrow(/overlaps artifact Volume/);
    expect(readCredential).not.toHaveBeenCalled();
    const resolver = hostVolumeResolver({ readCredential, protectedDirectories: [] });
    await expect(resolver.resolve("data", task)).rejects.toThrow(/mount.only|only.*mount/);
    expect(readCredential).not.toHaveBeenCalled();
    expect(
      volumeLocationsOverlap(
        parseVolumeSource(source),
        parseVolumeSource(source.replace("data/", "data//private/")),
      ),
    ).toBe(true);
  },
);

it("loads provider-held mappings without opening environment or file secrets for native mounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modal-credentials-"));
  try {
    const path = join(directory, "supertag.yaml");
    await writeFile(
      path,
      `services:\n  cloud:\n    type: host\n    control-plane: http://localhost:8080\n    harnesses: [codex]\n    volume-credentials:\n      data: { modal-secret: dataset-access }\n      role: { modal-oidc-role: 'arn:aws:iam::123456789012:role/datasets' }\n      team-data: { modal-volume: Training }\n      local: { file: ./missing-secret }\n      env: { environment: ABSENT_SECRET }\n`,
    );
    const file = await loadServicesFile({ files: [path] });
    const service = file.services.find((s) => s.type === "host");
    if (service === undefined) throw new Error("missing host service");
    expect(readVolumeMountCredential(service, "data")).toEqual({
      "modal-secret": "dataset-access",
    });
    expect(readVolumeMountCredential(service, "role")).toEqual({
      "modal-oidc-role": "arn:aws:iam::123456789012:role/datasets",
    });
    expect(readVolumeMountCredential(service, "team-data")).toEqual({ "modal-volume": "Training" });
    expect(await availableHostVolumeCredentials(file, service, {})).toEqual([
      "data",
      "role",
      "team-data",
    ]);
    await expect(readVolumeCredential(file, service, "team-data")).rejects.toThrow(/copy/);
    for (const name of ["local", "env"])
      expect(() => readVolumeMountCredential(service, name)).toThrow(/provider-held/);
    await expect(readVolumeCredential(file, service, "data")).rejects.toThrow(/copy/);
    const readCredential = vi.fn();
    const resolver = hostVolumeResolver({
      protectedDirectories: [],
      readCredential,
      readMountCredential: async (name) => readVolumeMountCredential(service, name),
    });
    const task = {
      taskId: "task",
      attemptId: "attempt",
      volumes: [{ name: "data", source: "s3://datasets/train/", credential: "data" }],
    };
    expect(await resolver.resolveMount?.("data", task)).toEqual({
      volume: "data",
      source: "s3://datasets/train/",
      nativeCredential: { "modal-secret": "dataset-access" },
    });
    for (const source of [
      "gs://datasets/train/",
      "r2://datasets/train/?endpoint=https%3A%2F%2Facct.r2.cloudflarestorage.com",
    ])
      await expect(
        resolver.resolveMount?.("data", {
          ...task,
          volumes: [{ name: "data", source, credential: "role" }],
        }),
      ).rejects.toThrow(/OIDC.*S3/);
    expect(readCredential).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["?environment=production", "?other=value", "?", "?environment="])(
  "rejects every Modal Volume query: %s",
  (query) => {
    expect(() => parseVolumeSource(`modal-volume://training/data/${query}`)).toThrow(
      /modal-volume.*no query/,
    );
  },
);

it.each([undefined, { "modal-volume": "training" }, { "modal-secret": "Training" }])(
  "refuses missing or mismatched Modal Volume consent: %j",
  async (mapping) => {
    const readCredential = vi.fn();
    const resolver = hostVolumeResolver({
      protectedDirectories: [],
      readCredential,
      readMountCredential: async () => {
        if (!mapping) throw new Error("not mapped");
        return mapping;
      },
    });
    await expect(
      resolver.resolveMount?.("data", {
        taskId: "t",
        attemptId: "a",
        volumes: [
          { name: "data", source: "modal-volume://Training/data/", credential: "team-data" },
        ],
      }),
    ).rejects.toThrow(/Volume data:.*modal-volume/);
    expect(readCredential).not.toHaveBeenCalled();
  },
);
