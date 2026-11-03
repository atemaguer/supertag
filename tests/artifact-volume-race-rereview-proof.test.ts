import { createHash } from "node:crypto";
import * as real from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  mkdir: undefined as
    | ((path: string, create: () => Promise<unknown>) => Promise<unknown>)
    | undefined,
  open: undefined as
    | ((
        path: string,
        create: () => Promise<import("node:fs/promises").FileHandle>,
      ) => Promise<import("node:fs/promises").FileHandle>)
    | undefined,
  link: undefined as
    | ((from: string, to: string, create: () => Promise<void>) => Promise<void>)
    | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: (path: string, options?: unknown) => {
      const create = () => original.mkdir(path, options as never);
      return hook.mkdir ? hook.mkdir(String(path), create) : create();
    },
    open: (path: string, flags: number, mode?: number) => {
      const create = () => original.open(path, flags, mode);
      return hook.open ? hook.open(String(path), create) : create();
    },
    link: (from: string, to: string) => {
      const create = () => original.link(from, to);
      return hook.link ? hook.link(from, to, create) : create();
    },
  };
});
const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { HostArtifactVolumeStore } = await import("../apps/cli/src/artifact-volume.js");
let scratch: string | undefined;
afterEach(async () => {
  hook.mkdir = undefined;
  hook.open = undefined;
  hook.link = undefined;
  if (scratch) await real.rm(scratch, { recursive: true, force: true });
});

async function fixture(operation: "put" | "putStream") {
  scratch = await real.realpath(await real.mkdtemp(join(tmpdir(), "artifact-inode-race-")));
  const shared = join(scratch, "shared");
  const outside = join(scratch, "outside");
  const attempts = join(shared, "attempts");
  const saved = join(shared, "saved-attempts");
  const target = join(attempts, "producer-attempt");
  await real.mkdir(attempts, { recursive: true });
  await real.mkdir(outside);
  const store = new HostArtifactVolumeStore({
    volume: "artifacts",
    lookup: async () => ({
      name: "artifacts",
      source: pathToFileURL(shared).href,
      credential: "nfs",
    }),
    readCredential: async () => ({ path: shared }),
  }).forAttempt("producer-attempt");
  const bytes = Buffer.from("private artifact bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const upload = () =>
    operation === "put"
      ? store.put({ bytes })
      : store.putStream(
          { uri: `supertag-artifact:sha256:${digest}`, digest: `sha256:${digest}` },
          (async function* () {
            yield bytes;
          })(),
        );
  const redirect = async () => {
    await real.rename(attempts, saved);
    await real.symlink(outside, attempts);
  };
  const restore = async () => {
    await real.unlink(attempts);
    await real.rename(saved, attempts);
  };
  return { outside, target, upload, redirect, restore, digest, bytes };
}

// Reconstructs security review artifact 3f07d87c-2263-49b2-904b-f42cf88ae191:
// two mkdir swaps prepare the outside tree, then an open swap leaks the upload there.
it.each(["put", "putStream"] as const)(
  "%s rejects the three-swap proof before writing bytes",
  async (operation) => {
    const f = await fixture(operation);
    for (const path of [f.target, join(f.target, "sha256")]) {
      hook.mkdir = async (candidate, create) => {
        if (candidate !== path) return create();
        await f.redirect();
        try {
          return await create();
        } finally {
          await f.restore();
        }
      };
      await expect(f.upload()).rejects.toThrow();
    }
    hook.mkdir = undefined;
    let opened = false;
    hook.open = async (path, create) => {
      if (!basename(path).startsWith(".upload-")) return create();
      opened = true;
      await f.redirect();
      try {
        return await create();
      } finally {
        await f.restore();
      }
    };
    await expect(f.upload()).rejects.toThrow();
    expect(opened).toBe(true);
    const directory = join(f.outside, "producer-attempt", "sha256");
    const remaining = await real.readdir(directory);
    // macOS cannot resolve a file descriptor to its pathname through Node's fs API.
    // An unlocatable empty upload is allowed; artifact bytes must never reach it.
    for (const name of remaining) expect((await real.stat(join(directory, name))).size).toBe(0);
    if (process.platform === "linux") expect(remaining).toEqual([]);
  },
);

it.each(["put", "putStream"] as const)(
  "%s rejects a different inode at the expected upload path without deleting it",
  async (operation) => {
    const f = await fixture(operation);
    const outside = join(f.outside, "producer-attempt", "sha256");
    await real.mkdir(outside, { recursive: true });
    let replacement = "";
    hook.open = async (path, create) => {
      if (!basename(path).startsWith(".upload-")) return create();
      await f.redirect();
      let file: real.FileHandle;
      try {
        file = await create();
      } finally {
        await f.restore();
      }
      replacement = path;
      await real.writeFile(path, "unrelated file");
      return file;
    };
    await expect(f.upload()).rejects.toThrow();
    expect(await real.readFile(replacement, "utf8")).toBe("unrelated file");
    for (const name of await real.readdir(outside))
      expect((await real.stat(join(outside, name))).size).toBe(0);
  },
);

it.each(["put", "putStream"] as const)(
  "%s rejects a link redirected outside the Volume",
  async (operation) => {
    const f = await fixture(operation);
    const outside = join(f.outside, "producer-attempt", "sha256");
    await real.mkdir(outside, { recursive: true });
    let linked = false;
    hook.link = async (from, _to, create) => {
      await original.link(from, join(outside, basename(from)));
      await f.redirect();
      try {
        await create();
        linked = true;
      } finally {
        await f.restore();
      }
    };
    await expect(f.upload()).rejects.toThrow();
    expect(linked).toBe(true);
    // Rejecting publication cannot find every hard link another Volume writer creates.
    expect(await real.readFile(join(outside, f.digest))).toEqual(f.bytes);
  },
);

it.each(["put", "putStream"] as const)(
  "%s rejects an ancestor still redirected after open and cleans up the empty upload",
  async (operation) => {
    const f = await fixture(operation);
    const outside = join(f.outside, "producer-attempt", "sha256");
    await real.mkdir(outside, { recursive: true });
    let redirected = false;
    hook.open = async (path, create) => {
      if (!basename(path).startsWith(".upload-")) return create();
      await f.redirect();
      redirected = true;
      return create();
    };
    try {
      await expect(f.upload()).rejects.toThrow();
      expect(redirected).toBe(true);
      expect(await real.readdir(outside)).toEqual([]);
    } finally {
      if (redirected) await f.restore();
    }
  },
);

it.each(["put", "putStream"] as const)(
  "%s rejects a replaced publication inode without deleting the replacement",
  async (operation) => {
    const f = await fixture(operation);
    let replacement = "";
    hook.link = async (_from, to, create) => {
      await create();
      await real.rename(to, join(f.outside, "moved-publication"));
      replacement = to;
      await real.writeFile(to, "unrelated published file");
    };
    await expect(f.upload()).rejects.toThrow();
    expect(await real.readFile(replacement, "utf8")).toBe("unrelated published file");
  },
);
