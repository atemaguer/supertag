import { createHash } from "node:crypto";
import * as real from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  before: undefined as ((path: string) => Promise<void>) | undefined,
  after: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: async (path: string, options?: unknown) => {
      await hook.before?.(String(path));
      const result = await original.mkdir(path, options as never);
      await hook.after?.(String(path));
      return result;
    },
  };
});

const { HostArtifactVolumeStore } = await import("../apps/cli/src/artifact-volume.js");

let scratch: string | undefined;
afterEach(async () => {
  hook.before = undefined;
  hook.after = undefined;
  if (scratch !== undefined) await real.rm(scratch, { recursive: true, force: true });
});

it.each(["put", "putStream"] as const)(
  "%s rejects an attempts swap during mkdir without storing bytes outside the Volume",
  async (operation) => {
    scratch = await real.realpath(await real.mkdtemp(join(tmpdir(), "race-")));
    const shared = join(scratch, "shared");
    const outside = join(scratch, "outside");
    await real.mkdir(shared);
    await real.mkdir(outside);
    // Another writer of the shared Volume swaps `attempts` for a symlink after the ancestor
    // check and restores it before the next check.
    hook.before = async (path) => {
      if (path === join(shared, "attempts", "producer-attempt"))
        await real.symlink(outside, join(shared, "attempts"));
    };
    hook.after = async (path) => {
      if (path.endsWith("/sha256") && path.startsWith(outside)) {
        await real.unlink(join(shared, "attempts"));
        await real.mkdir(join(shared, "attempts"));
      }
    };
    const store = new HostArtifactVolumeStore({
      volume: "artifacts",
      lookup: async () => ({
        name: "artifacts",
        source: pathToFileURL(shared).href,
        credential: "nfs",
      }),
      readCredential: async () => ({ path: shared }),
    });
    let outcome = "rejected";
    try {
      const attempt = store.forAttempt("producer-attempt");
      const bytes = Buffer.from("private");
      if (operation === "put") await attempt.put({ bytes });
      else {
        const digest = createHash("sha256").update(bytes).digest("hex");
        await attempt.putStream(
          { uri: `supertag-artifact:sha256:${digest}`, digest: `sha256:${digest}` },
          (async function* () {
            yield bytes;
          })(),
        );
      }
      outcome = "stored";
    } catch {}
    const leaked = await real
      .readdir(join(outside, "producer-attempt", "sha256"))
      .catch(() => [] as string[]);
    // Expected safe behavior: rejected and nothing written outside the Volume.
    expect({ outcome, leaked }).toEqual({ outcome: "rejected", leaked: [] });
  },
);
