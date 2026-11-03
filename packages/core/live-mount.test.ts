import { expect, it } from "vitest";
import { parseLiveMounts } from "./src/index.js";

const mount = {
  volume: "datasets",
  source: "s3://datasets/prefix/",
  prefix: "prefix/",
  path: "/mnt/datasets",
  strategy: "mount",
  access: "read-only",
  attachedAt: "2026-10-06T14:00:00.000Z",
};

it("records live source provenance without an object manifest", () => {
  expect(parseLiveMounts([mount])).toEqual([mount]);
  expect(parseLiveMounts([{ ...mount, source: "s3://datasets", prefix: "" }])).toEqual([
    { ...mount, source: "s3://datasets", prefix: "" },
  ]);
});

it.each([
  { attachedAt: "not-a-time" },
  { access: "write-only" },
  { strategy: "copy" },
  { path: "relative" },
  { path: "/mnt/../datasets" },
  { prefix: "different/" },
  { source: "s3://user:password@datasets/prefix/" },
  { source: "s3://datasets/prefix/?token=secret" },
  { credential: "provider-secret" },
  { objects: [] },
  { digest: "sha256:pretend" },
])("refuses malformed or credential-bearing mount evidence: %j", (change) => {
  expect(() => parseLiveMounts([{ ...mount, ...change }])).toThrow();
});

it("bounds live mount records and refuses duplicate paths", () => {
  expect(() => parseLiveMounts([mount, mount])).toThrow(/path/u);
  expect(() => parseLiveMounts(Array.from({ length: 65 }, () => mount))).toThrow(/64/u);
});
