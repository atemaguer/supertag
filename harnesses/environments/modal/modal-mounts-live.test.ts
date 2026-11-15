import { randomUUID } from "node:crypto";
import { parseVolumeSource } from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import { nativeModalSandboxFactory } from "./src/index.js";

// Opt-in only. The operator supplies pre-existing storage; this test creates no data sources.
it.skipIf(process.env["SUPERTAG_MODAL_MOUNTS_LIVE"] !== "1" || Boolean(process.env["CI"]))(
  "reads bucket and Modal Volume fixtures through native read-only mounts",
  async () => {
    const required = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required for the live mount suite`);
      return value;
    };
    const bucket = required("SUPERTAG_MODAL_MOUNTS_BUCKET");
    const secret = required("SUPERTAG_MODAL_MOUNTS_SECRET");
    const volume = required("SUPERTAG_MODAL_MOUNTS_VOLUME");
    const location = parseVolumeSource(volume);
    if (location.scheme !== "modal-volume")
      throw new Error("SUPERTAG_MODAL_MOUNTS_VOLUME must use modal-volume://");
    const sandbox = await nativeModalSandboxFactory.create({
      appName: "supertag-mounts-live",
      createAppIfMissing: true,
      image: "python:3.13-slim",
      params: { timeoutMs: 180_000 },
      nativeMounts: [
        {
          volume: "bucket",
          source: bucket,
          path: "/mnt/bucket",
          nativeCredential: { "modal-secret": secret },
        },
        {
          volume: "volume",
          source: volume,
          path: "/mnt/volume",
          nativeCredential: { "modal-volume": location.name },
        },
      ],
    });
    try {
      const process = await sandbox.exec(
        [
          "python3",
          "-c",
          `
import errno, pathlib
for mount in ["/mnt/bucket", "/mnt/volume"]:
    root = pathlib.Path(mount)
    assert (root / "fixture.txt").read_bytes(), "fixture.txt must contain data"
    target = root / ${JSON.stringify(`.supertag-write-${randomUUID()}`)}
    try:
        with target.open("xb") as out:
            out.write(b"write must fail")
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), str(error)
    else:
        target.unlink()
        raise AssertionError("provider allowed writing to a read-only mount")
print("Both native mounts read fixture.txt and reject writes")
`,
        ],
        { mode: "binary" },
      );
      const [code, stdout, stderr] = await Promise.all([
        process.wait(),
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("Both native mounts read fixture.txt and reject writes");
    } finally {
      await sandbox.terminate({ wait: true });
    }
  },
  240_000,
);

// Opt in with dedicated writable fixtures; remove only the keys this test creates.
it.skipIf(process.env["SUPERTAG_LIVE_MODAL"] !== "1" || Boolean(process.env["CI"]))(
  "writes through read-write bucket and Modal Volume mounts",
  async () => {
    const required = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required for the live write mount suite`);
      return value;
    };
    const bucket = required("SUPERTAG_MODAL_RW_BUCKET");
    const secret = required("SUPERTAG_MODAL_RW_SECRET");
    const volume = required("SUPERTAG_MODAL_RW_VOLUME");
    const location = parseVolumeSource(volume);
    if (location.scheme !== "modal-volume")
      throw new Error("SUPERTAG_MODAL_RW_VOLUME must use modal-volume://");
    const sandbox = await nativeModalSandboxFactory.create({
      appName: "supertag-rw-mounts-live",
      createAppIfMissing: true,
      image: "python:3.13-slim",
      params: { timeoutMs: 180_000 },
      nativeMounts: [
        {
          volume: "bucket",
          source: bucket,
          path: "/mnt/bucket",
          access: "read-write",
          nativeCredential: { "modal-secret": secret },
        },
        {
          volume: "volume",
          source: volume,
          path: "/mnt/volume",
          access: "read-write",
          nativeCredential: { "modal-volume": location.name },
        },
      ],
    });
    try {
      const name = `.supertag-rw-${randomUUID()}`;
      const process = await sandbox.exec(
        [
          "python3",
          "-c",
          `
from pathlib import Path
for root in (Path('/mnt/bucket'), Path('/mnt/volume')):
    target = root / ${JSON.stringify(name)}
    try:
        target.write_text('supertag read-write probe')
        assert target.read_text() == 'supertag read-write probe'
    finally:
        target.unlink(missing_ok=True)
`,
        ],
        { mode: "binary" },
      );
      const [code, stderr] = await Promise.all([
        process.wait(),
        new Response(process.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
    } finally {
      await sandbox.terminate({ wait: true });
    }
  },
  240_000,
);
