import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automaticWorkerHostLabels,
  effectiveWorkerHostLabels,
  missingWorkerHostLabels,
  parseWorkerHostLabel,
  parseWorkerHostLabels,
  workerHostLabelRequirement,
} from "../packages/core/src/index.js";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

describe("Worker Host labels", () => {
  it("normalizes to lowercase and validates the label alphabet", () => {
    expect(parseWorkerHostLabel(" GPU ")).toBe("gpu");
    expect(parseWorkerHostLabel("harness:claude-code")).toBe("harness:claude-code");
    expect(parseWorkerHostLabel("region.us_east-1")).toBe("region.us_east-1");
    expect(parseWorkerHostLabel("a".repeat(63))).toBe("a".repeat(63));
    for (const invalid of ["", "-gpu", ":gpu", "a".repeat(64), "gpu large", "gpu/1", "gpü", 7])
      expect(() => parseWorkerHostLabel(invalid)).toThrow("a label is 1-63 lowercase letters");
    expect(parseWorkerHostLabels(["gpu", "Linux", "GPU", "arm64"])).toEqual([
      "arm64",
      "gpu",
      "linux",
    ]);
    expect(() => parseWorkerHostLabels("gpu", "runsOn")).toThrow("runsOn must be an array");
    expect(() => parseWorkerHostLabels(["MCP:github"], "Worklet labels")).toThrow(
      "mcp: labels come from host service configuration",
    );
    for (const field of ["Worklet labels", "--label", "Auth Key labels", "Tag runsOn"])
      expect(() => parseWorkerHostLabels(["volume-credential:spoofed"], field)).toThrow(
        "volume-credential: labels come from host service configuration",
      );
    expect(() =>
      parseWorkerHostLabels(Array.from({ length: 65 }, (_, index) => `label-${index}`)),
    ).toThrow("at most 64 labels");
  });

  it("derives automatic labels for the operating system, architecture, harnesses, and checkouts", () => {
    expect(
      automaticWorkerHostLabels({
        platform: "darwin",
        arch: "arm64",
        harnesses: ["claude-code", "codex"],
        workspaces: ["app"],
      }),
    ).toEqual(["arm64", "harness:claude-code", "harness:codex", "macos", "workspace:app"]);
    expect(automaticWorkerHostLabels({ platform: "win32", arch: "x64" })).toEqual([
      "windows",
      "x64",
    ]);
    expect(automaticWorkerHostLabels({ platform: "linux", arch: "x64" })).toEqual(["linux", "x64"]);
  });

  it("rejects reserved MCP labels in SDK Worklets", () => {
    expect(
      () => new LocalWorklet("w", "h", [new StaticWorker()], { labels: ["MCP:github"] }),
    ).toThrow("mcp: labels come from host service configuration");
  });

  it("combines advertised, derived, and key-granted labels, ignoring malformed advertisements", () => {
    expect(
      effectiveWorkerHostLabels(
        {
          id: "old-host",
          labels: ["linux", "GPU", "bad label", 3],
          workspaces: ["app", "/not/a/name"],
          workers: [{ id: "w", profileCapabilities: [{ harness: "codex" }, {}] }],
        },
        ["team:infra"],
      ),
    ).toEqual(["gpu", "harness:codex", "linux", "team:infra", "workspace:app"]);
    expect(effectiveWorkerHostLabels({})).toEqual([]);
  });

  it("names the labels a host lacks in a readable requirement", () => {
    expect(missingWorkerHostLabels(["macos", "gpu", "arm64"], ["arm64", "linux"])).toEqual([
      "macos",
      "gpu",
    ]);
    expect(workerHostLabelRequirement(["macos", "gpu"])).toBe("labels:macos,gpu");
  });
});

function secret() {
  const lookupId = randomBytes(8).toString("hex");
  const value = `stak_${lookupId}${randomBytes(24).toString("hex")}`;
  return { lookupId, secretDigest: createHash("sha256").update(value).digest("hex") };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} label storage`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-label-store-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return store;
    }

    it("stores a Tag's runsOn normalized and sorted", async () => {
      const store = await fixture();
      const tag = await store.createTag({ name: "builder" });
      expect(tag.runsOn).toEqual([]);
      const updated = await store.setTagRunsOn(tag.id, ["MacOS", "gpu", "macos"]);
      expect(updated.runsOn).toEqual(["gpu", "macos"]);
      expect((await store.findTagByName("builder"))?.runsOn).toEqual(["gpu", "macos"]);
      expect((await store.listTags())[0]?.runsOn).toEqual(["gpu", "macos"]);
      await expect(store.setTagRunsOn(tag.id, ["not valid"])).rejects.toThrow("is invalid");
      expect((await store.setTagRunsOn(tag.id, [])).runsOn).toEqual([]);
      await expect(store.setTagRunsOn(randomUUID(), ["gpu"])).rejects.toThrow("does not exist");
    });

    it("grants an Auth Key's labels to hosts that redeem it and unions advertised labels", async () => {
      const store = await fixture();
      const tag = await store.createTag({ name: "builder" });
      const key = secret();
      const created = await store.createAuthKey({
        name: "gpu-pool",
        tagIds: [tag.id],
        labels: ["GPU", "team:infra", "gpu"],
        reusable: true,
        ephemeral: false,
        createdAt: new Date().toISOString(),
        ...key,
      });
      expect(created.labels).toEqual(["gpu", "team:infra"]);
      expect((await store.findAuthKeyByName("gpu-pool"))?.labels).toEqual(["gpu", "team:infra"]);
      await expect(
        store.createAuthKey({
          name: "bad-labels",
          tagIds: [tag.id],
          labels: ["no spaces"],
          reusable: false,
          ephemeral: false,
          createdAt: new Date().toISOString(),
          ...secret(),
        }),
      ).rejects.toThrow("is invalid");

      const redeemed = await store.redeemAuthKey({
        ...key,
        workerHostName: "gpu-1",
        credentialId: `test/credential/${randomUUID()}`,
        redeemedAt: new Date().toISOString(),
      });
      if (redeemed.status !== "redeemed") throw new Error(redeemed.status);
      expect(redeemed.workerHost.grantedLabels).toEqual(["gpu", "team:infra"]);
      expect(redeemed.workerHost.labels).toEqual(["gpu", "team:infra"]);

      const claimed = await store.claimWorkerHostConnection({
        workerHostId: "gpu-1",
        credentialRevision: 1,
        workletId: "worklet",
        protocolVersion: 17,
        workerSnapshot: { id: "gpu-1", labels: ["linux", "x64"], workspaces: ["app"], workers: [] },
        capacity: 1,
        availableSlots: 1,
        activeAttempts: 0,
        ready: true,
        observedAt: new Date().toISOString(),
      });
      expect(claimed?.labels).toEqual(["gpu", "linux", "team:infra", "workspace:app", "x64"]);
      const listed = (await store.listWorkerHosts()).find((host) => host.id === "gpu-1");
      expect(listed?.grantedLabels).toEqual(["gpu", "team:infra"]);
      expect(listed?.labels).toContain("linux");

      // Hosts enrolled without a key carry only what they advertise.
      const plain = await store.enrollWorkerHost({
        id: "plain",
        credentialId: `test/credential/${randomUUID()}`,
        enrolledAt: new Date().toISOString(),
      });
      expect(plain.grantedLabels).toEqual([]);
      expect(plain.labels).toEqual([]);
    });
  });
}
